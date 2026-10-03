// ---------------------------------------------------------------------------
// PHASE 6 — NAVIGATION
// Quick open, goto symbol, goto line, references and the command palette all
// run off one fuzzy matcher and one workspace index.
// ---------------------------------------------------------------------------
const Fuzzy = {
  // subsequence match with a score: consecutive runs and word starts win
  match(needle, haystack){
    if(!needle) return { score:0, ranges:[] };
    const n = needle.toLowerCase(), h = String(haystack||"");
    const hl = h.toLowerCase();
    const direct = hl.indexOf(n);
    if(direct>=0){
      const ranges = [];
      for(let i=0;i<n.length;i++) ranges.push([direct+i, direct+i+1]);
      let s = 1000 - direct*2 + (direct===0?60:0);
      if(/[\s_\-\/.]/.test(h[direct-1]||" ")) s += 30;
      return { score:s, ranges };
    }
    let hi=0, score=0, streak=0; const ranges=[];
    for(let ni=0;ni<n.length;ni++){
      const c = n[ni];
      let found = -1;
      while(hi<hl.length){ if(hl[hi]===c){ found=hi; break; } hi++; }
      if(found<0) return null;
      const prev = h[found-1];
      const boundary = found===0 || /[\s_\-\/.([{]/.test(prev||" ");
      score += boundary ? 14 : 3;
      if(boundary && n[ni-1] !== " ") score += 12;
      if(ranges.length && ranges[ranges.length-1][1]===found) { streak++; score += 8+streak*3; ranges[ranges.length-1][1]=found+1; }
      else { streak=0; ranges.push([found, found+1]); }
      hi++;
    }
    score -= Math.floor(hl.length/6);
    return { score, ranges };
  },
  rank(query, items, keyFn){
    const out = [];
    for(const it of items){
      const text = keyFn(it);
      const m = this.match(query, text);
      if(!m) continue;
      out.push({ item:it, score:m.score, ranges:m.ranges });
    }
    out.sort((a,b)=> b.score-a.score);
    return out;
  },
  highlight(text, ranges){
    if(!ranges || !ranges.length) return esc(text);
    let out="", last=0;
    for(const [a,b] of ranges){
      out += esc(text.slice(last,a)) + '<b>' + esc(text.slice(a,b)) + "</b>";
      last=b;
    }
    return out + esc(text.slice(last));
  }
};

// ---- workspace symbol index, rebuilt lazily off mtimes
const StIndex = {
  cache: new Map(),
  key(path, node){ return path + ":" + (node.mtime||0); },
  // Always a record, never [] — every caller reads .syms or .words, and a bare
  // array for "no symbols here" made workspace symbols crash on any .json file
  emptyRec(path){ return { path, spec:null, lang:null, syms:[], words:new Map() }; },
  symbolsFor(path){
    const node = VFS.node(path);
    if(!node || node.type!=="file") return this.emptyRec(path);
    const k = this.key(path,node);
    if(this.cache.has(k)) return this.cache.get(k);
    if(node.size>900000) return this.emptyRec(path);
    const spec = LANG.forPath(path, node.content);
    if(["plain","csv","log","json"].includes(spec.id)) return this.emptyRec(path);
    let syms = [];
    try{ syms = SYMBOLS.extract(node.content||"", spec); }catch(e){ syms=[]; }
    const rec = { path, spec:spec.id, lang:spec.name, syms, words:wordIndex(node.content||"") };
    this.cache.set(k, rec);
    if(this.cache.size>600) this.cache.delete(this.cache.keys().next().value);
    return rec;
  },
  files(root){
    const out=[];
    VFS.walk(root, (p,n)=>{ if(n.type==="file") out.push(p); });
    return out;
  },
  // quick open: names first, then word hits in the file
  quickOpen(root, q, limit){
    limit = limit || 40;
    const files = this.files(root).filter(p=>{
      const t = LANG.forPath(p);
      return !["csv","log","plain","key"].includes(t.id);
    });
    if(!q) return files.slice(0,limit).map(p=>({ path:p, kind:"file" }));
    const byName = Fuzzy.rank(q, files, p=>VFS.base(p)).slice(0,limit);
    const seen = new Set(byName.map(x=>x.item));
    const out = byName.map(x=>({ path:x.item, kind:"file", ranges:Fuzzy.match(q, VFS.base(x.item))?.ranges }));
    if(out.length<limit){
      const word = q.toLowerCase();
      const hits = [];
      for(const p of files){
        if(seen.has(p)) continue;
        const rec = this.symbolsFor(p);
        if(rec.words && (rec.words.has(word) || [...rec.words].some(w=> w.length>2 && word.length>2 && w.startsWith(word))))
          hits.push({ path:p, kind:"file", why:"contains “"+q+"”" });
      }
      out.push(...hits.slice(0, limit-out.length));
    }
    return out;
  },
  symbolSearch(root, q, limit){
    limit = limit || 60;
    const out = [];
    for(const p of this.files(root)){
      const rec = this.symbolsFor(p);
      for(const s of rec.syms){
        if(!q || s.name.toLowerCase().includes(q.toLowerCase())){
          out.push({ path:p, name:s.name, kind:s.kind, line:s.line, container:s.container, lang:rec.lang });
        }
        if(out.length>=limit*3) break;
      }
    }
    if(q) out.sort((a,b)=>{
      const sa=a.name.toLowerCase().includes(q.toLowerCase())?0:1;
      const sb=b.name.toLowerCase().includes(q.toLowerCase())?0:1;
      return sa-sb || (a.path+a.name).localeCompare(b.path+b.name);
    });
    return out.slice(0,limit);
  },
  references(root, name, excludePath){
    const out = [];
    for(const p of this.files(root)){
      if(excludePath && p===excludePath){ /* still included: references inside the file matter */ }
      const node = VFS.node(p);
      if(!node || node.type!=="file" || node.size>900000) continue;
      const re = new RegExp("\\b"+String(name).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g");
      const content = node.content||"";
      if(!re.test(content)) continue;
      re.lastIndex = 0;
      const starts = SYMBOLS.lineStarts(content);
      let m, guard=0;
      while((m = re.exec(content)) && guard++<400){
        out.push({ path:p, line:SYMBOLS.lineOf(starts,m.index), col:m.index-starts[SYMBOLS.lineOf(starts,m.index)], len:name.length });
      }
    }
    return out;
  },
  invalidate(path){ if(path) this.cache.clear(); }
};
function wordIndex(text){
  const s = new Set();
  const re = /[A-Za-z_$][\w$]{2,}/g; let m, guard=0;
  while((m = re.exec(String(text||""))) && guard++<4000) s.add(m[0].toLowerCase());
  return s;
}

// ---- the palette: one widget, two modes ----------------------------------
// One Studio modal at a time. Every dialog and the palette funnel through this
// so a second surface can never stack on top of the first and trap the UI
// behind it. Returns a detached node — callers keep their own appendChild.
function stModal(){
  document.querySelectorAll(".st2-modal").forEach(n=>n.remove());
  if(typeof StPalette!=="undefined" && StPalette) StPalette.node = null;
  return el("div","st2-modal");
}

const StPalette = {
  node:null,
  open({title, placeholder, items, render, onPick, tag, footer, quick, onCancel}){
    this.close();
    const back = stModal();
    back.innerHTML = `<div class="st2-pal">
      <div class="st2-pal-in"><span class="tag">${esc(tag||"")}</span>
        <input placeholder="${esc(placeholder||"")}" spellcheck="false"><span class="tag">esc</span></div>
      <div class="st2-pal-list" data-r="list"></div>
      <div class="st2-pal-f">${footer || "<b>↑↓</b> move · <b>enter</b> open · <b>esc</b> dismiss"}</div></div>`;
    document.body.appendChild(back);
    this.node = back;
    const input = back.querySelector("input");
    const list = back.querySelector('[data-r="list"]');
    const self = this;
    let rows = items, sel = 0, live = items;

    const draw = ()=>{
      if(!rows.length){ list.innerHTML = '<div class="st2-empty" style="padding:14px">No matches</div>'; return; }
      list.innerHTML = rows.map((it,i)=> render(it,i===sel)).join("");
      const on = list.querySelector(".st2-pal-i.on");
      if(on) on.scrollIntoView({block:"nearest"});
    };
    const pick = i => { const it = rows[i]; if(!it) return; self.close(); onPick(it); };

    input.addEventListener("input", ()=>{
      const v = input.value;
      live = items;
      rows = v ? quick(v, items) : items;
      sel = 0; draw();
    });
    input.addEventListener("keydown", e=>{
      if(e.key==="ArrowDown"){ e.preventDefault(); sel=Math.min(sel+1, rows.length-1); draw(); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); sel=Math.max(sel-1,0); draw(); }
      else if(e.key==="Enter"){ e.preventDefault(); pick(sel); }
      else if(e.key==="Escape"){ e.preventDefault(); self.close(); if(onCancel) onCancel(); }
      else if(e.key==="Tab"){ e.preventDefault(); }
      e.stopPropagation();
    });
    list.addEventListener("mousedown", e=>{
      const r = e.target.closest("[data-i]");
      if(r){ e.preventDefault(); pick(+r.dataset.i); }
    });
    back.addEventListener("mousedown", e=>{ if(e.target===back){ self.close(); if(onCancel) onCancel(); } });
    draw();
    setTimeout(()=>input.focus(), 10);
    return { close:()=>self.close() };
  },
  close(){ if(this.node){ this.node.remove(); this.node=null; } }
};