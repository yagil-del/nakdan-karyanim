# -*- coding: utf-8 -*-
"""
מנוע ניקוד מבוסס Nakdan של דיקטה (לגרסה החיה / אונליין).

Same token interface as nikud_engine_local (process / process_lines), but the
vocalization comes from Dicta's Nakdan API instead of the local model:
  • keepqq      -> kamatz katan is returned as U+05C7 (exactly what the UI expects)
  • keepmetagim -> Dicta keeps the original letters (ktiv male) and marks the
                   matres with a meteg; we drop that meteg (the UI uses U+05BD for
                   "vocal shva") and move the vowel onto the mater (תּוֹכְנִית).
  • any word whose letters still differ from the source is re-projected onto
    the source letters, so letters are never changed.
  • vocal shva (U+05BD) and stress (U+05AB) are not provided by Dicta, so they
    are added here with conservative rules (prefix shva = vocal, second of two
    shvas = vocal, sonorant/guttural-initial shva = vocal; segolates and
    past-tense ־תי/־ת/־נו are stressed on the penultimate syllable).
"""
import json
import threading
import urllib.request
from collections import OrderedDict

import nikud_engine_local as L
from nikud_engine import reproject as _reproject

URL = 'https://nakdan-2-0.loadbalancer.dicta.org.il/api'
_cache = OrderedDict(); _CACHE_MAX = 600
_lock = threading.Lock()
SONORANT_OR_GUTTURAL = set('מנלריאעהח')
SUFFIXES = ('תִּי', 'תִי', 'נוּ', 'תָּ', 'תָ', 'תֶּם', 'תֶם', 'תֶּן')


def _call(text, timeout=60):
    body = {"task": "nakdan", "data": text, "genre": "modern", "addmorph": False,
            "keepqq": True, "keepmetagim": True, "matchpartial": True}
    req = urllib.request.Request(URL, data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                                          'Origin': 'https://nakdan.dicta.org.il'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _chunks(text, limit=3500):
    if len(text) <= limit:
        return [text]
    out, cur = [], ''
    for part in text.split('\n'):
        piece = part + '\n'
        if cur and len(cur) + len(piece) > limit:
            out.append(cur); cur = ''
        cur += piece
    if cur:
        out.append(cur)
    out[-1] = out[-1].rstrip('\n') if text and not text.endswith('\n') else out[-1]
    return out


def _prefix_len(voc):
    """letters before the last '|' (Dicta marks prefixes: הַ|יְּלָדִים)"""
    if '|' not in voc:
        return 0
    return sum(1 for c in voc[:voc.rfind('|')] if L.is_letter(c))


def _with_pipe(s, pre):
    if pre <= 0:
        return s
    n = 0
    for k, c in enumerate(s):
        if L.is_letter(c):
            n += 1
            if n == pre + 1:
                return s[:k] + '|' + s[k:]
    return s


def _enrich(voc, pre):
    """add vocal-shva (U+05BD) and stress (U+05AB) marks to one vocalized word"""
    units = L.units_of(voc)
    n = len(units)
    for k, (c, marks) in enumerate(units):
        if L.SHVA not in marks or L.VOCAL_SHVA in marks:
            continue
        vocal = False
        if k < pre:
            vocal = True                                              # בְּ, לְ, וְ, כְּ, מְ, שְׁ
        elif k == 0 and n > 2 and c in SONORANT_OR_GUTTURAL:
            vocal = True                                              # מְדַבְּרִים, נְשָׁמָה
        elif 0 < k < n - 1 and L.SHVA in units[k - 1][1] and L.VOCAL_SHVA not in units[k - 1][1]:
            vocal = True                                              # יִשְׁמְרוּ: second of two
        if vocal:
            marks.append(L.VOCAL_SHVA)
    # stress: penultimate syllable for segolates and 1st/2nd person past tense
    vowel_idx = [k for k, (c, m) in enumerate(units) if set(m) & L.VOWELS]
    rendered = L.render(units)
    stressed = None
    if len(vowel_idx) >= 2:
        last_c, last_m = units[-1]
        pen = vowel_idx[-2]
        if any(rendered.endswith(s) for s in SUFFIXES):
            # vowel before the suffix (skip shva-only letters)
            suf = next(s for s in SUFFIXES if rendered.endswith(s))
            suf_letters = sum(1 for ch in suf if L.is_letter(ch))
            cands = [k for k in vowel_idx if k < n - suf_letters]
            if cands and len(vowel_idx) >= 2:
                stressed = cands[-1]
        elif (L.SEGOL in last_m or (L.PATACH in last_m and last_c in 'חע')) and last_c != 'ה' \
                and vowel_idx[-1] == n - 1 and units[pen][1] and (set(units[pen][1]) & {L.SEGOL, L.TSERE, L.PATACH, L.HIRIQ, L.HOLAM, L.KAMATZ}):
            stressed = pen                                            # שֶׁמֶשׁ סֵפֶר נַעַר
    if stressed is not None:
        units[stressed][1].append(L.STRESS)
    return _with_pipe(L.render(units), pre)


def diacritize(text):
    hit = _cache.get(text)
    if hit is not None:
        _cache.move_to_end(text); return hit
    out = []
    with _lock:
        for chunk in _chunks(text):
            for x in _call(chunk):
                w = x.get('word', '')
                if x.get('sep'):
                    out.append(w); continue
                opts = x.get('options') or []
                voc = opts[0] if opts else w
                if isinstance(voc, list):
                    voc = voc[0]
                voc = voc.replace('ֽ', '')                       # Dicta meteg = mater marker, not vocal shva
                pre = _prefix_len(voc)
                if L.bare(voc) != L.bare(w):                           # letters changed -> re-project onto source
                    voc = L.render(_reproject(w, voc.replace('|', '')))
                    pre = min(pre, len(L.bare(w)) - 1) if pre else 0
                out.append(_enrich(voc, pre))
    res = ''.join(out)
    _cache[text] = res
    if len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)
    return res


# plug into the shared pipeline (alignment, source hints, matres, transpile, lines)
L._diacritize = diacritize
process = L.process
process_lines = L.process_lines
transpile = L.transpile
bare = L.bare
strip_marks = L.strip_marks


def model_ready():
    return True


def warm():
    try:
        diacritize("שלום עולם"); return True
    except Exception:
        return False


if __name__ == '__main__':
    import sys
    s = ' '.join(sys.argv[1:]) or ("כל התוכנית מדברים על אמנות. חוכמה וקרבן. דברים בראשית. "
                                   "שמש אכלתי קמתי. הפסאודו־פרודוקטיביות של מוּנבס (Moonves) שב־ABC.")
    toks = process(s, {})
    print("OUT:", ''.join(t['text'] if t['type'] == 'sep' else t['narrator'] for t in toks))
    print("RAW:", [(t['v'], t['pre']) for t in toks if t['type'] == 'word'][:8])
    print("misaligned:", sum(1 for t in toks if t['type'] == 'word' and bare(t['narrator']) != t['orig']))
