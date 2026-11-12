// נקדן לקריינים — ממשק. תצוגת מסמך רציפה (כל העמודים בגלילה אחת), 1:1 עם ה-PDF.
import * as N from './nikud_core.js';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ storage */
['nikud-karyanim', 'nikud-book', 'nikud-edits', 'nikud-progress'].forEach(k => { try { localStorage.removeItem(k); } catch {} }); // old versions
const LSK = { state: 'nk2-state', edits: 'nk2-edits', prog: 'nk2-progress', notes: 'nk2-notes', breaths: 'nk2-breaths' };
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('nikud-karyanim', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('kv', mode); const rq = fn(t.objectStore('kv')); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); }); };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => undefined),
    set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => {}),
    del: k => tx('readwrite', s => s.delete(k)).catch(() => {}),
    delPrefix: p => tx('readwrite', s => s.delete(IDBKeyRange.bound(p, p + '￿'))).catch(() => {}),
    entries: async p => {              // [[key, value], ...] for every key that starts with p
      const db = await open();
      return new Promise((res, rej) => {
        const out = [], rq = db.transaction('kv', 'readonly').objectStore('kv').openCursor(IDBKeyRange.bound(p, p + '\uffff'));
        rq.onsuccess = () => { const c = rq.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
        rq.onerror = () => rej(rq.error);
      }).catch(() => []);
    },
  };
})();

/* -------------------------------------------------------------------- state */
const state = {
  tab: 'narr', density: 'medium', opts: { ...N.DEFAULT_OPTS },
  zoomE: 1, zoomR: 1, lh: 195, follow: true, breath: false, crit: true, notes: true, speed: 35, page: 1, input: '', cur: '',
};
let DOC = null;                    // {uid,name,kind:'pdf'|'text',count,first,chapters,pages,ff}
const TOK = new Map();             // page -> [[token,...] per line]
const PENDING = new Set();
let pumping = false, docGen = 0;
let EDITS = lsGet(LSK.edits, {});
const UNDO = [], REDO = [];
let INIT = true, readerOpen = false;

let saveT = null;
function saveState() { if (INIT) return; clearTimeout(saveT); saveT = setTimeout(() => { state.input = $('#inputArea').value; lsSet(LSK.state, state); }, 250); }

/* -------------------------------------------------------------------- utils */
let toastT = null;
function toast(m, ms = 3400) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', ms); }
let busyN = 0;
function showBusy(b) { busyN = Math.max(0, busyN + (b ? 1 : -1)); $('#busy').style.display = busyN ? 'grid' : 'none'; }
const escapeH = s => s.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
const E_MARKS = /[\u05B1\u05B5\u05B6]/g;          // chataf-segol, tsere, segol  (the "e" vowels)
const evOn = mode => mode === 'narr' && !!state.opts.e_as_v;
function wordHTML(str, stressIdx, ev) {      // ev: draw every "e" vowel as a small v under its letter
  const st = stressIdx != null && stressIdx >= 0 && state.opts.stress_marks;
  if (!st && !ev) return escapeH(str);
  let out = '', ui = -1, cur = null;
  const flush = () => {
    if (!cur) return;
    const cls = []; let t = cur.t;
    if (ev && t.search(E_MARKS) >= 0) { t = t.replace(E_MARKS, ''); cls.push('ve'); }
    if (st && cur.u === stressIdx) cls.push('stress');
    out += cls.length ? `<span class="${cls.join(' ')}">${escapeH(t)}</span>` : escapeH(t);
    cur = null;
  };
  for (const c of str) {
    if (N.isLetter(c)) { flush(); cur = { t: c, u: ++ui }; }
    else if (N.isMark(c) && cur) cur.t += c;
    else { flush(); out += escapeH(c); }
  }
  flush();
  return out;
}

/* -------------------------------------------------------------------- edits */
const docKey = () => DOC ? (DOC.kind === 'pdf' ? 'pdf:' + DOC.name : 'text:' + DOC.sig) : 'none';
const editOf = (p, l, i) => (((EDITS[docKey()] || {})[p]) || {})[l + ':' + i] || null;
function writeEdit(p, l, i, e) {
  const d = docKey();
  EDITS[d] = EDITS[d] || {}; EDITS[d][p] = EDITS[d][p] || {};
  if (e) EDITS[d][p][l + ':' + i] = e; else delete EDITS[d][p][l + ':' + i];
  lsSet(LSK.edits, EDITS);
}
function commitEdit(p, l, i, e) {          // with undo
  const prev = editOf(p, l, i);
  UNDO.push({ p, l, i, prev: prev ? { ...prev } : null, next: e ? { ...e } : null }); REDO.length = 0;
  writeEdit(p, l, i, e); refreshPage(p);
}
function undo() { const a = UNDO.pop(); if (!a) return toast('אין מה לבטל'); writeEdit(a.p, a.l, a.i, a.prev); REDO.push(a); refreshPage(a.p); }
function redo() { const a = REDO.pop(); if (!a) return toast('אין מה לבצע שוב'); writeEdit(a.p, a.l, a.i, a.next); UNDO.push(a); refreshPage(a.p); }

/* ------------------------------------------------------- bookmark (progress) */
const getProg = () => DOC ? (lsGet(LSK.prog, {})[docKey()] || null) : null;
function setProg(p, l, i) { const o = lsGet(LSK.prog, {}); o[docKey()] = { page: p, l, i, ts: Date.now() }; lsSet(LSK.prog, o); }

/* ------------------------------------------------ narrator directions (notes) */
const PRESETS = [
  { k: 'emph',  ic: '🔺', t: 'הדגשה',                 c: '#e5484d' },
  { k: 'slow',  ic: '🐢', t: 'להאט',                  c: '#3b82f6' },
  { k: 'fast',  ic: '⚡', t: 'להאיץ',                 c: '#f59e0b' },
  { k: 'pause', ic: '⏸', t: 'הפסקה / נשימה אחרי',    c: '#6b7280' },
  { k: 'soft',  ic: '🤫', t: 'בשקט, ברוך',            c: '#8b5cf6' },
  { k: 'loud',  ic: '📣', t: 'בעוצמה',                c: '#b91c1c' },
  { k: 'up',    ic: '↗',  t: 'אינטונציה עולה (שאלה)', c: '#16a34a' },
  { k: 'down',  ic: '↘',  t: 'ירידה / סגירת משפט',    c: '#0d9488' },
  { k: 'smile', ic: '🙂', t: 'בחיוך, בחום',           c: '#d97706' },
  { k: 'quote', ic: '🎭', t: 'ציטוט / קול אחר',       c: '#db2777' },
  { k: 'note',  ic: '✏️', t: 'הערה חופשית',           c: '#7b61ff' },
];
const preset = k => PRESETS.find(x => x.k === k) || PRESETS[PRESETS.length - 1];
let NOTES = lsGet(LSK.notes, {});
const notesOf = p => ((NOTES[docKey()] || {})[p]) || [];
const inNote = (n, l, i) => (l > n.a.l || (l === n.a.l && i >= n.a.i)) && (l < n.b.l || (l === n.b.l && i <= n.b.i));
const noteLabel = n => { const pr = preset(n.k); return pr.ic + ' ' + (n.x ? (n.k === 'note' ? n.x : pr.t + ' — ' + n.x) : pr.t); };
function putNote(p, n) {                      // add or replace
  const d = docKey(); NOTES[d] = NOTES[d] || {}; const arr = NOTES[d][p] = (NOTES[d][p] || []).filter(x => x.id !== n.id);
  arr.push(n); arr.sort((x, y) => x.a.l - y.a.l || x.a.i - y.a.i); lsSet(LSK.notes, NOTES); refreshPage(p);
}
function dropNote(p, id) { const d = docKey(); if (NOTES[d] && NOTES[d][p]) { NOTES[d][p] = NOTES[d][p].filter(x => x.id !== id); lsSet(LSK.notes, NOTES); refreshPage(p); } }

/* ------------------------------------------------------------- breath marks */
// value per word (the mark is drawn after it): 1 = breath "/", 2 = long breath "//", 0 = hide the automatic suggestion
let BREATHS = lsGet(LSK.breaths, {});
const PUNCT = /[.,;:!?…]/;
const breathOf = (p, l, i) => { const v = ((BREATHS[docKey()] || {})[p] || {})[l + ':' + i]; return v === undefined ? null : v; };
function setBreath(p, l, i, v) {
  const d = docKey(); BREATHS[d] = BREATHS[d] || {}; BREATHS[d][p] = BREATHS[d][p] || {};
  if (v === null) delete BREATHS[d][p][l + ':' + i]; else BREATHS[d][p][l + ':' + i] = v;
  lsSet(LSK.breaths, BREATHS); refreshPage(p);
}
const punctAfter = (p, l, i) => { const lt = (TOK.get(p) || [])[l], nx = lt && lt[i + 1]; return !!(nx && nx.s != null && PUNCT.test(nx.s)); };
function cycleBreath(p, l, i, fromMark) {       // none → / → // → none   (clicking an automatic mark hides it)
  const cur = breathOf(p, l, i), auto = state.breath && punctAfter(p, l, i);
  let next;
  if (cur === 1) next = 2;
  else if (cur === 2) next = auto ? 0 : null;
  else if (cur === null && fromMark) next = 0;
  else next = 1;
  setBreath(p, l, i, next);
  return next;
}
function breathEl(kind, wi) {
  const b = document.createElement('span'); b.className = 'breath ' + (kind === 'auto' ? 'auto' : 'man'); b.dataset.w = wi;
  b.textContent = kind === 'auto' ? '⁞' : (kind === 2 ? '//' : '/');
  b.title = kind === 'auto' ? 'הצעת נשימה (לחיצה מסתירה)' : (kind === 2 ? 'נשימה ארוכה (לחיצה מסירה)' : 'נשימה (לחיצה: ארוכה)');
  return b;
}

/* ------------------------------------------------- what a word looks like */
function display(tok, e, mode) {
  const v = (e && e.v) || tok.v, pre = tok.p || 0;
  if (mode === 'orig') return { s: tok.o, stress: -1, rs: [] };
  if (mode === 'full') return { s: (e && e.f) || N.toFull(v), stress: -1, rs: [] };
  const rs = N.reasons(v, pre);
  if (e && e.n) return { s: e.n, stress: -1, rs };
  if (state.density === 'full' || rs.length || e) return { s: N.toNarr(v, state.opts), stress: N.stressIndex(v), rs };
  return { s: N.partial(v, state.opts, pre, state.density), stress: -1, rs };
}

/* --------------------------------------------------------------------- view */
class View {
  constructor(scroller, root, reader) {
    this.sc = scroller; this.root = root; this.reader = reader;
    this.sheets = []; this.near = new Set(); this.io = null; this.raf = 0;
    scroller.addEventListener('scroll', () => { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; onViewScroll(this); }); }, { passive: true });
    scroller.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoomBy(Math.exp(-e.deltaY * 0.012)); } }, { passive: false });
    let g0 = 1;
    scroller.addEventListener('gesturestart', e => { e.preventDefault(); g0 = state[this.zkey]; });
    scroller.addEventListener('gesturechange', e => { e.preventDefault(); this.setZoom(g0 * e.scale); });
  }
  get zkey() { return this.reader ? 'zoomR' : 'zoomE'; }
  get mode() { return this.reader ? 'narr' : state.tab; }
  pageW() { return DOC.kind === 'pdf' ? Math.max(...DOC.pages.slice(0, 40).map(p => p.w || 500)) : 620; }
  fitZ() {
    const W = this.sc.clientWidth - 48; const pw = this.pageW();
    return Math.max(0.25, Math.min(W / pw, (this.reader ? 1100 : 1400) / pw));
  }
  applyZoom() {
    if (!DOC) return;
    const z = this.fitZ() * state[this.zkey];
    this.z = z;
    this.root.style.setProperty('--z', z.toFixed(4));
    this.root.style.setProperty('--ff', DOC.ff || 1);
    this.root.style.setProperty('--lh', state.lh / 100);
    if (this.reader) $('#reader').style.setProperty('--guide', (z * (DOC.kind === 'pdf' ? 13 : 20) * 2.6).toFixed(0) + 'px');
  }
  keepPos(fn) {
    const p = this.current(), sh = this.sheets[p - 1];
    if (!sh) return fn();
    const anchor = this.sc.scrollTop + this.anchor();
    const f = (anchor - sh.offsetTop) / Math.max(1, sh.offsetHeight);
    fn();
    this.sc.scrollTop = sh.offsetTop + f * sh.offsetHeight - this.anchor();
  }
  setZoom(v) { v = clamp(v, 0.3, 6); this.keepPos(() => { state[this.zkey] = v; this.applyZoom(); }); saveState(); }
  zoomBy(f) { this.setZoom(state[this.zkey] * f); }
  build() {
    this.root.innerHTML = ''; this.sheets = []; this.near.clear();
    if (this.io) this.io.disconnect();
    if (!DOC) return;
    this.applyZoom();
    this.io = new IntersectionObserver(es => es.forEach(en => this.onNear(+en.target.dataset.p, en.isIntersecting)), { root: this.sc, rootMargin: '130% 0px' });
    const frag = document.createDocumentFragment();
    DOC.pages.forEach(pg => {
      if (DOC.count > 1) { const lab = document.createElement('div'); lab.className = 'pgsep'; lab.textContent = 'עמוד ' + pg.i + (pg.num && String(pg.num) !== String(pg.i) ? ` (מודפס ${pg.num})` : ''); frag.appendChild(lab); }
      const sh = document.createElement('section');
      sh.className = 'sheet' + (DOC.kind === 'pdf' ? '' : ' flow'); sh.dataset.p = pg.i;
      if (DOC.kind === 'pdf') { sh.style.setProperty('--pw', pg.w); sh.style.setProperty('--ph', pg.h); }
      else sh.style.setProperty('--pw', 620);
      frag.appendChild(sh); this.sheets.push(sh);
    });
    this.root.appendChild(frag);
    this.sheets.forEach(sh => { if (DOC.kind !== 'pdf') this.renderPage(+sh.dataset.p); this.io.observe(sh); });
  }
  onNear(i, near) {
    if (near) { this.near.add(i); this.renderPage(i); requestNikud(i); }
    else { this.near.delete(i); if (DOC && DOC.kind === 'pdf' && this.sheets[i - 1]) this.sheets[i - 1].textContent = ''; }
  }
  refresh() { this.applyZoom(); (DOC && DOC.kind !== 'pdf' ? this.sheets.map(s => +s.dataset.p) : [...this.near]).forEach(i => this.renderPage(i)); }
  renderPage(i) {
    const pg = DOC && DOC.pages[i - 1], sh = this.sheets[i - 1]; if (!pg || !sh) return;
    const toks = TOK.get(i), mode = this.mode, bm = getProg();
    const notes = state.notes && mode !== 'orig' ? notesOf(i) : [];
    const frag = document.createDocumentFragment();
    pg.lines.forEach((ln, li) => {
      let el, host;
      if (DOC.kind === 'pdf') {
        el = document.createElement('div'); el.className = 'ln';
        el.style.cssText = `--y:${ln.y};--r:${(pg.w - ln.x1).toFixed(1)};--wd:${(ln.x1 - ln.x0).toFixed(1)};--s:${ln.s}`;
        host = document.createElement('span'); host.className = 'lni'; el.appendChild(host);
      } else { el = host = document.createElement('p'); el.className = 'par'; }
      el.dataset.l = li;
      const lt = toks && toks[li];
      if (!lt || mode === 'orig') host.appendChild(document.createTextNode(ln.t));
      else lt.forEach((tk, ti) => {
        if (tk.s != null) {
          host.appendChild(document.createTextNode(tk.s));
          const pw = ti > 0 && lt[ti - 1].o ? ti - 1 : -1;            // the word this separator follows
          if (pw >= 0) {
            const m = breathOf(i, li, pw);
            if (m) host.appendChild(breathEl(m, pw));
            else if (m === null && state.breath && mode === 'narr' && PUNCT.test(tk.s)) host.appendChild(breathEl('auto', pw));
          }
          return;
        }
        const e0 = editOf(i, li, ti), e = (e0 && e0.o && e0.o !== tk.o) ? null : e0, d = display(tk, e, mode);
        const sp = document.createElement('span');
        sp.className = 'w' + (mode === 'narr' && state.crit && d.rs.length ? ' risk' : '') + (e ? ' edited' : '')
          + (bm && bm.page === i && bm.l === li && bm.i === ti ? ' bm' : '');
        sp.dataset.i = ti;
        const nn = notes.filter(n => inNote(n, li, ti));
        if (nn.length) { const n = nn[nn.length - 1]; sp.classList.add('nt'); sp.style.setProperty('--nc', preset(n.k).c); sp.dataset.n = n.id; sp.title = nn.map(noteLabel).join(' · '); }
        if (d.rs.length && mode === 'narr') sp.title = d.rs.join(' · ');
        sp.innerHTML = wordHTML(d.s, d.stress, evOn(mode));
        host.appendChild(sp);
        if (!(lt[ti + 1] && lt[ti + 1].s != null)) { const m = breathOf(i, li, ti); if (m) host.appendChild(breathEl(m, ti)); }   // end of line
        notes.forEach(n => { if (n.k === 'pause' && n.b.l === li && n.b.i === ti) { const b = document.createElement('span'); b.className = 'ntp'; b.textContent = '‖'; b.style.setProperty('--nc', preset(n.k).c); host.appendChild(b); } });
      });
      frag.appendChild(el);
    });
    if (!toks && mode !== 'orig' && pg.lines.length) { const b = document.createElement('div'); b.className = 'pstate'; b.textContent = 'מנקד…'; frag.appendChild(b); }
    sh.textContent = ''; sh.appendChild(frag);
    if (DOC.kind === 'pdf') this.fit(sh);
    if (notes.length && toks) this.placeNotes(sh, pg, notes);
  }
  placeNotes(sh, pg, notes) {       // a small label in the margin, level with the first marked word
    const z = this.z || 1, box = sh.getBoundingClientRect(), used = [];
    notes.forEach(n => {
      const le = sh.querySelector(`[data-l="${n.a.l}"]`), w = le && le.querySelector(`.w[data-i="${n.a.i}"]`); if (!w) return;
      let ny = (w.getBoundingClientRect().top - box.top) / z;
      while (used.some(u => Math.abs(u - ny) < 9)) ny += 9.5;
      used.push(ny);
      const el = document.createElement('div'); el.className = 'mnote'; el.dataset.n = n.id; el.textContent = noteLabel(n);
      const margin = DOC.kind === 'pdf' ? (pg.w - pg.lines[n.a.l].x1) : 54;
      el.style.cssText = `--ny:${ny.toFixed(1)};--nw:${Math.max(30, margin - 9).toFixed(0)};--nc:${preset(n.k).c}`;
      sh.appendChild(el);
    });
  }
  fit(sh) {                         // make every line exactly as wide as in the PDF
    const rows = [...sh.querySelectorAll('.ln')];
    const m = rows.map(el => { const h = el.firstChild; h.style.wordSpacing = ''; h.style.transform = ''; return [el, h]; })
      .map(([el, h]) => [h, el.clientWidth, h.offsetWidth, parseFloat(getComputedStyle(el).fontSize) || 16, (h.textContent.match(/ /g) || []).length]);
    m.forEach(([h, target, natural, fpx, sp]) => {
      if (!target || !natural) return;
      let ws = sp ? (target - natural) / sp / fpx : 0;       // em per space
      if (ws > 1.2 || (!sp && natural <= target)) return;     // a short line: leave as is
      const wsUse = Math.max(ws, -0.1);
      if (sp) h.style.wordSpacing = wsUse.toFixed(4) + 'em';
      const after = natural + wsUse * sp * fpx;
      if (after > target + 0.5) h.style.transform = `scaleX(${(target / after).toFixed(4)})`;
    });
  }
  anchor() { return Math.max(this.sc.clientHeight * 0.3, 24); }
  current() {
    const y = this.sc.scrollTop + this.anchor(); let lo = 0, hi = this.sheets.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.sheets[mid].offsetTop <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans + 1;
  }
  frac() { const p = this.current(), sh = this.sheets[p - 1]; return sh ? [p, (this.sc.scrollTop + this.anchor() - sh.offsetTop) / Math.max(1, sh.offsetHeight)] : [1, 0]; }
  goFrac(p, f) { const sh = this.sheets[p - 1]; if (sh) this.sc.scrollTop = sh.offsetTop + f * sh.offsetHeight - this.anchor(); }
  scrollToPage(i, ref) {
    i = clamp(Math.round(i) || 1, 1, this.sheets.length); const sh = this.sheets[i - 1]; if (!sh) return;
    this.sc.scrollTop = sh.offsetTop - 14;
    if (ref && ref.l != null) {
      this.renderPage(i);
      const lineEl = sh.querySelector(`[data-l="${ref.l}"]`);
      const el = (lineEl && ref.i != null && lineEl.querySelector(`.w[data-i="${ref.i}"]`)) || lineEl;
      if (el) { const r = el.getBoundingClientRect(), s = this.sc.getBoundingClientRect(); this.sc.scrollTop += r.top - s.top - this.anchor(); }
    }
  }
  wordAtReadingLine() {
    const s = this.sc.getBoundingClientRect(), y = s.top + this.sc.clientHeight * 0.26;
    for (const p of [...this.near].sort((a, b) => a - b)) {
      for (const w of this.sheets[p - 1].querySelectorAll('.w')) { const r = w.getBoundingClientRect(); if (r.bottom >= y) return { p, l: +w.closest('[data-l]').dataset.l, i: +w.dataset.i }; }
    }
    return { p: this.current(), l: null, i: null };
  }
}
const edView = new View($('#canvasWrap'), $('#edView'), false);
const rdView = new View($('#readerPage'), $('#rdView'), true);
const activeView = () => readerOpen ? rdView : edView;
function refreshAll() { edView.refresh(); if (readerOpen) rdView.refresh(); }
function refreshPage(i) { if (edView.near.has(i) || (DOC && DOC.kind !== 'pdf')) edView.renderPage(i); if (readerOpen && (rdView.near.has(i) || (DOC && DOC.kind !== 'pdf'))) rdView.renderPage(i); }

/* ------------------------------------------------------- nikud (lazy, queued) */
function requestNikud(i) {
  if (!DOC || i < 1 || i > DOC.count || TOK.has(i) || PENDING.has(i)) return;
  if (!DOC.pages[i - 1].lines.length) { TOK.set(i, []); return; }
  PENDING.add(i); pump();
}
async function pump() {
  if (pumping) return; pumping = true;
  while (PENDING.size && DOC) {
    const gen = docGen, cur = state.page || 1;
    let best = null, bd = 1e9;
    for (const i of PENDING) { const d = i >= cur ? (i - cur) : (cur - i) * 1.5 + 0.5; if (d < bd) { bd = d; best = i; } }
    PENDING.delete(best);
    const pg = DOC.pages[best - 1], key = `tok:${DOC.uid}:${best}`;
    let lines = await idb.get(key);
    if (!(Array.isArray(lines) && lines.length === pg.lines.length)) {
      lines = null;
      try {
        const r = await fetch('api/nikud_lines', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines: pg.lines.map(l => l.t), para: pg.lines.map((l, k) => k === 0 || !!l.p) }) });
        if (r.ok) lines = (await r.json()).lines;
      } catch { /* server unreachable: keep showing the plain text */ }
      if (gen !== docGen) continue;
      if (lines) idb.set(key, lines);
      else { toast(location.protocol === 'file:' ? 'פתח את הכלי דרך http://localhost:8788' : 'אין חיבור לשרת הניקוד — מוצג טקסט ללא ניקוד'); await new Promise(r => setTimeout(r, 3000)); continue; }
    }
    if (gen !== docGen) continue;
    TOK.set(best, lines); refreshPage(best);
  }
  pumping = false;
}
function onViewScroll(v) {
  if (!DOC || v !== activeView()) return;
  const p = v.current();
  if (p !== state.page) { state.page = p; const le = libEntry(state.cur); if (le) { le.page = p; libSaveSoon(); } updateNavUI(); saveState(); [p + 1, p + 2, p - 1].forEach(requestNikud); }
}

/* ------------------------------------------------------------------ library */
// Every document that was imported / converted stays here until the user deletes it.
let LIB = [];                       // [{uid,key,name,title,kind,count,added,opened,page}]
let libT = null;
const libSave = () => idb.set('lib', LIB);
const libSaveSoon = () => { clearTimeout(libT); libT = setTimeout(libSave, 600); };
const libEntry = uid => LIB.find(e => e.uid === uid);
const keyOfDoc = d => d.kind === 'pdf' ? 'pdf:' + d.name : 'text:' + d.sig;
const docTitle = () => { const e = DOC && libEntry(DOC.uid); return (e && e.title) || (DOC ? DOC.name : ''); };
const autoName = text => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 34 ? t.slice(0, 32) + '…' : t; };
function updateLibBtn() { $('#libCount').textContent = LIB.length ? ` (${LIB.length})` : ''; }
function libTouch(uid) { const e = libEntry(uid); if (e) { e.opened = Date.now(); libSaveSoon(); } }
function dropMarks(key) {            // edits, directions and bookmark of one document
  delete EDITS[key]; lsSet(LSK.edits, EDITS);
  delete NOTES[key]; lsSet(LSK.notes, NOTES);
  const pr = lsGet(LSK.prog, {}); delete pr[key]; lsSet(LSK.prog, pr);
  delete BREATHS[key]; lsSet(LSK.breaths, BREATHS);
}
async function libPurge(uid, withMarks) {
  const e = libEntry(uid); LIB = LIB.filter(x => x.uid !== uid);
  await idb.del('doc:' + uid); await idb.delPrefix('tok:' + uid + ':');
  if (withMarks && e) dropMarks(e.key);
  await libSave(); updateLibBtn();
}
async function libAdd(doc, replaceUid) {
  const key = keyOfDoc(doc);
  const old = libEntry(doc.uid) || LIB.find(e => e.key === key) || libEntry(replaceUid);
  const keep = old ? { title: old.title, added: old.added, page: old.key === key ? old.page : 0 } : {};
  for (const e of LIB.filter(e => e.uid !== doc.uid && (e.key === key || e.uid === replaceUid))) await libPurge(e.uid, e.key !== key);
  LIB = LIB.filter(e => e.uid !== doc.uid);
  LIB.push({ uid: doc.uid, key, name: doc.name, title: keep.title || '', kind: doc.kind, count: doc.count,
    added: keep.added || Date.now(), opened: Date.now(), page: keep.page || 0 });
  await idb.set('doc:' + doc.uid, doc); await libSave(); updateLibBtn();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
async function openFromLib(uid) {
  const e = libEntry(uid); if (!e) return;
  const doc = await idb.get('doc:' + uid);
  if (!doc || !doc.pages) { await libPurge(uid, false); renderLibrary(); return toast('המסמך הזה כבר לא שמור בדפדפן — ייבא אותו מחדש'); }
  closeLibrary();
  $('#inputArea').value = doc.kind === 'text' ? (doc.src || doc.pages.flatMap(pg => pg.lines.map(l => l.t)).join('\n')) : '';
  await setDoc(doc, { restored: true, tab: 'narr', page: e.page || 0 });
  toast('נפתח: ' + (e.title || e.name));
}
async function deleteFromLib(uid) {
  if (DOC && DOC.uid === uid) { closeDoc(); $('#inputArea').value = ''; }
  await libPurge(uid, true); saveState(); renderLibrary();
}
const countMarks = (obj, key) => Object.values(obj[key] || {}).reduce((n, pg) => n + (Array.isArray(pg) ? pg.length : Object.keys(pg).length), 0);
function renderLibrary() {
  const box = $('#libList'); box.innerHTML = '';
  const prog = lsGet(LSK.prog, {});
  if (!LIB.length) box.innerHTML = '<div class="libempty">הספרייה ריקה. כל קובץ שתייבא, וכל טקסט שתמיר, יישמר כאן אוטומטית.</div>';
  [...LIB].sort((a, b) => (b.opened || 0) - (a.opened || 0)).forEach(e => {
    const row = document.createElement('div'); row.className = 'librow' + (DOC && DOC.uid === e.uid ? ' cur' : ''); row.dataset.uid = e.uid;
    const bits = [e.count > 1 ? `${e.count} עמ׳` : 'עמוד אחד'];
    if (e.count > 1 && e.page) bits.push(`נעצרת בעמ׳ ${e.page}`);
    if (prog[e.key]) bits.push(`🔖 עמ׳ ${prog[e.key].page}`);
    const ne = countMarks(EDITS, e.key), nn = countMarks(NOTES, e.key);
    const nb = Object.values(BREATHS[e.key] || {}).reduce((n, pg) => n + Object.values(pg).filter(Boolean).length, 0);
    if (nn) bits.push(`🎙 ${nn} הנחיות`); if (nb) bits.push(`🌬 ${nb} נשימות`); if (ne) bits.push(`✏️ ${ne} תיקונים`);
    bits.push('נפתח ' + new Date(e.opened || e.added).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }));
    row.innerHTML = `<div class="libic">${e.kind === 'pdf' ? '📕' : '📝'}</div>
      <div class="libmain"><div class="libname"></div><div class="libmeta"></div></div>
      <div class="libacts"><button class="lopen">${DOC && DOC.uid === e.uid ? 'פתוח עכשיו' : 'פתח'}</button><button class="lren" title="שנה שם">✏️</button><button class="ldel" title="מחק מהספרייה">🗑</button></div>`;
    row.querySelector('.libname').textContent = e.title || e.name;
    row.querySelector('.libmeta').textContent = bits.join(' · ');
    row.querySelector('.lopen').onclick = () => (DOC && DOC.uid === e.uid) ? closeLibrary() : openFromLib(e.uid);
    row.querySelector('.libname').onclick = row.querySelector('.lopen').onclick;
    row.querySelector('.lren').onclick = () => {
      const nm = row.querySelector('.libname'), inp = document.createElement('input');
      inp.className = 'librename'; inp.value = e.title || e.name; nm.replaceWith(inp); inp.focus(); inp.select();
      const done = ok => { if (ok && inp.value.trim()) { e.title = inp.value.trim(); libSave(); if (DOC && DOC.uid === e.uid) fillBookNav(); } renderLibrary(); };
      inp.onkeydown = ev => { if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } };
      inp.onblur = () => done(true);
    };
    const del = row.querySelector('.ldel');
    del.onclick = () => {
      if (del.dataset.arm) return deleteFromLib(e.uid);
      del.dataset.arm = '1'; del.classList.add('arm'); del.textContent = 'למחוק?';
      setTimeout(() => { if (del.isConnected) { delete del.dataset.arm; del.classList.remove('arm'); del.textContent = '🗑'; } }, 3500);
    };
    box.appendChild(row);
  });
  $('#libFoot').textContent = 'המסמכים נשמרים בדפדפן הזה, במחשב הזה.';
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(q => {
    if (q && q.usage) $('#libFoot').textContent = `המסמכים נשמרים בדפדפן הזה, במחשב הזה · בשימוש ${(q.usage / 1048576).toFixed(1)}MB`;
  }).catch(() => {});
}
/* backup / restore: the whole library in one file (documents, saved nikud, edits, directions, breaths, bookmarks) */
async function backupLibrary() {
  if (!LIB.length) return toast('הספרייה ריקה — אין מה לגבות');
  showBusy(true);
  try {
    await libSave();
    const docs = {}, toks = {};
    for (const [k, v] of await idb.entries('doc:')) docs[k.slice(4)] = v;
    for (const [k, v] of await idb.entries('tok:')) toks[k.slice(4)] = v;
    const keys = new Set(LIB.map(e => e.key)), pick = o => Object.fromEntries(Object.entries(o).filter(([k]) => keys.has(k)));
    const data = { type: 'nikud-karyanim-backup', version: 1, saved: new Date().toISOString(), lib: LIB, docs, toks,
      edits: pick(EDITS), notes: pick(NOTES), breaths: pick(BREATHS), prog: pick(lsGet(LSK.prog, {})) };
    const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    download(`גיבוי-ספרייה-ניקוד-${stamp}.json`, JSON.stringify(data));
    toast(`נשמר קובץ גיבוי עם ${LIB.length} מסמכים — שמור אותו במקום בטוח`);
  } catch (err) { toast('הגיבוי נכשל: ' + err.message); }
  finally { showBusy(false); }
}
async function restoreLibrary(file) {
  showBusy(true);
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.type !== 'nikud-karyanim-backup' || !Array.isArray(data.lib)) return toast('זה לא קובץ גיבוי של הספרייה');
    let added = 0, updated = 0;
    for (const e of data.lib) {
      const doc = data.docs && data.docs[e.uid]; if (!doc || !doc.pages) continue;
      const same = LIB.filter(x => x.uid === e.uid || x.key === e.key);
      for (const x of same) { await idb.del('doc:' + x.uid); await idb.delPrefix('tok:' + x.uid + ':'); }
      LIB = LIB.filter(x => !same.includes(x)); LIB.push(e); same.length ? updated++ : added++;
      await idb.set('doc:' + e.uid, doc);
      for (const [k, v] of Object.entries(data.toks || {})) if (k.startsWith(e.uid + ':')) await idb.set('tok:' + k, v);
      if (data.edits && data.edits[e.key]) EDITS[e.key] = data.edits[e.key];
      if (data.notes && data.notes[e.key]) NOTES[e.key] = data.notes[e.key];
      if (data.breaths && data.breaths[e.key]) BREATHS[e.key] = data.breaths[e.key];
      if (data.prog && data.prog[e.key]) { const pr = lsGet(LSK.prog, {}); pr[e.key] = data.prog[e.key]; lsSet(LSK.prog, pr); }
    }
    lsSet(LSK.edits, EDITS); lsSet(LSK.notes, NOTES); lsSet(LSK.breaths, BREATHS);
    await libSave(); updateLibBtn(); renderLibrary();
    if (DOC) { TOK.clear(); refreshAll(); [state.page, state.page + 1].forEach(requestNikud); updateResume(); }
    toast(added + updated ? `שוחזרו ${added + updated} מסמכים${updated ? ` (${updated} החליפו גרסה קיימת)` : ''}` : 'לא נמצאו מסמכים בקובץ הגיבוי');
  } catch (err) { toast('השחזור נכשל: ' + (err.message || 'קובץ לא תקין')); }
  finally { showBusy(false); }
}
function openLibrary() { hidePop(); renderLibrary(); $('#libModal').style.display = 'flex'; }
function closeLibrary() { $('#libModal').style.display = 'none'; }

/* ------------------------------------------------------------ document setup */
function textDoc(text, name) {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const pages = []; let cur = [], len = 0;
  const push = () => { if (cur.length) { pages.push({ i: pages.length + 1, num: null, lines: cur.map(t => ({ t, p: true })) }); cur = []; len = 0; } };
  for (const p of paras) {
    const parts = p.length > 2200 ? p.split(/(?<=[.!?…])\s+/).reduce((a, s) => { if (a.length && (a[a.length - 1] + ' ' + s).length < 1500) a[a.length - 1] += ' ' + s; else a.push(s); return a; }, []) : [p];
    for (const q of parts) { if (len + q.length > 1700) push(); cur.push(q); len += q.length; }
  }
  push();
  return { uid: 'text:' + hash(text) + ':' + text.length, sig: hash(text) + text.length, name, src: text, kind: 'text', count: pages.length, first: 1, chapters: [], pages, ff: 1 };
}
async function fontFactor(doc) {                // match the book's line widths with our typeface
  try { await document.fonts.load('500 20px "Frank Ruhl Libre"'); } catch {}
  const ctx = document.createElement('canvas').getContext('2d'); const rs = [];
  for (const pg of doc.pages.slice(doc.first - 1, doc.first + 5)) {
    for (const ln of pg.lines) {
      if (ln.t.split(' ').length < 6) continue;
      ctx.font = `500 ${ln.s * 4}px "Frank Ruhl Libre"`;
      rs.push(ctx.measureText(N.stripMarks(ln.t)).width / 4 / (ln.x1 - ln.x0));
    }
  }
  if (rs.length < 5) return 1;
  rs.sort((a, b) => a - b);
  return +clamp(0.99 / rs[Math.floor(rs.length * 0.85)], 0.75, 1.12).toFixed(3);
}
async function setDoc(doc, opts = {}) {
  docGen++; DOC = doc; TOK.clear(); PENDING.clear(); UNDO.length = REDO.length = 0;
  if (!opts.restored) await libAdd(doc, opts.replace);
  state.cur = doc.uid; libTouch(doc.uid);
  fillBookNav();
  $('#canvasWrap').classList.add('docmode');
  edView.build(); if (readerOpen) rdView.build();
  showTab(opts.tab || 'narr');
  const pr = getProg();
  const target = opts.page || (pr ? pr.page : doc.first || 1);
  state.page = target;
  requestAnimationFrame(() => { activeView().scrollToPage(target, opts.page ? null : pr); updateNavUI(); [target, target + 1].forEach(requestNikud); });
  if (!opts.restored) {
    const ch = (doc.chapters || []).length;
    toast(doc.count > 1 ? `נטען: ${doc.count} עמ׳${ch ? ` · ${ch} פרקים` : ''}${pr ? ` · ממשיך מהמקום שהפסקת (עמ׳ ${pr.page})` : ''}` : 'מנקד…');
  }
  saveState();
}
function closeDoc() {
  docGen++; DOC = null; TOK.clear(); PENDING.clear();
  state.cur = '';                        // the document itself stays in the library
  $('#bookNav').style.display = 'none'; $('#rPage').textContent = '';
  $('#canvasWrap').classList.remove('docmode');
  edView.build(); rdView.build(); showTab('orig');
}

/* ------------------------------------------------------------------- nav UI */
function fillBookNav() {
  const multi = DOC && DOC.count > 1;
  $('#bookNav').style.display = DOC ? 'flex' : 'none';
  if (!DOC) return;
  $('#bookName').textContent = docTitle(); $('#bookName').title = DOC.name;
  $('#pgTotal').textContent = '/ ' + DOC.count; $('#pgInput').max = DOC.count;
  document.querySelectorAll('#bookNav .pgctrl').forEach(e => e.style.display = multi ? 'flex' : 'none');
  const sel = $('#chapSel'); sel.innerHTML = '<option value="">פרקים…</option>';
  (DOC.chapters || []).forEach(c => { const o = document.createElement('option'); o.value = c.i; const pg = DOC.pages[c.i - 1]; o.textContent = `${c.title} · עמ׳ ${(pg && pg.num) || c.i}`; sel.appendChild(o); });
  sel.style.display = (DOC.chapters || []).length ? '' : 'none';
  updateResume();
}
function updateResume() { const b = getProg(); $('#pgResume').style.display = b ? '' : 'none'; if (b) $('#pgResume').textContent = `↩︎ המקום שהפסקתי (עמ׳ ${b.page})`; }
function updateNavUI() {
  if (!DOC) return;
  const p = state.page, pg = DOC.pages[p - 1];
  if (document.activeElement !== $('#pgInput')) $('#pgInput').value = p;
  $('#pgPrinted').textContent = (pg && pg.num && String(pg.num) !== String(p)) ? `(מודפס: ${pg.num})` : '';
  let cur = ''; (DOC.chapters || []).forEach(c => { if (c.i <= p) cur = String(c.i); });
  $('#chapSel').value = cur;
  const ch = (DOC.chapters || []).filter(c => c.i <= p).pop();
  $('#rPage').textContent = DOC.count > 1 ? `עמ׳ ${p} / ${DOC.count}` : '';
  $('#rPage').title = ch ? ch.title : '';
}
const goPage = i => { if (DOC) activeView().scrollToPage(i); };
$('#pgPrev').onclick = () => goPage(state.page - 1);
$('#pgNext').onclick = () => goPage(state.page + 1);
$('#pgInput').onchange = e => goPage(+e.target.value);
$('#chapSel').onchange = e => { if (e.target.value) goPage(+e.target.value); else updateNavUI(); };
function setBookmark(ref) {
  if (!DOC) return toast('אין מסמך טעון');
  ref = ref || activeView().wordAtReadingLine();
  setProg(ref.p, ref.l, ref.i); updateResume(); refreshAll();
  toast(`🔖 נשמר: הפסקת בעמ׳ ${ref.p}`);
}
$('#pgMark').onclick = () => setBookmark(pop.ref ? { p: pop.ref.p, l: pop.ref.l, i: pop.ref.i } : null);
$('#pgResume').onclick = () => { const b = getProg(); if (b) activeView().scrollToPage(b.page, b); };

/* --------------------------------------------------------------------- tabs */
function showTab(t) {
  state.tab = t;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  const textMode = !DOC || (DOC.kind === 'text' && t === 'orig');
  $('#inputArea').style.display = textMode ? '' : 'none';
  $('#edView').style.display = textMode ? 'none' : '';
  $('#canvasWrap').classList.toggle('docmode', !textMode);
  if (!textMode) { const [p, f] = edView.frac(); edView.refresh(); edView.goFrac(p, f); }
  saveState();
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  if (b.dataset.tab !== 'orig' && !DOC) { if ($('#inputArea').value.trim()) return convert(b.dataset.tab); return toast('הדבק טקסט או ייבא קובץ קודם'); }
  showTab(b.dataset.tab);
});
async function convert(tab) {
  if (DOC && DOC.kind === 'pdf') { showTab(typeof tab === 'string' ? tab : 'narr'); return toast('בספר הניקוד אוטומטי — פשוט גוללים'); }
  const text = $('#inputArea').value.trim();
  if (!text) return toast('אין טקסט לנקד — הדבק טקסט או ייבא קובץ');
  let prev = DOC && DOC.kind === 'text' ? DOC : null;
  if (prev && prev.src) {                 // same document, edited?  (shared start+end ≥ half of the shorter text)
    const a = prev.src, n = Math.min(a.length, text.length); let i = 0, j = 0;
    while (i < n && a[i] === text[i]) i++;
    while (j < n - i && a[a.length - 1 - j] === text[text.length - 1 - j]) j++;
    if (i + j < n * 0.5) prev = null;
  }
  const d = textDoc(text, prev ? prev.name : autoName(text));
  if (DOC && DOC.uid === d.uid) return showTab(typeof tab === 'string' ? tab : 'narr');
  await setDoc(d, { tab: typeof tab === 'string' ? tab : 'narr', replace: prev ? prev.uid : null });
}

/* ------------------------------------------------------------------ toolbar */
$('#btnConvert').onclick = () => convert();
$('#btnClean').onclick = () => showTab('orig');
$('#btnTrash').onclick = () => { const had = !!DOC; closeDoc(); $('#inputArea').value = ''; saveState(); if (had) toast('המסמך נסגר — הוא שמור ב״ספרייה שלי״'); };
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnImport').onclick = () => $('#fileTxt').click();
$('#btnOpen').onclick = openLibrary;
$('#libClose').onclick = closeLibrary;
$('#libImport').onclick = () => { closeLibrary(); $('#fileTxt').click(); };
$('#libBackup').onclick = backupLibrary;
$('#libRestore').onclick = () => $('#fileBackup').click();
$('#fileBackup').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreLibrary(f); };
$('#libModal').addEventListener('click', e => { if (e.target === $('#libModal')) closeLibrary(); });
$('#btnSave').onclick = exportDoc;
$('#fileTxt').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  if (location.protocol === 'file:') return toast('פתח את הכלי דרך http://localhost:8788 (לא כקובץ)');
  try {
    if (f.name.toLowerCase().endsWith('.pdf')) {
      showBusy(true); let r, j;
      try { r = await fetch('api/pdf_pages', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: await f.arrayBuffer() }); j = await r.json(); }
      catch { return toast('לא ניתן להגיע לשרת — ודא שהכלי פתוח דרך http://localhost:8788'); }
      finally { showBusy(false); }
      if (!r.ok) return toast('שגיאת PDF: ' + (j.error || r.status));
      if (!j.pages.some(p => p.lines && p.lines.length)) return toast('לא נמצא טקסט ב-PDF (כנראה סרוק כתמונה)');
      const doc = { uid: 'pdf:' + f.name + ':' + Date.now(), name: f.name, kind: 'pdf', count: j.count, first: j.first_content || 1,
        chapters: j.chapters || [], pages: j.pages.map(p => ({ i: p.i, num: p.num, w: p.w, h: p.h, lines: p.lines })) };
      doc.ff = await fontFactor(doc);
      $('#inputArea').value = '';
      await setDoc(doc);
    } else {
      const text = (await f.text()).trim();
      $('#inputArea').value = text;
      await setDoc(textDoc(text, f.name));
    }
  } catch (err) { toast('שגיאת ייבוא: ' + err.message); }
};
function download(name, content) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
function exportDoc() {
  if (!DOC) { download('text.txt', $('#inputArea').value); return; }
  const out = []; let n = 0;
  DOC.pages.forEach(pg => {
    const toks = TOK.get(pg.i); if (!toks) return; n++;
    if (DOC.count > 1) out.push(`— עמוד ${pg.i} —`);
    toks.forEach((lt, li) => out.push(lt.map((tk, ti) => { if (tk.s != null) return tk.s; const m = breathOf(pg.i, li, ti); return display(tk, editOf(pg.i, li, ti), 'narr').s + (m ? (m === 2 ? ' //' : ' /') : ''); }).join('')));
    out.push('');
  });
  download(DOC.name.replace(/\.[^.]+$/, '') + '-מנוקד.txt', out.join('\n'));
  toast(n < DOC.count ? `נשמרו ${n} עמודים מנוקדים מתוך ${DOC.count} (עמוד מנוקד כשמגיעים אליו)` : 'נשמר');
}

/* ----------------------------------------------------- settings: toggles etc */
const TOGGLES = [
  ['unify_vowels', 'איחוד תנועות (צירה→סגול, חטפים)'],
  ['shva_nach_remove', 'שווא נח – הסרה (אות ריקה)'],
  ['shva_na_segol', 'שווא נע – מוצג כסגול (אֶ)'],
  ['initial_shva_na', 'שווא בראש מילה – תמיד נע (דקדוקי)'],
  ['kamatz_katan', 'קמץ קטן → חולם (כֹּל)'],
  ['dagesh_bkp_only', 'דגש רק ב-ב, כ, פ'],
  ['__shin', 'הבחנת שׁ / שׂ'],
  ['e_as_v', 'תנועת E (סגול / צירה) מסומנת ב-v'],
  ['stress_marks', 'סימון הטעמה ▲ (מלעיל)'],
];
function buildToggles() {
  const box = $('#toggles'); box.innerHTML = '';
  TOGGLES.forEach(([k, label]) => {
    const row = document.createElement('div'); row.className = 'toggle-row';
    const on = k === '__shin' ? true : state.opts[k];
    row.innerHTML = `<span>${label}</span><span class="sw ${on ? 'on' : ''}" data-k="${k}"></span>`;
    box.appendChild(row);
  });
  box.querySelectorAll('.sw').forEach(sw => sw.onclick = () => {
    const k = sw.dataset.k; if (k === '__shin') return toast('הבחנת שׁ/שׂ תמיד פעילה');
    state.opts[k] = !state.opts[k]; sw.classList.toggle('on', state.opts[k]);
    updateDemo(); refreshAll(); saveState();
  });
}
function updateDemo() {
  $('#demoGram').textContent = 'בַּתָּכְנִית';
  $('#demoPhon').textContent = N.toNarr('בַּתׇּכְנִית', state.opts);
}
const DMAP = { minimal: 0, medium: 1, full: 2 };
function setDensity(d) {
  state.density = d; const pct = [0, 50, 100][DMAP[d]];
  $('#densFill').style.width = pct + '%'; $('#densDot').style.right = pct + '%';
  $('#densFill').style.right = '0'; $('#densFill').style.left = 'auto';
  document.querySelectorAll('#densStops span').forEach(s => s.classList.toggle('on', s.dataset.d === d));
  refreshAll(); saveState();
}
$('#densStops').querySelectorAll('span').forEach(s => s.onclick = () => setDensity(s.dataset.d));
function applySwitches() {
  $('#swFollow').classList.toggle('on', state.follow); $('#reader').classList.toggle('follow', state.follow);
  $('#btnBreath').classList.toggle('active', state.breath); $('#btnCrit').classList.toggle('active', state.crit);
  $('#btnNotes').classList.toggle('active', state.notes);
}
$('#swFollow').onclick = () => { state.follow = !state.follow; applySwitches(); saveState(); };
$('#btnBreath').onclick = () => { state.breath = !state.breath; if (state.breath) toast('הצעות נשימה מוצגות אחרי סימני פיסוק · נשימה משלך: Alt+לחיצה על מילה, או לחיצה על מילה ← ״נשימה״', 5200); applySwitches(); refreshAll(); saveState(); };
$('#btnCrit').onclick = () => { state.crit = !state.crit; applySwitches(); refreshAll(); saveState(); };
$('#lhRange').oninput = e => { state.lh = +e.target.value; refreshAll(); saveState(); };
$('#fsUp').onclick = () => edView.zoomBy(1.12); $('#fsDown').onclick = () => edView.zoomBy(1 / 1.12);
$('#fsReset').onclick = () => edView.setZoom(1);
$('#navSettings').onclick = () => $('#settings').scrollIntoView({ behavior: 'smooth' });
$('#navGuide').onclick = () => $('#guide').style.display = 'flex';
$('#navEditor').onclick = () => { if (readerOpen) closeReader(); };

/* ---------------------------------------------------------- word popover */
const pop = { ref: null, v: null, k: 0 };
const VOW = [['ַ', 'פתח'], ['ָ', 'קמץ'], ['ֶ', 'סגול'], ['ֵ', 'צירה'], ['ִ', 'חיריק'], ['ֹ', 'חולם'], ['ֻ', 'קובוץ'],
  ['ְֽ', 'שווא נע'], ['ְ', 'שווא נח'], ['ׇ', 'קמץ קטן'], ['', 'ללא']];
function hidePop() { $('#pop').style.display = 'none'; pop.ref = null; document.querySelectorAll('.w.sel').forEach(w => w.classList.remove('sel')); }
function popTok() { const r = pop.ref; return r && TOK.get(r.p) && TOK.get(r.p)[r.l] && TOK.get(r.p)[r.l][r.i]; }
const popMode = () => activeView().mode;
function popShow(v) { return popMode() === 'full' ? N.toFull(v) : N.toNarr(v, state.opts); }
function drawPop() {
  const tk = popTok(); if (!tk) return hidePop();
  const e = editOf(pop.ref.p, pop.ref.l, pop.ref.i);
  const base = tk.v;
  // quick choices
  const box = $('#popAlts'); box.innerHTML = '';
  const add = (v, tag, hint, cur) => {
    const b = document.createElement('button'); b.className = 'alt' + (cur ? ' cur' : '');
    b.innerHTML = `<span class="big">${wordHTML(popShow(v), -1, evOn(popMode()))}</span><small>${escapeH(tag)}${hint ? ' · <i>' + escapeH(hint) + '</i>' : ''}</small>`;
    b.onclick = () => { pop.v = v; saveFromPop({ v }); };
    box.appendChild(b);
  };
  const vars = N.prefixVariants(base, tk.p || 0);
  const autoShown = popShow(base), curShown = popShow(pop.v);
  let autoListed = false;
  vars.forEach(x => {                      // a variant that looks like the automatic reading IS the automatic one
    const isAuto = popShow(x.v) === autoShown; autoListed = autoListed || isAuto;
    add(isAuto ? base : x.v, x.tag + (isAuto ? ' ✓ אוטומטי' : ''), x.hint, popShow(x.v) === curShown);
  });
  const bareNow = !e && display(tk, null, popMode()).s !== autoShown;
  if (!autoListed) add(base, bareNow ? 'נקד את המילה (ניקוד אוטומטי)' : 'הניקוד האוטומטי', '', !bareNow && autoShown === curShown);
  $('#popVarTitle').textContent = vars.length ? 'התחילית — בחר הגייה:' : 'הגייה:';
  // letter editor
  const us = N.units(pop.v); pop.k = clamp(pop.k, 0, us.length - 1);
  const row = $('#popLetters'); row.innerHTML = '';
  us.forEach(([c, m], k) => {
    const b = document.createElement('button'); b.className = 'let' + (k === pop.k ? ' on' : '') + (m.includes(N.STRESS) ? ' st' : '');
    b.textContent = N.toFull(N.render([[c, m]])); b.onclick = () => { pop.k = k; drawPop(); };
    row.appendChild(b);
  });
  const pal = $('#popVowels'); pal.innerHTML = '';
  const curMarks = us[pop.k] ? us[pop.k][1] : [];
  VOW.forEach(([mk, name]) => {
    const b = document.createElement('button'); b.className = 'vw'; b.innerHTML = `<span>${mk ? 'א' + mk.replace('ֽ', '') : '∅'}</span><small>${name}</small>`;
    b.onclick = () => { pop.v = N.setVowel(pop.v, pop.k, [...mk]); drawPop(); };
    pal.appendChild(b);
  });
  const tg = (label, mark, title) => { const b = document.createElement('button'); b.className = 'vw' + (curMarks.includes(mark) ? ' on' : ''); b.innerHTML = `<span>${label}</span><small>${title}</small>`; b.onclick = () => { pop.v = N.toggleMark(pop.v, pop.k, mark); drawPop(); }; pal.appendChild(b); };
  tg('בּ', N.DAGESH, 'דגש'); tg('▲', N.STRESS, 'הטעמה כאן');
  if (us[pop.k] && us[pop.k][0] === 'ש') { tg('שׁ', N.SHIN, 'שין'); tg('שׂ', N.SIN, 'שׂין'); }
  $('#popInput').value = (e && (popMode() === 'full' ? e.f : e.n)) || popShow(pop.v);
  $('#popInput').dataset.auto = popShow(pop.v);
  $('#popReset').style.display = e ? '' : 'none';
  const bv = breathOf(pop.ref.p, pop.ref.l, pop.ref.i);
  $('#popBreath').textContent = bv === 1 ? '🌬 נשימה  /  (לחץ: ארוכה)' : bv === 2 ? '🌬 נשימה ארוכה  //  (לחץ: הסר)' : '🌬 נשימה אחרי המילה';
  const hasN = notesOf(pop.ref.p).filter(x => inNote(x, pop.ref.l, pop.ref.i)).pop();
  $('#popNote').textContent = hasN ? '🎙 ערוך הנחיה: ' + noteLabel(hasN) : '🎙 הנחיה לקריין';
}
function saveFromPop(e) {
  const r = pop.ref, tk = popTok(); if (!tk) return;
  // choosing the automatic reading of a word that is shown bare/partial means "vocalize this word"
  const same = e.v === tk.v && !e.n && !e.f;
  const alreadyFull = display(tk, null, popMode()).s === popShow(tk.v);
  commitEdit(r.p, r.l, r.i, same && alreadyFull ? null : { o: tk.o, ...e });
  hidePop();
}
function openPop(span) {
  const sh = span.closest('.sheet'), ln = span.closest('[data-l]'); if (!sh || !ln) return;
  hidePop(); hideNotePop();
  pop.ref = { p: +sh.dataset.p, l: +ln.dataset.l, i: +span.dataset.i };
  const tk = popTok(); if (!tk) return;
  const e = editOf(pop.ref.p, pop.ref.l, pop.ref.i);
  pop.v = (e && e.v) || tk.v; pop.k = Math.max(0, N.prefixTarget(pop.v, tk.p || 0));
  span.classList.add('sel'); drawPop();
  const el = $('#pop'); el.style.display = 'block';
  const r = span.getBoundingClientRect();
  let top = r.bottom + 8, left = clamp(r.left + r.width / 2 - el.offsetWidth / 2, 12, window.innerWidth - el.offsetWidth - 12);
  if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 8);
  el.style.top = top + 'px'; el.style.left = left + 'px';
}
function viewClick(ev, reader) {
  const br = ev.target.closest('.breath');
  if (br) { ev.stopPropagation(); cycleBreath(+br.closest('.sheet').dataset.p, +br.closest('[data-l]').dataset.l, +br.dataset.w, true); return; }
  const w = ev.target.closest('.w'); if (!w || (!reader && state.tab === 'orig')) return;
  ev.stopPropagation();
  if (ev.altKey) { const r = refOf(w); window.getSelection()?.removeAllRanges(); cycleBreath(r.p, r.l, r.i, false); return; }   // Alt+click = breath here
  if (reader && playing) stopPlay();
  openPop(w);
}
$('#edView').addEventListener('click', ev => viewClick(ev, false));
$('#rdView').addEventListener('click', ev => viewClick(ev, true));
$('#popBreath').onclick = () => { const r = pop.ref; if (r) { cycleBreath(r.p, r.l, r.i, false); const sp = activeView().sheets[r.p - 1]?.querySelector(`[data-l="${r.l}"] .w[data-i="${r.i}"]`); if (sp) sp.classList.add('sel'); drawPop(); } };
$('#popApply').onclick = () => {
  const val = $('#popInput').value.trim(); if (!pop.ref || !val) return hidePop();
  if (val === $('#popInput').dataset.auto) saveFromPop({ v: pop.v });
  else saveFromPop(popMode() === 'full' ? { v: pop.v, f: val } : { v: pop.v, n: val });
};
$('#popInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#popApply').click(); });
$('#popReset').onclick = () => { const r = pop.ref; if (r) { commitEdit(r.p, r.l, r.i, null); hidePop(); toast('הוחזר לניקוד האוטומטי'); } };
$('#popMark').onclick = () => { const r = pop.ref; hidePop(); if (r) setBookmark(r); };
document.addEventListener('click', e => {       // (composedPath: buttons inside the popover are re-created on every click)
  const path = e.composedPath ? e.composedPath() : [];
  if (path.includes($('#notePop'))) return;
  const inPop = path.includes($('#pop')), tc = sel => e.target.closest && e.target.closest(sel);
  if (note.ref && !inPop && !tc('.mnote') && window.getSelection()?.isCollapsed !== false) hideNotePop();
  if (inPop || tc('.w')) return;
  hidePop();
});

/* ------------------------------------------------- narrator directions: UI */
const note = { ref: null, id: null, k: 'emph' };
function hideNotePop() { $('#notePop').style.display = 'none'; note.ref = null; }
function wordsText(p, a, b) {
  const toks = TOK.get(p) || [], out = [];
  for (let l = a.l; l <= b.l && l < toks.length; l++) toks[l].forEach((t, i) => { if (t.o && inNote({ a, b }, l, i)) out.push(t.o); });
  const s = out.join(' '); return s.length > 70 ? s.slice(0, 34) + ' … ' + s.slice(-30) : s;
}
function drawNotePop() {
  const box = $('#noteKinds'); box.innerHTML = '';
  PRESETS.forEach(pr => {
    const b = document.createElement('button'); b.className = 'nk' + (pr.k === note.k ? ' on' : ''); b.style.setProperty('--nc', pr.c);
    b.innerHTML = `<span>${pr.ic}</span>${escapeH(pr.t)}`;
    b.onclick = () => { note.k = pr.k; drawNotePop(); if (pr.k === 'note') $('#noteText').focus(); };
    box.appendChild(b);
  });
  $('#noteDel').style.display = note.id ? '' : 'none';
}
function openNotePop(ref, rect, existing) {
  hidePop(); if (playing) stopPlay();
  note.ref = ref; note.id = existing ? existing.id : null; note.k = existing ? existing.k : 'emph';
  $('#noteText').value = existing ? (existing.x || '') : '';
  $('#noteWords').textContent = '״' + wordsText(ref.p, ref.a, ref.b) + '״';
  drawNotePop();
  const el = $('#notePop'); el.style.display = 'block';
  let top = rect.bottom + 10, left = clamp(rect.left + rect.width / 2 - el.offsetWidth / 2, 12, window.innerWidth - el.offsetWidth - 12);
  if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - el.offsetHeight - 10);
  el.style.top = top + 'px'; el.style.left = left + 'px';
}
function saveNote() {
  const r = note.ref; if (!r) return;
  const x = $('#noteText').value.trim();
  if (note.k === 'note' && !x) return toast('כתוב את ההערה, או בחר הנחיה מהרשימה');
  putNote(r.p, { id: note.id || Date.now().toString(36), a: r.a, b: r.b, k: note.k, x });
  window.getSelection()?.removeAllRanges(); hideNotePop();
}
$('#noteSave').onclick = saveNote;
$('#noteText').addEventListener('keydown', e => { if (e.key === 'Enter') saveNote(); });
$('#noteCancel').onclick = () => { window.getSelection()?.removeAllRanges(); hideNotePop(); };
$('#noteDel').onclick = () => { if (note.ref && note.id) dropNote(note.ref.p, note.id); hideNotePop(); };
const refOf = w => ({ p: +w.closest('.sheet').dataset.p, l: +w.closest('[data-l]').dataset.l, i: +w.dataset.i });
function selectionToNote(view) {             // dragging over several words -> offer a direction for them
  const sel = window.getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount || view.mode === 'orig') return;
  const range = sel.getRangeAt(0); if (!view.root.contains(range.commonAncestorContainer)) return;
  const ws = [];
  for (const sh of view.sheets) { if (sh.firstChild && range.intersectsNode(sh)) for (const w of sh.querySelectorAll('.w')) if (range.intersectsNode(w)) ws.push(w); }
  if (ws.length < 2) return;
  const a = refOf(ws[0]); let last = ws[ws.length - 1];
  if (refOf(last).p !== a.p) { last = ws.filter(w => refOf(w).p === a.p).pop(); toast('הנחיה אחת מסומנת בתוך עמוד אחד — סומן עד סוף העמוד'); }
  const b = refOf(last);
  openNotePop({ p: a.p, a: { l: a.l, i: a.i }, b: { l: b.l, i: b.i } }, range.getBoundingClientRect(), null);
}
[edView, rdView].forEach(v => {
  v.root.addEventListener('mouseup', () => setTimeout(() => selectionToNote(v), 0));
  v.root.addEventListener('touchend', () => setTimeout(() => selectionToNote(v), 350), { passive: true });
  v.root.addEventListener('click', ev => {
    const m = ev.target.closest('.mnote'); if (!m) return; ev.stopPropagation();
    const p = +m.closest('.sheet').dataset.p, n = notesOf(p).find(x => x.id === m.dataset.n);
    if (n) openNotePop({ p, a: n.a, b: n.b }, m.getBoundingClientRect(), n);
  });
});
$('#popNote').onclick = () => {
  const r = pop.ref; if (!r) return;
  const span = document.querySelector('.w.sel'), rect = (span || $('#pop')).getBoundingClientRect();
  const n = notesOf(r.p).filter(x => inNote(x, r.l, r.i)).pop();
  openNotePop(n ? { p: r.p, a: n.a, b: n.b } : { p: r.p, a: { l: r.l, i: r.i }, b: { l: r.l, i: r.i } }, rect, n || null);
};
$('#btnNotes').onclick = () => { state.notes = !state.notes; applySwitches(); refreshAll(); saveState(); };

/* -------------------------------------------------------- full-screen reader */
let rRaf = 0, rLast = 0, playing = null;
function openReader() {
  if (!DOC) { if ($('#inputArea').value.trim()) return convert().then(() => DOC && openReader()); return toast('הדבק טקסט או ייבא קובץ קודם'); }
  const [p, f] = edView.frac();
  readerOpen = true; hidePop();
  $('#reader').classList.add('on'); applySwitches();
  rdView.build();
  requestAnimationFrame(() => { rdView.goFrac(p, $('#edView').style.display === 'none' ? 0 : f); updateNavUI(); });
  $('#rSpeed').value = state.speed;
  const el = document.documentElement, fs = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fs) { try { const pr = fs.call(el); if (pr && pr.catch) pr.catch(() => {}); } catch {} }
  showBar(); $('#readerHint').classList.remove('hidden'); setTimeout(() => $('#readerHint').classList.add('hidden'), 7000);
}
function closeReader() {
  if (!readerOpen) return;
  const [p, f] = rdView.frac();
  stopPlay(); readerOpen = false; $('#reader').classList.remove('on');
  if (document.fullscreenElement) { try { document.exitFullscreen().catch(() => {}); } catch {} }
  rdView.root.textContent = ''; rdView.sheets = []; rdView.near.clear();
  if ($('#edView').style.display !== 'none') requestAnimationFrame(() => edView.goFrac(p, f));
}
function playLoop(ts) {
  if (!playing) return;
  const now = ts || performance.now(); if (!rLast) { rLast = now; rRaf = requestAnimationFrame(playLoop); return; }
  const dt = Math.min(0.1, (now - rLast) / 1000); rLast = now;
  const sc = playing.sc, before = sc.scrollTop;
  playing.acc = (playing.acc || 0) + (8 + state.speed * 2.2) * dt;
  const step = Math.floor(playing.acc); if (step >= 1) { sc.scrollTop = before + step; playing.acc -= step; }
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) return stopPlay();
  rRaf = requestAnimationFrame(playLoop);
}
function stopPlay() { playing = null; cancelAnimationFrame(rRaf); rLast = 0; $('#rPlay').textContent = '▶'; $('#btnPlay').textContent = '▶'; showBar(); }
function togglePlay() {
  if (playing) return stopPlay();
  if (!DOC) return toast('אין מסמך טעון');
  playing = activeView(); rLast = 0; $('#rPlay').textContent = '⏸'; $('#btnPlay').textContent = '⏸';
  rRaf = requestAnimationFrame(playLoop); showBar();
}
let barT = null;
function showBar() { $('#readerBar').classList.remove('hidden'); clearTimeout(barT); barT = setTimeout(() => { if (playing) $('#readerBar').classList.add('hidden'); }, 3200); }
$('#reader').addEventListener('mousemove', showBar);
$('#reader').addEventListener('touchstart', showBar, { passive: true });
$('#rPlay').onclick = togglePlay; $('#btnPlay').onclick = togglePlay;
$('#rSpeed').oninput = e => { state.speed = +e.target.value; $('#speed').value = state.speed; saveState(); };
$('#speed').oninput = e => { state.speed = +e.target.value; saveState(); };
$('#rExit').onclick = closeReader;
$('#rPrev').onclick = () => goPage(state.page - 1); $('#rNext').onclick = () => goPage(state.page + 1);
$('#btnPrev').onclick = () => goPage(state.page - 1); $('#btnNext').onclick = () => goPage(state.page + 1);
$('#rMark').onclick = () => setBookmark();
$('#rdView').addEventListener('dblclick', e => { const w = e.target.closest('.w'); if (w) { window.getSelection()?.removeAllRanges(); hidePop(); setBookmark({ p: +w.closest('.sheet').dataset.p, l: +w.closest('[data-l]').dataset.l, i: +w.dataset.i }); } });
$('#rFsizeUp').onclick = () => rdView.zoomBy(1.12); $('#rFsizeDn').onclick = () => rdView.zoomBy(1 / 1.12);
$('#btnReadMode').onclick = openReader; $('#navTele').onclick = openReader; $('#btnFull').onclick = openReader;
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && readerOpen) closeReader(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if ($('#libModal').style.display === 'flex') { closeLibrary(); return; } if ($('#guide').style.display === 'flex') { $('#guide').style.display = 'none'; return; } if (note.ref) return hideNotePop(); if (pop.ref) return hidePop(); if (readerOpen) closeReader(); return; }
  if (!readerOpen || e.metaKey || e.ctrlKey) return;
  const sc = rdView.sc;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === '+' || e.key === '=') rdView.zoomBy(1.1);
  else if (e.key === '-') rdView.zoomBy(1 / 1.1);
  else if (e.key === '0') rdView.setZoom(1);
  else if (e.key === 'ArrowDown') { e.preventDefault(); sc.scrollTop += 90; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sc.scrollTop -= 90; }
  else if (e.key === 'PageDown') { e.preventDefault(); sc.scrollTop += sc.clientHeight * 0.85; }
  else if (e.key === 'PageUp') { e.preventDefault(); sc.scrollTop -= sc.clientHeight * 0.85; }
  else if (e.key === 'ArrowLeft') goPage(state.page + 1);
  else if (e.key === 'ArrowRight') goPage(state.page - 1);
  else if (e.key === 'b' || e.key === 'B' || e.key === 'נ') setBookmark();
});
let rsT = null;
window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if (!DOC) return; activeView().keepPos(() => { edView.applyZoom(); rdView.applyZoom(); }); }, 120); });
$('#inputArea').addEventListener('input', saveState);

/* --------------------------------------------------------------------- init */
(async function init() {
  const st = lsGet(LSK.state, null);
  if (st) { Object.keys(state).forEach(k => { if (st[k] !== undefined && typeof st[k] === typeof state[k]) state[k] = st[k]; }); state.opts = { ...N.DEFAULT_OPTS, ...(st.opts || {}) }; }
  $('#inputArea').value = state.input || '';
  buildToggles(); updateDemo(); applySwitches();
  $('#lhRange').value = state.lh; $('#speed').value = state.speed;
  const d = DMAP[state.density] != null ? state.density : 'medium';
  state.density = d; const pct = [0, 50, 100][DMAP[d]];
  $('#densFill').style.width = pct + '%'; $('#densDot').style.right = pct + '%'; $('#densFill').style.right = '0'; $('#densFill').style.left = 'auto';
  document.querySelectorAll('#densStops span').forEach(s => s.classList.toggle('on', s.dataset.d === d));
  fetch('api/whoami').then(r => r.ok ? r.json() : null).then(j => { if (j && j.user) { $('#who').textContent = '👤 ' + j.user; $('#who').style.display = ''; } }).catch(() => {});
  LIB = (await idb.get('lib')) || [];
  const legacy = await idb.get('doc');
  if (legacy && legacy.pages) {
    if (!libEntry(legacy.uid)) { await idb.set('doc:' + legacy.uid, legacy); LIB.push({ uid: legacy.uid, key: keyOfDoc(legacy), name: legacy.name, title: '', kind: legacy.kind, count: legacy.count, added: Date.now(), opened: Date.now(), page: state.page }); await libSave(); }
    if (!state.cur) state.cur = legacy.uid;
    await idb.del('doc');
  }
  updateLibBtn();
  const ce = libEntry(state.cur), doc = ce ? await idb.get('doc:' + ce.uid) : null;
  if (doc && doc.kind === 'text' && doc.src && !$('#inputArea').value) $('#inputArea').value = doc.src;
  INIT = false;
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (DOC) refreshAll(); });
  if (doc && doc.pages && doc.pages.length) await setDoc(doc, { restored: true, tab: state.tab === 'orig' && doc.kind === 'pdf' ? 'narr' : state.tab, page: ce.page || state.page });
  else showTab('orig');
})();
