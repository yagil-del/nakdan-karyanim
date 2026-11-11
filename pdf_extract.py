# -*- coding: utf-8 -*-
"""
חילוץ טקסט מ-PDF עברי (כולל קבצי דפוס) — "בדיוק כמו בספר".

ב-PDF הטקסט שמור לפי מיקום חזותי. כדי לקבל את סדר הקריאה האמיתי:
  1. קוראים כל תו עם הקואורדינטות שלו (rawdict); סימני ניקוד מוצמדים לאות שלהם.
  2. מקבצים תווים לשורות חזותיות (לפי Y, עם סובלנות לאנגלית/כתב-עילי; אות-פתיח
     גדולה משויכת לשורה הראשונה שהיא חופפת).
  3. בכל שורה: מחרוזת חזותית לפי X  →  אלגוריתם ה-BiDi של יוניקוד  →  סדר לוגי.
     (סוגריים מוחלפים זמנית בתווים ניטרליים כדי שלא "יתהפכו".)
  4. מזהים פסקאות (הזחה / רווח אנכי / שורה קצרה), מסירים כותרת רצה + מספר עמוד,
     שורות-דפוס (slug) וסימוני הערות-שוליים עיליים.
  5. לספר: מספרי עמודים מודפסים, ותוכן עניינים → רשימת פרקים לניווט.
"""
import re
import statistics
import unicodedata
from collections import Counter

import pymupdf
from bidi.algorithm import get_display

_HEB = re.compile(r'[א-ת]')
_FURNITURE = re.compile(r'ind[bd]\b|\.ind[bd]|\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}', re.I)
_MAQAF = '־'

# brackets are swapped for neutral, non-mirroring placeholders during BiDi so the
# algorithm reorders them but never flips their code points.
_BR = '()[]{}<>«»'
_PH = '❶❷❸❹❺❻❼❽❾❿'
_TO_PH = str.maketrans(_BR, _PH)
_FROM_PH = str.maketrans(_PH, _BR)


def _is_combining(ch):
    o = ord(ch)
    if o == 0x05BE or o in (0x05C0, 0x05C3, 0x05C6):
        return False
    if 0x0591 <= o <= 0x05C7:
        return True
    return unicodedata.category(ch) == 'Mn'


def _bidi_line(vis):
    base = 'R' if _HEB.search(vis) else 'L'
    out = get_display(vis.translate(_TO_PH), base_dir=base).translate(_FROM_PH)
    return re.sub(r'[  ]{2,}', ' ', out).strip()


# --------------------------------------------------------------------------- lines
def _page_lines(page):
    """Visual lines of a page, top→bottom: dicts {y, x0, x1, size, text}."""
    rd = page.get_text("rawdict")
    cl = []                                   # [ymid, x0, x1, ch, marks, size, y0, y1, solo]
    size_count = Counter()
    for b in rd.get("blocks", []):
        for l in b.get("lines", []):
            for s in l.get("spans", []):
                size = s.get("size", 10.0)
                chars = s.get("chars", [])
                visible = sum(1 for c in chars if c["c"].strip())
                last = None
                for c in chars:
                    ch = c["c"]
                    if ch == '\t':
                        last = None
                        continue                # leaders: spacing is rebuilt from gaps
                    if ch == ' ':
                        ch = ' '
                    if _is_combining(ch):
                        if last is not None:
                            last[4].append(ch)
                        continue
                    x0, y0, x1, y1 = c["bbox"]
                    item = [(y0 + y1) / 2, x0, x1, ch, [], size, y0, y1, visible <= 2]
                    cl.append(item)
                    last = item
                    if ch.strip():
                        size_count[round(size, 1)] += 1
    if not cl:
        return [], 10.0
    body = size_count.most_common(1)[0][0] if size_count else 10.0

    # drop caps / lone oversized glyphs are attached after normal clustering
    big = [c for c in cl if c[5] >= 1.8 * body and c[8] and c[3].strip()]
    big_ids = {id(c) for c in big}
    normal = sorted((c for c in cl if id(c) not in big_ids), key=lambda c: c[0])

    tol = max(2.0, body * 0.45)
    rows = []
    cur = []
    cy = None
    for c in normal:
        if cy is None or abs(c[0] - cy) <= tol:
            cur.append(c)
            if c[3].strip():
                cy = c[0] if cy is None else (cy * 0.7 + c[0] * 0.3)
            elif cy is None:
                cy = c[0]
        else:
            rows.append(cur)
            cur = [c]
            cy = c[0]
    if cur:
        rows.append(cur)

    def row_y(r):
        ys = [c[0] for c in r if c[3].strip()]
        return statistics.median(ys) if ys else r[0][0]

    cap_until = {}                              # id(row) -> bottom y of its drop cap
    for g in big:                               # attach to the top-most overlapped row
        target = None
        for r in rows:
            if g[6] - 1 <= row_y(r) <= g[7] + 1:
                if target is None or row_y(r) < row_y(target):
                    target = r
        if target is not None:
            cap_until[id(target)] = max(cap_until.get(id(target), 0), g[7])
            target.append(g)
        else:
            rows.append([g])
    rows.sort(key=row_y)

    lines = []
    for r in rows:
        vis_chars = [c for c in r if c[3].strip()]
        if not vis_chars:
            continue
        dom = Counter(round(c[5], 1) for c in vis_chars if id(c) not in big_ids).most_common(1)
        dom = dom[0][0] if dom else body
        # superscript footnote markers: small digits inside a larger-type line
        keep = [c for c in r if not (c[3].isdigit() and c[5] < 0.75 * dom)]
        keep.sort(key=lambda c: c[1])
        parts = []
        prev = None
        for c in keep:
            if prev is not None and c[3] != ' ' and prev[3] != ' ' and (c[1] - prev[2]) > 0.3 * min(c[5], prev[5]):
                parts.append(' ')               # gap without an explicit space glyph
            parts.append(''.join(c[4]) + c[3])  # marks first: BiDi reversal puts them back after the base
            prev = c
        text = _bidi_line(''.join(parts))
        if not text:
            continue
        ink = [c for c in keep if c[3].strip()]
        if not ink:
            continue
        lines.append({'y': row_y(r), 'x0': min(c[1] for c in ink), 'x1': max(c[2] for c in ink),
                      'size': dom, 'text': text, 'cap': cap_until.get(id(r))})
    return lines, body


# ---------------------------------------------------------------------- paragraphs
def _paragraphs(lines, body):
    """Join visual lines into paragraphs (indent / vertical gap / short previous line)."""
    if not lines:
        return []
    main = [l for l in lines if abs(l['size'] - body) < 0.6] or lines
    right = max(l['x1'] for l in main)
    left = min(l['x0'] for l in main)
    width = max(1.0, right - left)
    gaps = [b['y'] - a['y'] for a, b in zip(main, main[1:]) if 0 < b['y'] - a['y'] < 3 * body]
    lead = statistics.median(gaps) if gaps else body * 1.3
    paras = []
    cur = []
    prev = None
    cap_y = None
    for l in lines:
        new = prev is None
        if l.get('cap'):
            cap_y = l['cap']
        beside_cap = cap_y is not None and l['y'] <= cap_y + 1 and not l.get('cap')
        if not new:
            rtl = bool(_HEB.search(l['text']))
            gap = l['y'] - prev['y']
            indent = (right - l['x1']) if rtl else (l['x0'] - left)
            prev_rtl = bool(_HEB.search(prev['text']))
            prev_free = (prev['x0'] - left) if prev_rtl else (right - prev['x1'])
            heading = l['size'] > body * 1.15 and abs(l['size'] - prev['size']) < 0.6
            if heading and gap < 1.7 * l['size']:
                new = False                           # multi-line title
            elif beside_cap:
                new = False                           # body lines running next to a drop cap
            elif gap > 1.35 * lead:
                new = True
            elif abs(l['size'] - prev['size']) > 1.0:
                new = True
            elif l.get('cap'):
                new = True
            elif indent > 0.4 * body and indent < 0.5 * width:
                new = True
            elif prev_free > 0.25 * width:
                new = True
        l['p'] = bool(new)
        if new and cur:
            paras.append(cur)
            cur = []
        cur.append(l)
        prev = l
    if cur:
        paras.append(cur)
    out = []
    for p in paras:
        s = ''
        for l in p:
            t = l['text']
            if not s:
                s = t
            elif s.endswith(_MAQAF):
                s += t
            else:
                s += ' ' + t
        out.append({'text': s, 'y': p[0]['y'], 'size': p[0]['size'], 'gap_after': None,
                    'lines': len(p)})
    return out


# -------------------------------------------------------------------------- pages
def _strip_num(s):
    return re.sub(r'\d+', '', s).strip(' \t-–—|·.')


def _edge_number(s):
    """A page number glued to the start or end of a header line."""
    m = re.match(r'^(\d{1,4})(?!\d)', s) or re.search(r'(?<!\d)(\d{1,4})$', s)
    return int(m.group(1)) if m else None


def _heb_ratio(s):
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if 'א' <= c <= 'ת') / len(letters)


def _analyze(doc):
    """Per-page paragraphs with furniture removed + printed page numbers."""
    raw = []
    for i in range(doc.page_count):
        lines, body = _page_lines(doc[i])
        lines = [l for l in lines
                 if not _FURNITURE.search(l['text']) and l['size'] > 0.55 * body]
        raw.append((lines, body))

    # --- printed page-number offset (physical index - printed number) -----------
    cands = Counter()
    for i, (lines, _) in enumerate(raw, start=1):
        seen = set()
        for l in (lines[:2] + lines[-2:]):
            t = l['text'].strip()
            n = int(t) if re.fullmatch(r'\d{1,4}', t) else None
            if n is None and l is lines[0]:
                n = _edge_number(t)
            if n is not None and n not in seen:
                seen.add(n)
                cands[i - n] += 1
    offset = None
    if cands:
        off, cnt = cands.most_common(1)[0]
        if cnt >= max(3, 0.3 * doc.page_count):
            offset = off

    pages = []
    for i, (lines, body) in enumerate(raw, start=1):
        rect = doc[i - 1].rect
        printed = (i - offset) if (offset is not None and i - offset >= 1) else None
        kept = []
        for k, l in enumerate(lines):
            t = l['text'].strip()
            edge = (k == 0 or k >= len(lines) - 1)
            if re.fullmatch(r'\d{1,4}', t):
                n = int(t)
                if (printed is not None and n == printed) or (printed is None and edge):
                    continue                          # folio
            if k == 0 and printed is not None and len(lines) > 1:
                n = _edge_number(t)
                if n == printed and len(t) < 80:
                    continue                          # running header "title + page number"
            kept.append(l)
        paras = _paragraphs(kept, body)
        text = '\n'.join(p['text'] for p in paras)
        pages.append({'i': i, 'num': str(printed) if printed is not None else None,
                      'text': text, 'words': len(text.split()), 'heb': round(_heb_ratio(text), 2),
                      'w': round(rect.width, 1), 'h': round(rect.height, 1),
                      'lines': [{'x0': round(l['x0'], 1), 'x1': round(l['x1'], 1), 'y': round(l['y'], 1),
                                 's': round(l['size'], 1), 't': l['text'].strip(), 'p': bool(l.get('p'))}
                                for l in kept],
                      '_paras': paras, '_body': body, '_lines': [l['text'].strip() for l in kept]})
    return pages, offset


def _parse_toc(pages, offset):
    """Chapters from the book's own table-of-contents page (title … page number)."""
    for p in pages[:20]:
        paras = p['_paras']
        if not paras:
            continue
        head = paras[0]['text'].strip()
        if not re.match(r'^(תוכן|תוכן העניינים|תוכן עניינים|Contents|Table of Contents)\b', head, re.I):
            continue
        chapters = []
        for line in p['_lines'][1:]:
            line = line.strip()
            m = re.match(r'^(.*?)[\s.·…]*?(\d{1,4})$', line) or re.match(r'^(\d{1,4})[\s.·…]+(.*)$', line)
            if not m:
                continue
            a, b = m.group(1), m.group(2)
            title, num = (a, int(b)) if b.isdigit() else (b, int(a))
            title = re.sub(r'[\s.·…]+$', '', title).strip()
            if not title:
                continue
            phys = num + (offset or 0)
            if 1 <= phys <= len(pages):
                chapters.append({'i': phys, 'title': title[:60]})
        if len(chapters) >= 2:
            p['text'] = '\n'.join(p['_lines'])          # show the TOC line by line
            return chapters, p['i']
    return None, None


def _guess_chapters(pages, first):
    """Fallback when the PDF has no TOC page: short opening headline on a page."""
    cand = []
    for p in pages:
        if p['i'] < first or not p['_paras']:
            continue
        h = p['_paras'][0]
        t = h['text'].strip()
        if 2 <= len(t) <= 48 and h['lines'] <= 2 and h['size'] >= p['_body'] * 1.15:
            cand.append((p['i'], t))
    freq = Counter(t for _, t in cand)
    return [{'i': i, 'title': t} for i, t in cand if freq[t] <= 2]


def extract_pages(pdf_bytes):
    """{count, first_content, pages:[{i,num,text,words,heb}], chapters:[{i,title}], toc_page}"""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        pages, offset = _analyze(doc)
        outline = doc.get_toc() or []
    finally:
        doc.close()
    nonempty = [p['i'] for p in pages if p['words'] > 0]
    rich = [p['i'] for p in pages if p['words'] >= 100]
    # a "book" opens on its first page of running prose; decks/forms open on page one
    first = (rich[0] if rich and len(rich) >= 0.3 * len(nonempty) else (nonempty[0] if nonempty else 1))
    chapters, toc_page = None, None
    if len(outline) >= 2:                              # embedded PDF bookmarks
        chapters = [{'i': pg, 'title': t.strip()[:60]} for lvl, t, pg in outline
                    if 1 <= pg <= len(pages) and lvl <= 2]
    if not chapters:
        chapters, toc_page = _parse_toc(pages, offset)
    if not chapters:
        chapters = _guess_chapters(pages, first)
    if chapters:
        body_starts = [c['i'] for c in chapters if pages[c['i'] - 1]['words'] >= 40]
        if body_starts:
            first = min(body_starts)
    for p in pages:
        p.pop('_paras', None)
        p.pop('_body', None)
        p.pop('_lines', None)
    return {'count': len(pages), 'first_content': first, 'pages': pages,
            'chapters': chapters or [], 'toc_page': toc_page}


def extract(pdf_bytes, first=None, last=None, drop_furniture=True, reorder=True):
    """Flat text of a page range (1-based, inclusive). Returns (text, page_count)."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        n = doc.page_count
        if not reorder:
            a = (first - 1) if first else 0
            b = min(last or n, n)
            return ('\n\n'.join(doc[i].get_text("text").strip() for i in range(a, b)), n)
        pages, _ = _analyze(doc)
    finally:
        doc.close()
    a = (first - 1) if first else 0
    b = min(last or n, n)
    return ('\n\n'.join(p['text'] for p in pages[a:b] if p['text'].strip()), n)


if __name__ == '__main__':
    import sys
    with open(sys.argv[1], 'rb') as f:
        data = f.read()
    r = extract_pages(data)
    print(f"[{r['count']} pages] first_content={r['first_content']} toc_page={r['toc_page']}")
    for c in r['chapters']:
        print(f"   עמ' {c['i']:>3}  {c['title']}")
    for n in [int(x) for x in sys.argv[2:]] or [r['first_content']]:
        p = r['pages'][n - 1]
        print(f"\n===== page {p['i']} (printed {p['num']}, {p['words']} words) =====\n{p['text']}")
