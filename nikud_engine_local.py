# -*- coding: utf-8 -*-
"""
נקדן לקריינים — מנוע מקומי עצמאי (STAND-ALONE, ללא Dicta וללא אינטרנט)

Uses the open-source **phonikud** model locally (onnxruntime). phonikud gives:
  • full nikud WITHOUT changing letters
  • kamatz-katan  U+05C7,  vocal shva  U+05BD,  stress  U+05AB  (explicit marks)

Our own layer on top:
  • letter-anchored alignment of the model output back onto the ORIGINAL text
    (the model drops maqaf "־" and may touch punctuation, so separators always
    come from the original — only letters+marks are taken from the model);
  • nikud that already exists in the source (e.g. a book printing אִטית, מוּנבס)
    is respected and overrides the model on those letters;
  • the narrator ("phonetic") transpile, driven by the UI toggles.

Invariant (checked on every word): the letters of the output == the letters of
the input. A word that cannot be aligned is returned un-vocalized, never wrong.
"""
import os
import re
import threading
from collections import OrderedDict

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          'models', 'phonikud-1.0.int8.onnx')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')

# ---- Hebrew constants ----
SHVA='ְ'; CHATAF_SEG='ֱ'; CHATAF_PAT='ֲ'; CHATAF_KAM='ֳ'
HIRIQ='ִ'; TSERE='ֵ'; SEGOL='ֶ'; PATACH='ַ'; KAMATZ='ָ'
HOLAM='ֹ'; HOLAM_HASER='ֺ'; KUBUTZ='ֻ'; DAGESH='ּ'
METEG='ֽ'; RAFE='ֿ'; SHIN_DOT='ׁ'; SIN_DOT='ׂ'; KAMATZ_KATAN='ׇ'
STRESS='֫'; VAV='ו'; YOD='י'
VOCAL_SHVA = METEG                     # phonikud emits U+05BD to mark vocal shva
VOWELS = {CHATAF_SEG, CHATAF_PAT, CHATAF_KAM, HIRIQ, TSERE, SEGOL, PATACH, KAMATZ,
          HOLAM, HOLAM_HASER, KUBUTZ, KAMATZ_KATAN}
BGDKPT_KEEP = {'ב', 'כ', 'פ', 'ך', 'ף'}  # ב כ פ ך ף

# true combining marks only. NOT maqaf (05BE), paseq (05C0), sof-pasuq (05C3), nun-hafukha (05C6)
_MARK_CP = (set(range(0x0591, 0x05BE)) | {0x05BF, 0x05C1, 0x05C2, 0x05C4, 0x05C5, 0x05C7})
def is_letter(c): return 0x05D0 <= ord(c) <= 0x05EA
def is_mark(c):   return ord(c) in _MARK_CP

DEFAULT_OPTS = {
    'unify_vowels': True, 'unify_a': False, 'shva_nach_remove': True, 'shva_na_segol': True,
    'kamatz_katan': True, 'dagesh_bkp_only': True, 'stress_marks': True,
    # False = phonetic (the model marks only shvas that are really pronounced: "dvarim").
    # True  = grammatical: a shva on the first letter of a word is always "na" ("devarim").
    'initial_shva_na': False,
}

# ---- model singleton ----
_model = None
_load_lock = threading.Lock()
_infer_lock = threading.Lock()         # one inference at a time (onnxruntime uses all cores)

def get_model():
    global _model
    if _model is None:
        with _load_lock:
            if _model is None:
                from phonikud_onnx import Phonikud
                _model = Phonikud(MODEL_PATH)
    return _model

def model_ready():
    return _model is not None

def warm():
    try:
        _diacritize("שלום עולם")
        return True
    except Exception:
        return False

_voc_cache = OrderedDict()             # text -> raw model output
_VOC_CACHE_MAX = 400

def _diacritize(text):
    hit = _voc_cache.get(text)
    if hit is not None:
        _voc_cache.move_to_end(text)
        return hit
    with _infer_lock:
        out = get_model().add_diacritics(text)
    _voc_cache[text] = out
    if len(_voc_cache) > _VOC_CACHE_MAX:
        _voc_cache.popitem(last=False)
    return out


# ---- unit helpers ----
def units_of(s):
    u = []
    for c in s:
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
        dag = [m for m in marks if m == DAGESH]
        rest = [m for m in marks if m not in (SHIN_DOT, SIN_DOT, DAGESH)]
        out.extend(dots + dag + rest)
    return ''.join(out)

def bare(s):
    return ''.join(c for c in s if is_letter(c))

def strip_marks(s):
    return ''.join(c for c in s if not is_mark(c))


# ---- tokenization of the ORIGINAL text ----
_WORD = re.compile('[א-ת][א-ת֑-ׇֽֿׁׂׅׄ]*')

def tokenize(text):
    """[(is_word, string)] — a word is Hebrew letters with any marks the source
    already carries; everything else (spaces, punctuation, maqaf, Latin, digits)
    is a separator and is always reproduced verbatim from the original."""
    toks = []
    i = 0
    for m in _WORD.finditer(text):
        if m.start() > i:
            toks.append((False, strip_marks(text[i:m.start()])))
        toks.append((True, m.group()))
        i = m.end()
    if i < len(text):
        toks.append((False, strip_marks(text[i:])))
    return [t for t in toks if t[1] != '']


# ---- alignment: model output -> per-word vocalized forms ----
def align_words(words_bare, voc, with_prefix=False):
    """Letter-anchored walk. For each original word (bare letters) take exactly
    that many Hebrew letters (plus their marks) from the model output, skipping
    anything that is not a Hebrew letter/mark (the model may drop or keep
    punctuation, maqaf, '|' prefix markers...). Returns list of vocalized
    strings ('' when alignment fails for a word)."""
    res = []
    pres = []
    p = 0
    n = len(voc)
    for w in words_bare:
        need = len(w)
        got = 0
        pre = 0
        buf = []
        while p < n and got < need:
            c = voc[p]
            if is_letter(c):
                buf.append(c); got += 1
            elif is_mark(c) and got > 0:
                buf.append(c)
            elif c == '|' and 0 < got < need:
                pre = got                                       # prefix letters end here (ב|, וב|, ה| ...)
            p += 1
        while p < n and (is_mark(voc[p]) or voc[p] == '|'):     # marks of the last letter
            if voc[p] != '|':
                buf.append(voc[p])
            elif got == need:
                pre = need                                      # the whole token is a prefix (שב־, ל־)
            p += 1
        res.append(''.join(buf))
        pres.append(pre)
    if with_prefix:
        return res, pres
    return res


# ---- source nikud wins ----
def apply_source_hints(units, src_units):
    """If the source text already carried nikud on a letter, keep it (the
    publisher's vocalization is authoritative) and drop the model's guess there."""
    for k, (c, smarks) in enumerate(src_units):
        if not smarks or k >= len(units):
            continue
        marks = units[k][1]
        s_vowel = [m for m in smarks if m in VOWELS or m == SHVA]
        s_dots = [m for m in smarks if m in (SHIN_DOT, SIN_DOT)]
        s_dag = DAGESH in smarks
        if s_vowel:
            marks[:] = [m for m in marks if m not in VOWELS and m not in (SHVA, VOCAL_SHVA)]
            marks.extend(s_vowel)
        if s_dots:
            marks[:] = [m for m in marks if m not in (SHIN_DOT, SIN_DOT)] + s_dots
        if s_dag:
            if c == VAV and not s_vowel:                       # shuruk written in the source
                marks[:] = [m for m in marks if m not in VOWELS and m not in (SHVA, VOCAL_SHVA)]
                if k > 0:                                      # previous letter must not carry its own u/o
                    pm = units[k - 1][1]
                    pm[:] = [m for m in pm if m not in (KUBUTZ, HOLAM, HOLAM_HASER, KAMATZ_KATAN)]
            if DAGESH not in marks:
                marks.append(DAGESH)
    return units


def normalize_matres(units):
    """Move a vowel the model placed on a consonant onto a following bare
    mater-vav so it renders as the proper full-spelling vowel:
      kubutz + ו -> shuruk ;  kamatz-katan/holam + ו -> holam-vav."""
    for k in range(len(units) - 1):
        c, marks = units[k]
        nc, nmarks = units[k + 1]
        if nc != VAV or (set(nmarks) & VOWELS) or DAGESH in nmarks or SHVA in nmarks:
            continue
        if KUBUTZ in marks:
            marks.remove(KUBUTZ); nmarks.append(DAGESH)
        elif KAMATZ_KATAN in marks:
            marks.remove(KAMATZ_KATAN); nmarks.append(HOLAM)
        elif HOLAM in marks:
            marks.remove(HOLAM); nmarks.append(HOLAM)
    return units


# ---- views ----
def to_grammatical(units):
    out = []
    for c, marks in units:
        m2 = [m for m in marks if m not in (STRESS, VOCAL_SHVA, RAFE)]
        m2 = [KAMATZ if m == KAMATZ_KATAN else m for m in m2]
        out.append([c, m2])
    return out


def transpile(units, opts):
    o = {**DEFAULT_OPTS, **(opts or {})}
    out = []
    for k, (c, marks) in enumerate(units):
        has_vocal = VOCAL_SHVA in marks or (k == 0 and o['initial_shva_na'])
        new = []
        for m in marks:
            if m in (STRESS, VOCAL_SHVA, RAFE):
                continue
            elif m == SHVA:
                if has_vocal:
                    new.append(SEGOL if o['shva_na_segol'] else SHVA)
                elif not o['shva_nach_remove']:
                    new.append(SHVA)
            elif m == KAMATZ_KATAN:
                new.append(HOLAM if o['kamatz_katan'] else KAMATZ)
            elif m == CHATAF_PAT:
                new.append(PATACH if o['unify_vowels'] else m)
            elif m == CHATAF_SEG:
                new.append(SEGOL if o['unify_vowels'] else m)
            elif m == CHATAF_KAM:
                new.append(HOLAM)
            elif m == TSERE:
                new.append(SEGOL if o['unify_vowels'] else m)
            elif m == HOLAM_HASER:
                new.append(HOLAM)
            elif m == KAMATZ:
                new.append(PATACH if o['unify_a'] else KAMATZ)
            elif m == DAGESH:
                if c == VAV or (not o['dagesh_bkp_only']) or (c in BGDKPT_KEEP):
                    new.append(DAGESH)
            elif m in (SHIN_DOT, SIN_DOT):
                new.append(m)
            elif 0x0591 <= ord(m) <= 0x05AF:
                continue                                         # cantillation
            else:
                new.append(m)
        out.append([c, new])
    return out


def stress_index(units):
    for i, (c, marks) in enumerate(units):
        if STRESS in marks:
            return i
    return -1


# ---- public: process ----
def process(text, opts=None):
    """Returns tokens: {type:'word', orig, full, narrator, stress, risk, alts}
    or {type:'sep', text}. Separators are verbatim from the original text."""
    opts = opts or {}
    toks = tokenize(text)
    word_src = [s for is_w, s in toks if is_w]
    words_bare = [bare(s) for s in word_src]
    clean = strip_marks(text)
    voc = _diacritize(clean) if words_bare else ''
    aligned, pres = align_words(words_bare, voc, with_prefix=True)

    # safety net: any word whose letters do not match is re-run on its own
    for k, (wb, v) in enumerate(zip(words_bare, aligned)):
        if bare(v) != wb:
            solo, spre = align_words([wb], _diacritize(wb), with_prefix=True)
            aligned[k], pres[k] = (solo[0], spre[0]) if bare(solo[0]) == wb else (wb, 0)

    out = []
    wi = 0
    for is_word, s in toks:
        if not is_word:
            out.append({'type': 'sep', 'text': s})
            continue
        wb = words_bare[wi]
        units = units_of(aligned[wi])
        pre = pres[wi]
        wi += 1
        if s != wb:                                              # source carried nikud
            units = apply_source_hints(units, units_of(s))
        units = normalize_matres(units)
        full = render(to_grammatical([[c, list(m)] for c, m in units]))
        narr = render(transpile([[c, list(m)] for c, m in units], opts))
        if bare(full) != wb or bare(narr) != wb:                 # invariant: letters never change
            full = narr = wb
            units = units_of(wb)
            pre = 0
        st = stress_index(units)
        risk = any((KAMATZ_KATAN in m) or (STRESS in m) or (VOCAL_SHVA in m) for _, m in units)
        out.append({'type': 'word', 'orig': wb, 'v': render(units), 'pre': pre,
                    'full': full, 'narrator': narr, 'stress': st, 'alts': [], 'risk': bool(risk)})
    return out


def process_lines(lines, para=None):
    """Vocalize a page given as visual lines (or paragraphs). Lines are joined into
    running text for the model (so it sees whole sentences) and the result is
    handed back line by line. Returns [[token...], ...] with compact tokens:
    {'o': letters, 'v': raw model nikud incl. stress/vocal-shva/kamatz-katan, 'p': prefix letters}
    or {'s': separator text}."""
    para = para or [True] * len(lines)
    flow = ''
    owner = []                                   # for every char of the (mark-stripped) flow: line index or -1
    for i, ln in enumerate(lines):
        t = strip_marks(ln)
        if i > 0:
            joiner = '\n' if para[i] else ('' if flow.endswith('\u05BE') else ' ')
            flow += joiner
            owner.extend([-1] * len(joiner))
        flow += t
        owner.extend([i] * len(t))
    # run the model on the ORIGINAL lines (keeps source nikud hints), joined the same way
    src = ''
    for i, ln in enumerate(lines):
        if i > 0:
            src += '\n' if para[i] else ('' if strip_marks(src).endswith('\u05BE') else ' ')
        src += ln
    toks = process(src, {})
    out = [[] for _ in lines]
    pos = 0
    for t in toks:
        if t['type'] == 'word':
            li = owner[pos] if pos < len(owner) else len(lines) - 1
            out[max(li, 0)].append({'o': t['orig'], 'v': t['v'], 'p': t['pre']})
            pos += len(t['orig'])
        else:
            seg = ''
            cur = None
            for ch in t['text']:
                li = owner[pos] if pos < len(owner) else -1
                pos += 1
                if li != cur:
                    if seg and cur is not None and cur >= 0:
                        out[cur].append({'s': seg})
                    seg = ''
                    cur = li
                if li >= 0:
                    seg += ch
            if seg and cur is not None and cur >= 0:
                out[cur].append({'s': seg})
    return out


# ---- CLI self-test ----
if __name__ == '__main__':
    import sys
    s = ' '.join(sys.argv[1:]) or ("עלייתה ונפילתה של הפסאודו־פרודוקטיביות. אני מאמין שב־ABC וב־NBC "
                                   "עדיין עובדים. קוראַי היקרים, פרודוקטיביות אִטית של מוּנבס (Moonves).")
    toks = process(s, {})
    print("IN :", s)
    print("OUT:", ''.join(t['text'] if t['type'] == 'sep' else t['narrator'] for t in toks))
    print("FUL:", ''.join(t['text'] if t['type'] == 'sep' else t['full'] for t in toks))
    bad = [t for t in toks if t['type'] == 'word' and bare(t['narrator']) != t['orig']]
    print("misaligned:", len(bad))
