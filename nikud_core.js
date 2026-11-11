// נקדן לקריינים — לוגיקת הניקוד בצד הלקוח (טהורה, ללא DOM).
// The server returns, per word, the model's raw vocalization `v` (letters are never
// changed) which may carry three special marks:
//   U+05AB stress (on the stressed letter, only when the word is NOT stressed on its last syllable)
//   U+05BD vocal shva (a shva that is really pronounced "e")
//   U+05C7 kamatz katan (a kamatz pronounced "o")
// Everything shown on screen (grammatical / narrator / partial) is derived here.

export const SHVA='ְ', CHATAF_SEG='ֱ', CHATAF_PAT='ֲ', CHATAF_KAM='ֳ',
  HIRIQ='ִ', TSERE='ֵ', SEGOL='ֶ', PATACH='ַ', KAMATZ='ָ',
  HOLAM='ֹ', HOLAM_HASER='ֺ', KUBUTZ='ֻ', DAGESH='ּ', VOCAL='ֽ',
  RAFE='ֿ', SHIN='ׁ', SIN='ׂ', KATAN='ׇ', STRESS='֫';
export const VOWELS=new Set([CHATAF_SEG,CHATAF_PAT,CHATAF_KAM,HIRIQ,TSERE,SEGOL,PATACH,KAMATZ,HOLAM,HOLAM_HASER,KUBUTZ,KATAN]);
const BKP=new Set(['ב','כ','פ','ך','ף']);
const GUTTURAL='אהחער';

export const DEFAULT_OPTS={ unify_vowels:true, unify_a:false, shva_nach_remove:true, shva_na_segol:true,
  kamatz_katan:true, dagesh_bkp_only:true, stress_marks:true, initial_shva_na:false };

export const isLetter=c=>{ const o=c.codePointAt(0); return o>=0x05D0&&o<=0x05EA; };
export const isMark=c=>{ const o=c.codePointAt(0); return (o>=0x0591&&o<=0x05BD)||o===0x05BF||o===0x05C1||o===0x05C2||o===0x05C4||o===0x05C5||o===0x05C7; };
export const bare=s=>[...s].filter(isLetter).join('');
export const stripMarks=s=>[...s].filter(c=>!isMark(c)).join('');

export function units(s){ const u=[]; for(const c of s){ if(isLetter(c)) u.push([c,[]]); else if(isMark(c)&&u.length) u[u.length-1][1].push(c); } return u; }
export function render(us){
  let out='';
  for(const [c,marks] of us){
    out+=c;
    out+=marks.filter(m=>m===SHIN||m===SIN).join('')+marks.filter(m=>m===DAGESH).join('')
        +marks.filter(m=>m!==SHIN&&m!==SIN&&m!==DAGESH).join('');
  }
  return out;
}
const clone=us=>us.map(([c,m])=>[c,[...m]]);

/** standard (grammatical) nikud: drop the invented marks */
export function toFull(v){
  return render(units(v).map(([c,m])=>[c,m.filter(x=>x!==STRESS&&x!==VOCAL&&x!==RAFE).map(x=>x===KATAN?KAMATZ:x)]));
}
/** narrator ("phonetic") units */
export function narrUnits(v,opts){
  const o={...DEFAULT_OPTS,...(opts||{})};
  return units(v).map(([c,marks],k)=>{
    const vocal=marks.includes(VOCAL)||(k===0&&o.initial_shva_na);
    const out=[];
    for(const m of marks){
      if(m===STRESS||m===VOCAL||m===RAFE) continue;
      if(m===SHVA){ if(vocal) out.push(o.shva_na_segol?SEGOL:SHVA); else if(!o.shva_nach_remove) out.push(SHVA); }
      else if(m===KATAN) out.push(o.kamatz_katan?HOLAM:KAMATZ);
      else if(m===CHATAF_PAT) out.push(o.unify_vowels?PATACH:m);
      else if(m===CHATAF_SEG) out.push(o.unify_vowels?SEGOL:m);
      else if(m===CHATAF_KAM) out.push(HOLAM);
      else if(m===TSERE) out.push(o.unify_vowels?SEGOL:m);
      else if(m===HOLAM_HASER) out.push(HOLAM);
      else if(m===KAMATZ) out.push(o.unify_a?PATACH:KAMATZ);
      else if(m===DAGESH){ if(c==='ו'||!o.dagesh_bkp_only||BKP.has(c)) out.push(DAGESH); }
      else if(m===SHIN||m===SIN) out.push(m);
      else { const cp=m.codePointAt(0); if(cp>=0x0591&&cp<=0x05AF) continue; out.push(m); }
    }
    return [c,out];
  });
}
export const toNarr=(v,opts)=>render(narrUnits(v,opts));
export function stressIndex(v){ const u=units(v); for(let i=0;i<u.length;i++) if(u[i][1].includes(STRESS)) return i; return -1; }

/** why a word deserves the narrator's attention (empty list = not critical) */
export function reasons(v,pre){
  const u=units(v), r=[];
  if(u.some(([,m])=>m.includes(STRESS))) r.push('מלעיל — ההטעמה לא בהברה האחרונה');
  if(u.some(([,m])=>m.includes(KATAN))) r.push('קמץ קטן — נהגה O');
  if(u.some(([,m],k)=>k>=(pre||0)&&m.includes(VOCAL))) r.push('שווא נע — נהגה e');
  return r;
}
/** partial nikud for a non-critical word.
 *  level 'minimal': only the prefix letters (בֶּ/בַּ, לֶ/לַ, כֶּ/כַּ, וּ...) keep their nikud.
 *  level 'medium' : + dagesh in ב/כ/פ and the shin/sin dot on every letter. */
export function partial(v,opts,pre,level){
  const nu=narrUnits(v,opts);
  return render(nu.map(([c,m],k)=>{
    if(k<(pre||0)) return [c,m];
    if(level==='medium') return [c,m.filter(x=>x===SHIN||x===SIN||(x===DAGESH&&BKP.has(c)))];
    return [c,[]];
  }));
}

/** index of the prefix letter whose vowel changes the meaning (ב/כ/ל), or -1 */
export function prefixTarget(v,pre){
  const u=units(v);
  if(pre>0){ for(let i=Math.min(pre,u.length)-1;i>=0;i--) if('בכל'.includes(u[i][0])) return i; return -1; }
  return (u.length>=3&&'בכל'.includes(u[0][0]))?0:-1;
}
/** alternative readings of the prefix vowel: בְּ (in a…) / בַּ (in the…) / בִּ */
export function prefixVariants(v,pre){
  const u=units(v), k=prefixTarget(v,pre);
  if(k<0) return [];
  const L=u[k][0], next=u[k+1];
  const make=(vowel,defArticle)=>{
    const c=clone(u);
    const keep=c[k][1].filter(m=>m===DAGESH);
    if(k===0&&(L==='ב'||L==='כ')&&!keep.length) keep.push(DAGESH);
    c[k][1]=[...keep,...vowel];
    if(defArticle&&c[k+1]){
      const n=c[k+1];
      if(!n[1].includes(DAGESH)&&!GUTTURAL.includes(n[0])&&n[0]!=='ו') n[1].unshift(DAGESH);
    }
    return render(c);
  };
  const out=[];
  out.push({v:make([SHVA,VOCAL],false), tag:`${L}ְ — בלי יידוע`, hint:L==='ל'?'for / to a…':(L==='ב'?'in a…':'as a…')});
  const aVowel=(next&&'אער'.includes(next[0]))?[KAMATZ]:[PATACH];
  out.push({v:make(aVowel,true), tag:`${L}ַ — עם ה״א הידיעה`, hint:L==='ל'?'to the…':(L==='ב'?'in the…':'as the…')});
  if(next&&next[1].includes(SHVA)) out.push({v:make([HIRIQ],false), tag:`${L}ִ — לפני שווא`, hint:''});
  const seen=new Set();
  return out.filter(x=>{ if(seen.has(x.v)) return false; seen.add(x.v); return true; });
}

/** letter-level editing helpers (operate on raw `v`) */
export function setVowel(v,k,marks){
  const u=clone(units(v)); if(!u[k]) return v;
  u[k][1]=[...u[k][1].filter(m=>m===DAGESH||m===SHIN||m===SIN||m===STRESS),...marks];
  return render(u);
}
export function toggleMark(v,k,mark){
  const u=clone(units(v)); if(!u[k]) return v;
  if(mark===STRESS){ const had=u[k][1].includes(STRESS); u.forEach(x=>{ x[1]=x[1].filter(m=>m!==STRESS); }); if(!had) u[k][1].push(STRESS); }
  else if(mark===SHIN||mark===SIN){ u[k][1]=u[k][1].filter(m=>m!==SHIN&&m!==SIN); u[k][1].unshift(mark); }
  else if(u[k][1].includes(mark)) u[k][1]=u[k][1].filter(m=>m!==mark); else u[k][1].unshift(mark);
  return render(u);
}
