# -*- coding: utf-8 -*-
"""
נקדן לקריינים — מנוע הניקוד
Nikud engine for narrators / voice-over.

Pipeline:
  1) Dicta Nakdan API  -> accurate, context-aware full nikud (ktiv haser).
  2) Re-projection      -> move the nikud onto the ORIGINAL letters so that
                           letters are NEVER changed, only marks are added.
  3) Narrator transpile -> convert the full grammatical nikud into the
                           simplified "phonetic / practical" nikud for readers.

Everything here is deterministic and offline except step 1 (one HTTPS call).
"""

import json
import urllib.request
import urllib.error

# ---- Hebrew Unicode constants -------------------------------------------------
def is_letter(c):  return 0x05D0 <= ord(c) <= 0x05EA
def is_final(c):   return c in "ךםןףץ"
def is_mark(c):    return 0x0591 <= ord(c) <= 0x05C7

SHVA        = 'ְ'   # ְ
CHATAF_SEG  = 'ֱ'   # ֱ
CHATAF_PAT  = 'ֲ'   # ֲ
CHATAF_KAM  = 'ֳ'   # ֳ
HIRIQ       = 'ִ'   # ִ
TSERE       = 'ֵ'   # ֵ
SEGOL       = 'ֶ'   # ֶ
PATACH      = 'ַ'   # ַ
KAMATZ      = 'ָ'   # ָ
HOLAM       = 'ֹ'   # ֹ
HOLAM_HASER = 'ֺ'   # ֺ
KUBUTZ      = 'ֻ'   # ֻ
DAGESH      = 'ּ'   # ּ   (dagesh / shuruk-dot / mapiq)
METEG       = 'ֽ'   # ֽ
SHIN_DOT    = 'ׁ'   # ׁ
SIN_DOT     = 'ׂ'   # ׂ
RAFE        = 'ֿ'

VAV = 'ו'
YOD = 'י'

VOWELS = {CHATAF_SEG, CHATAF_PAT, CHATAF_KAM, HIRIQ, TSERE, SEGOL,
          PATACH, KAMATZ, HOLAM, HOLAM_HASER, KUBUTZ}
BGDKPT_KEEP = {'ב', 'כ', 'פ', 'ך', 'ף'}  # ב כ פ ך ף  (B/V, K/KH, P/F)

DICTA_URL = 'https://nakdan-2-0.loadbalancer.dicta.org.il/api'

# Common words carrying a kamatz-KATAN (O sound) with NO vav mater, where the
# surface form cannot be disambiguated without morphology. For these we let the
# high-precision "closed-syllable kamatz -> holam" rule fire. Extend freely.
KAMATZ_KATAN_LEX = {
    "כל", "בכל", "ככל", "לכל", "מכל", "וכל", "שכל", "ומכל", "ובכל", "מכלם", "כלם",
    "חכמה", "חכמת", "חכמות", "החכמה", "בחכמה",
    "אמנות", "אמנותי", "אמנותית", "האמנות", "לאמנות", "אמנים", "אמן",
    "קרבן", "קרבנות", "הקרבן", "קדקד", "קדשים",
    "אניה", "אניות", "חרבות", "חרבה", "עני", "עניה", "עניים",
    "תכנית", "תכניות", "אזניים", "חפשי",
}


# ---- Dicta call (with a small in-memory cache) --------------------------------
_CACHE = {}
_CACHE_ORDER = []
_CACHE_MAX = 64

def call_dicta(text, genre='modern', timeout=40):
    key = (genre, text)
    if key in _CACHE:
        return _CACHE[key]
    body = {"task": "nakdan", "data": text, "genre": genre, "addmorph": True}
    req = urllib.request.Request(
        DICTA_URL,
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Accept': 'application/json',
                 'Origin': 'https://nakdan.dicta.org.il'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.load(r)
    _CACHE[key] = resp
    _CACHE_ORDER.append(key)
    if len(_CACHE_ORDER) > _CACHE_MAX:
        old = _CACHE_ORDER.pop(0)
        _CACHE.pop(old, None)
    return resp


# ---- unit helpers -------------------------------------------------------------
def units_of(nik):
    """Split a vocalized string into [consonant, [marks...]] units."""
    u = []
    for c in nik:
        if is_letter(c):
            u.append([c, []])
        elif is_mark(c) and u:
            u[-1][1].append(c)
    return u


def render(units):
    out = []
    for c, marks in units:
        out.append(c)
        dots = [m for m in marks if m in (SHIN_DOT, SIN_DOT)]
        dag  = [m for m in marks if m == DAGESH]
        rest = [m for m in marks if m not in (SHIN_DOT, SIN_DOT, DAGESH)]
        out.extend(dots + dag + rest)
    return ''.join(out)


def bare(s):
    return ''.join(c for c in s if is_letter(c))


# ---- step 2: re-projection onto original letters ------------------------------
def reproject(orig, dicta):
    """
    Place Dicta's nikud onto the ORIGINAL letters. Anchored on the original
    consonants, we only ever INSERT marks, so letters never change. Matres
    lectionis (ו/י) that Dicta dropped get the carried vowel (holam / shuruk).
    """
    o = [c for c in orig if is_letter(c)]
    du = units_of(dicta)
    out = []
    i = j = 0
    while i < len(o):
        oc = o[i]
        if j < len(du) and du[j][0] == oc:
            out.append([oc, list(du[j][1])]); i += 1; j += 1
        elif oc in (VAV, YOD):
            prev = out[-1][1] if out else []
            vw = [m for m in prev if m in VOWELS]
            v = vw[0] if vw else None
            if oc == VAV:
                if v in (HOLAM, HOLAM_HASER):
                    if HOLAM in prev: prev.remove(HOLAM)
                    if HOLAM_HASER in prev: prev.remove(HOLAM_HASER)
                    out.append([VAV, [HOLAM]])
                elif v == KAMATZ:                 # kamatz katan written full -> holam-vav
                    prev.remove(KAMATZ); out.append([VAV, [HOLAM]])
                elif v == CHATAF_KAM:
                    prev.remove(CHATAF_KAM); out.append([VAV, [HOLAM]])
                elif v == KUBUTZ:                 # shuruk
                    prev.remove(KUBUTZ); out.append([VAV, [DAGESH]])
                else:
                    out.append([VAV, [HOLAM] if v is None else []])
            else:  # YOD mater (hiriq / tsere male): previous vowel stays, yod stays bare
                out.append([YOD, []])
            i += 1
        else:
            # Dicta inserted an extra consonant (rare) -> skip it, keep original flow
            if j < len(du):
                j += 1
            else:
                out.append([oc, []]); i += 1
    return out  # list of units


# ---- shva na / nach classification -------------------------------------------
def shva_is_na(units, k):
    """
    Simplified classical rules, tuned for MODERN reading:
      - first letter of the word            -> na
      - letter carries dagesh (doubled)     -> na
      - second of two consecutive shvas     -> na
      - otherwise                           -> nach
    """
    c, marks = units[k]
    if SHVA not in marks:
        return None
    if k == 0:
        return True
    if DAGESH in marks and c not in BGDKPT_KEEP:
        return True
    if DAGESH in marks and c in BGDKPT_KEEP:
        # dagesh chazak on bgdkp (doubled) -> vocal shva
        # heuristic: chazak when a vowel precedes
        pv = [m for m in units[k - 1][1] if m in VOWELS]
        if pv:
            return True
    # previous letter has shva (two in a row) -> this one is na
    if k > 0 and SHVA in units[k - 1][1]:
        return True
    return False


# ---- stress (milel) heuristic -------------------------------------------------
def stress_index(units):
    """
    Return the index of the stressed CONSONANT unit, or -1 if default (milra).
    Conservative: only flags well-known milel patterns.
    """
    n = len(units)
    if n < 2:
        return -1
    letters = [u[0] for u in units]
    # segolate nouns: ... Ce-CeC  (two segols on last two vowelled slots) -> milel
    seg_positions = [i for i, u in enumerate(units) if SEGOL in u[1]]
    if len(seg_positions) >= 2 and seg_positions[-1] == n - 1 and seg_positions[-2] == n - 2:
        # e.g. מֶלֶךְ שֶׁמֶשׁ סֵפֶר(tsere+segol)
        return n - 2
    # tsere+segol segolate (סֵפֶר, מֵלֶךְ)
    if n >= 2 and TSERE in units[-2][1] and SEGOL in units[-1][1]:
        return n - 2
    return -1


# ---- step 3: narrator transpile ----------------------------------------------
SILENT_MATER = {VAV, YOD, 'ה', 'א'}  # ו י ה א — don't close a syllable

def _kamatz_closed(units, k):
    """Does the kamatz on unit k sit in a closed syllable? (shva-nach next,
    doubling dagesh next, or a final non-mater consonant)."""
    if k + 1 >= len(units):
        return False
    nxt_c, nxt_marks = units[k + 1]
    if SHVA in nxt_marks and not shva_is_na(units, k + 1):
        return True
    if DAGESH in nxt_marks and nxt_c not in (VAV, YOD):
        return True
    # final bare consonant that actually closes (not a silent mater he/alef)
    if k + 1 == len(units) - 1 and not (set(nxt_marks) & VOWELS) and SHVA not in nxt_marks \
            and nxt_c not in SILENT_MATER:
        return True
    return False


_PREFIXES = ('וה', 'שה', 'מה', 'וב', 'ול', 'וכ', 'ומ', 'וש', 'כש', 'לכ',
             'ו', 'ה', 'ב', 'ל', 'כ', 'מ', 'ש', 'ד')

def _in_katan_lex(word_bare):
    if word_bare in KAMATZ_KATAN_LEX:
        return True
    for p in _PREFIXES:
        if word_bare.startswith(p) and word_bare[len(p):] in KAMATZ_KATAN_LEX:
            return True
    return False


def katan_index(units):
    """Index of the FIRST kamatz in a closed syllable (for lexicon words only).
    We convert only that one, so a stressed final kamatz-gadol (e.g. קָרְבָּן)
    stays A."""
    for k, (c, marks) in enumerate(units):
        if KAMATZ in marks and _kamatz_closed(units, k):
            return k
    return -1


DEFAULT_OPTS = {
    'unify_vowels':      True,   # tsere/chataf-segol -> segol, chataf-patach -> patach
    'unify_a':           False,  # kamatz -> patach (one sign for every A)
    'shva_nach_remove':  True,   # drop silent shva
    'shva_na_segol':     True,   # vocal shva -> segol
    'kamatz_katan':      True,   # kamatz katan -> holam (lexicon-gated)
    'dagesh_bkp_only':   True,   # keep dagesh only on ב כ פ
    'stress_marks':      True,   # compute milel stress (rendered by the UI)
}

def transpile(units, opts):
    """Full grammatical units -> narrator (phonetic) units. Letters unchanged."""
    o = {**DEFAULT_OPTS, **(opts or {})}
    word_bare = ''.join(u[0] for u in units)
    katan_k = katan_index(units) if (o['kamatz_katan'] and _in_katan_lex(word_bare)) else -1
    out = []
    for k in range(len(units)):
        c, marks = units[k]
        new = []
        for m in marks:
            if m in (METEG, RAFE):
                continue
            elif m == SHVA:
                if shva_is_na(units, k):
                    if o['shva_na_segol']:
                        new.append(SEGOL)
                    else:
                        new.append(SHVA)
                else:  # shva nach
                    if not o['shva_nach_remove']:
                        new.append(SHVA)
            elif m == CHATAF_PAT:
                new.append(PATACH if o['unify_vowels'] else m)
            elif m == CHATAF_SEG:
                new.append(SEGOL if o['unify_vowels'] else m)
            elif m == CHATAF_KAM:
                new.append(HOLAM)          # chataf-kamatz is always O
            elif m == TSERE:
                new.append(SEGOL if o['unify_vowels'] else m)
            elif m == HOLAM_HASER:
                new.append(HOLAM)
            elif m == KAMATZ:
                if k == katan_k:
                    new.append(HOLAM)      # kamatz katan -> holam (no vav added)
                else:
                    new.append(PATACH if o['unify_a'] else KAMATZ)
            elif m == DAGESH:
                keep = (c == VAV) or (not o['dagesh_bkp_only']) or (c in BGDKPT_KEEP)
                if keep:
                    new.append(DAGESH)
            elif m in (SHIN_DOT, SIN_DOT):
                new.append(m)             # always keep sin/shin distinction
            else:
                new.append(m)
        out.append([c, new])
    return out


# ---- orchestration ------------------------------------------------------------
def process(text, opts=None):
    """
    Returns a list of tokens:
      {type:'word', orig, full, narrator, stress, alts:[...]}  or
      {type:'sep',  text}
    """
    opts = opts or {}
    genre = opts.get('genre', 'modern')
    resp = call_dicta(text, genre=genre)
    tokens = []
    for x in resp:
        if x.get('sep'):
            tokens.append({'type': 'sep', 'text': x.get('word', '')})
            continue
        orig = x['word']
        options = x.get('options') or []
        dicta = options[0][0] if options else orig
        units = reproject(orig, dicta)
        full = render(units)
        narr = render(transpile(units, opts))
        st = stress_index(units)
        # alternative readings (other Dicta options), re-projected too
        alts = []
        seen = {full}
        for op in options[1:6]:
            cand = op[0]
            rp = render(reproject(orig, cand))
            if rp not in seen:
                seen.add(rp); alts.append(rp)
        # risk: does this word commonly trip a narrator?
        has_katan = _in_katan_lex(''.join(u[0] for u in units)) and katan_index(units) != -1
        has_shva_na = any(SHVA in m and shva_is_na(units, i) for i, (_, m) in enumerate(units))
        risk = bool(has_katan or st != -1 or has_shva_na)
        tokens.append({'type': 'word', 'orig': orig, 'full': full,
                       'narrator': narr, 'stress': st, 'alts': alts,
                       'risk': risk})
    return tokens


# ---- CLI self-test ------------------------------------------------------------
if __name__ == '__main__':
    import sys
    sample = ("התוכנית בשולחן הגדול. דברים רבים נאמרו. מדברים על בראשית. "
              "משטרה ואמנות. שולחן גדול. הקריין הטעים את ההברה המוטעמת בשידור. "
              "לשמור על הסדר. דוגמה טובה. מלחמה ושלום.")
    if len(sys.argv) > 1:
        sample = ' '.join(sys.argv[1:])
    toks = process(sample, {'unify_a': False})
    print("ORIG            FULL(letters kept)   NARRATOR")
    print("-" * 64)
    for t in toks:
        if t['type'] == 'sep':
            continue
        changed = '' if bare(t['full']) == bare(t['orig']) == bare(t['narrator']) else '  !!LETTERS'
        print(f"{t['orig']:14}  {t['full']:18}  {t['narrator']:18}{changed}")
