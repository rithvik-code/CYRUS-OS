// ---------------------------------------------------------------------------
// PHASE 1 — THE EDITOR
// A transparent <textarea> owns text, selection and clipboard. A highlighted
// <div> underneath owns every visual: tokens, cursors, ghosts, folds, findings.
// That split is what makes real multi-cursor, bracket highlighting and
// selection-aware AI possible in a single HTML file.
// ---------------------------------------------------------------------------
const CW = 7.5, LH = 20, PADL = 12, PADT = 10;

class StEditor {
  constructor(host, opts){
    this.host = host;
    this.on = opts.on || {};
    this.content = "";
    this.sel = [{s:0,e:0}];
    this.problems = [];
    this.folds = [];
    this.collapsed = new Set();
    this.spec = LANG.forPath("x.txt");
    this.path = "";
    this.find = null;
    this.ghost = null;
    this.occWord = null;
    this.undoStack = [];
    this.redoStack = [];
    this._coalesce = null;
    this._mctx = document.createElement("canvas").getContext("2d");

    host.innerHTML = `
      <div class="st2-gutter" data-r="gut"></div>
      <div class="st2-scroll" data-r="scroll">
        <div class="st2-layer">
          <div class="st2-hl" data-r="hl"></div>
          <textarea class="st2-ta" data-r="ta" spellcheck="false" autocomplete="off"
            autocapitalize="off" wrap="off" autocorrect="off"></textarea>
        </div>
      </div>
      <div class="st2-mm" data-r="mm"><canvas data-r="mmc"></canvas><div class="vp" data-r="mmv"></div><div class="cur" data-r="mmc2"></div></div>`;
    this.gut = host.querySelector('[data-r="gut"]');
    this.scroll = host.querySelector('[data-r="scroll"]');
    this.hl = host.querySelector('[data-r="hl"]');
    this.ta = host.querySelector('[data-r="ta"]');
    this.mm = host.querySelector('[data-r="mm"]');
    this.mmc = host.querySelector('[data-r="mmc"]');
    this.mmv = host.querySelector('[data-r="mmv"]');
    this.mmc2 = host.querySelector('[data-r="mmc2"]');
    this.curLayer = el("div","cur-layer");
    this.hl.appendChild(this.curLayer);

    this.ta.style.height = "1px";
    this._taEvent();
    this._measure();
  }

  _measure(){
    const cs = getComputedStyle(this.ta);
    if(!this._mctx) this._mctx = document.createElement("canvas").getContext("2d");
    this._mctx.font = cs.fontSize + " " + cs.fontFamily;
    const m = this._mctx.measureText("M");
    this.cw = m.width || CW;
    this.lh = parseFloat(cs.lineHeight) || LH;
  }

  // ---- public surface ---------------------------------------------------
  setFile(path, content, spec){
    this.path = path;
    this.spec = spec || LANG.forPath(path, content);
    this.content = content || "";
    this.sel = [{s:this.content.length, e:this.content.length}];
    this.collapsed = new Set();
    this.problems = [];
    this.undoStack = []; this.redoStack = [];
    this._syncTA(); this.render();
  }
  setContent(t, keepSel){
    this.content = t;
    if(!keepSel) this.sel = [{s:0,e:0}];
    else this.sel = this.sel.map(c=>({ s:Math.min(c.s,t.length), e:Math.min(Math.max(c.e,c.s),t.length) })).filter((c,i,a)=> i===0 || true);
    this._syncTA(); this.render();
  }
  get text(){ return this.content; }

  setProblems(list){
    this.problems = list || [];
    this.render();
    if(this.on.problems) this.on.problems(this.problems);
  }
  setGhost(g){ this.ghost = g; this.render(); }
  clearGhost(){ if(this.ghost){ this.ghost = null; this.render(); } }

  focus(){ try{ this.ta.focus({preventScroll:true}); }catch(e){ this.ta.focus(); } }

  // ---- selection plumbing ----------------------------------------------
  get primary(){ return this.sel[0]; }
  setSelection(s,e,extend){
    const a = Math.max(0, Math.min(s,this.content.length));
    const b = Math.max(0, Math.min(e,this.content.length));
    if(extend && this.sel.length){
      const p = this.sel[0];
      this.sel[0] = { s: Math.min(p.s,a), e: Math.max(p.e,b) };
    } else {
      this.sel[0] = { s:a, e:b };
    }
    this._syncTA(); this.render();
    if(this.on.cursor) this.on.cursor(this.sel[0]);
  }
  setSelections(list){
    this.sel = list.map(c=>({ s:Math.max(0,Math.min(c.s,this.content.length)),
                              e:Math.max(0,Math.min(c.e,this.content.length)) })).sort((a,b)=>a.s-b.s);
    if(!this.sel.length) this.sel=[{s:0,e:0}];
    this._syncTA(); this.render();
  }
  _syncTA(){
    const p = this.primary;
    this.ta.value = this.content;
    try{ this.ta.setSelectionRange(p.s, p.e); }catch(e){}
  }
  _fromTA(){
    this.sel[0] = { s:this.ta.selectionStart, e:this.ta.selectionEnd };
    if(this.on.cursor) this.on.cursor(this.sel[0]);
  }

  // ---- coordinates ------------------------------------------------------
  lineOf(pos){ return SYMBOLS.lineOf(SYMBOLS.lineStarts(this.content), pos); }
  lineStart(i){ const s = SYMBOLS.lineStarts(this.content); return s[i]!==undefined ? s[i] : this.content.length; }
  lineEnd(i){ const s = SYMBOLS.lineStarts(this.content); return s[i+1]!==undefined ? s[i+1]-1 : this.content.length; }
  posAt(line, col){ return this.lineStart(line) + col; }
  charAt(pos){ return this.content[pos]; }
  get caret(){ const p=this.primary; return p.s===p.e ? p.s : p.e; }
  lineText(i){ return this.content.slice(this.lineStart(i), this.lineEnd(i)); }
  lineCount(){ return SYMBOLS.lineStarts(this.content).length; }

  wordRangeAt(pos){
    const c = this.content;
    const isW = ch => /[A-Za-z0-9_$]/.test(ch);
    if(pos>c.length) return {s:0,e:0};
    let a = pos, b = pos;
    if(!isW(c[pos]) && isW(c[pos-1])) a = pos-1;
    else if(!isW(c[pos]) && !isW(c[pos-1])) return {s:pos,e:pos};
    while(a>0 && isW(c[a-1])) a--;
    while(b<c.length && isW(c[b])) b++;
    return {s:a,e:b};
  }
  get wordAtCaret(){
    const p = this.primary;
    const r = (p.s===p.e) ? this.wordRangeAt(p.s) : p;
    return this.content.slice(r.s, r.e);
  }

  // ---- undo -------------------------------------------------------------
  snapshot(){
    this.undoStack.push({ text:this.content, sel:JSON.parse(JSON.stringify(this.sel)) });
    if(this.undoStack.length>250) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo(){
    if(!this.undoStack.length) return;
    const s = this.undoStack.pop();
    this.redoStack.push({ text:this.content, sel:JSON.parse(JSON.stringify(this.sel)) });
    this.content = s.text; this.sel = s.sel;
    this._syncTA(); this.render();
    if(this.on.change) this.on.change(this.content, "undo");
  }
  redo(){
    if(!this.redoStack.length) return;
    const s = this.redoStack.pop();
    this.undoStack.push({ text:this.content, sel:JSON.parse(JSON.stringify(this.sel)) });
    this.content = s.text; this.sel = s.sel;
    this._syncTA(); this.render();
    if(this.on.change) this.on.change(this.content, "redo");
  }

  // ---- edits ------------------------------------------------------------
  // Applies fn to the text, then moves each cursor by the returned delta map.
  apply(fn, opts={}){
    this.snapshot();
    const before = this.content;
    const res = fn(this.content);
    const after = typeof res === "string" ? res : (res && res.text) || before;
    this.content = after;
    if(res && res.sel) this.sel = res.sel;
    else this.sel = this.sel.map(c=>({ s:clamp(c.s,0,after.length), e:clamp(c.e,0,after.length) }));
    this._syncTA(); this.render();
    if(!opts.silent && this.on.change) this.on.change(this.content, opts.kind||"edit");
    return true;
  }
  insert(text, opts={}){
    if(!text) return;
    return this.apply(t=>{
      const sel = JSON.parse(JSON.stringify(this.sel));
      let out = "", last = 0;
      sel.forEach((c,i)=>{
        const isLast = i===sel.length-1;
        out += t.slice(last, c.s);
        out += text;
        if(c.s!==c.e && opts.wrap!==false && text.length===1) { /* handled by caller */ }
        if(isLast){ out += t.slice(c.s, c.e); last = c.e; }
      });
      out += t.slice(last);
      const newSel = sel.map(c=>({ s:c.s+text.length, e:c.s+text.length }));
      // if a selection was replaced, collapse into it
      sel.forEach((c,i)=>{ if(c.s!==c.e) newSel[i] = { s:c.s+text.length, e:c.s+text.length }; });
      return { text:out, sel:newSel };
    }, opts);
  }
  wrap(before, after){
    const p = this.primary;
    const s = this.content.slice(p.s,p.e) || (this.on.surroundDefault ? this.on.surroundDefault : "");
    this.apply(()=> this.content.slice(0,p.s)+before+s+after+this.content.slice(p.e), {kind:"wrap"});
    this.setSelection(p.s+before.length, p.s+before.length+s.length);
  }
  delChars(dir){
    return this.apply(()=>{
      let out = "", last = 0;
      const sel = JSON.parse(JSON.stringify(this.sel));
      sel.forEach(c=>{
        out += this.content.slice(last, c.s);
        if(c.s===c.e){ const i = dir<0 ? c.s-1 : c.s; if(i>=0 && i<this.content.length){ last = i+1; return; } }
        last = Math.max(last, c.e);
      });
      out += this.content.slice(last);
      const newSel = sel.map(c=>{
        if(c.s===c.e) return { s:Math.max(0,c.s+(dir<0?0:0)), e:Math.max(0,c.s+(dir<0?0:0)) };
        return { s:Math.min(c.s,out.length), e:Math.min(c.s,out.length) };
      });
      return { text:out, sel:newSel };
    }, {kind:"delete"});
  }

  // ---- render -----------------------------------------------------------
  render(){
    const deco = {
      problems: this.problems,
      matches: this.find ? this.find.matches : null,
      sel2: this.sel.filter((c,i)=> i>0 && c.s!==c.e),
      folded: this.foldedMarks(),
      occWord: this.occWordMarks()
    };
    // wrap ghost text into the renderer via a dedicated path
    let html;
    if(this.ghost && this.ghost.text){
      html = HL.render(this.content, this.spec, Object.assign({}, deco, {ghost:this.ghost}));
    } else {
      html = HL.render(this.content, this.spec, deco);
    }
    // folded regions hide their text
    html = html + "";
    this.hl.innerHTML = html;
    this._renderCursors();
    this._renderGutter();
    this._sizeLayer();
    this._renderMinimap();
    if(this.on.render) this.on.render();
  }

  foldedMarks(){
    const marks = [];
    const starts = SYMBOLS.lineStarts(this.content);
    for(const key of this.collapsed){
      const f = this.folds.find(x=>x.id===key);
      if(!f) continue;
      const s = starts[f.from+1];
      const e = starts[f.to]!==undefined ? starts[f.to]-1 : this.content.length;
      if(e>s) marks.push({ s, e, c:"fold" });
    }
    return marks;
  }
  occWordMarks(){
    const w = this.wordAtCaret;
    if(!w || w.length<2) return [];
    if(this.sel.length>1) return this.sel.slice(1).map(c=>({ s:c.s, e:c.e }));
    return [];
  }

  _renderCursors(){
    const c = this.curLayer;
    c.innerHTML = "";
    if(document.activeElement !== this.ta) return;
    const parts = [];
    this.sel.forEach((s2,i)=>{
      if(s2.s===s2.e && i>0){
        const p = this._xy(s2.s);
        parts.push(`<div class="mc" style="left:${p.x}px;top:${p.y}px"></div>`);
      } else if(s2.s===s2.e && i===0){
        // primary caret is the real one
      } else {
        const a = this._xy(s2.s), b = this._xy(s2.e);
        parts.push(`<div class="mc" style="left:${a.x}px;top:${a.y}px;width:${Math.max(2,b.x-a.x)}px"></div>`);
      }
    });
    c.innerHTML = parts.join("");
    const w = this.wordAtCaret;
    this.occWord = null;
    if(w && w.length>1 && this.sel.length===1 && this.sel[0].s===this.sel[0].e){
      const re = new RegExp("\\b"+w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g");
      let m, guard=0, first=true;
      const hits=[];
      while((m=re.exec(this.content)) && guard++<600){
        if(m.index>=this.caret){ first=false; break; }
        hits.push(m);
      }
      first = true;
      const marks = [];
      if(hits.length && (this.caret - hits[hits.length-1].index) < 60)
        marks.push({ s:hits[hits.length-1].index, e:hits[hits.length-1].index + w.length });
      if(marks.length){
        const p = this._xy(marks[0].s);
        parts.push(`<div class="mc sel" style="left:${p.x}px;top:${p.y}px"></div>`);
        c.innerHTML = parts.join("");
      }
    }
  }
  _xy(pos){
    const ls = SYMBOLS.lineStarts(this.content);
    const l = SYMBOLS.lineOf(ls, Math.max(0,Math.min(pos,this.content.length)));
    const col = Math.max(0,pos - ls[l]);
    return { x: PADL + col*this.cw, y: PADT + l*this.lh, line:l, col };
  }

  _renderGutter(){
    const total = this.lineCount();
    const visible = Math.max(1, Math.ceil(this.scroll.clientHeight / this.lh) + 1);
    const first = Math.max(0, Math.floor(this.scroll.scrollTop / this.lh));
    const curLine = this.lineOf(this.caret);
    const errL = new Set(), warnL = new Set();
    for(const p of this.problems){
      if(p.sev==="err") errL.add(p.line); else if(p.sev==="warn") warnL.add(p.line);
    }
    let html = "";
    for(let i=first;i<Math.min(total, first+visible+2);i++){
      const cls = i===curLine ? "ln cur" : errL.has(i) ? "ln err" : warnL.has(i) ? "ln warn" : "ln";
      const f = this.foldStartAt(i);
      html += `<div class="${cls}">${f?`<span class="gl" data-fold="${f.id}">${this.collapsed.has(f.id)?"▸":"▾"}</span>`:""}${i+1}</div>`;
    }
    this.gut.innerHTML = html;
    this.gut.style.paddingTop = PADT + "px";
  }
  foldStartAt(line){
    return this.folds.find(f=>f.from===line && !this.collapsed.has(f.id));
  }

  _sizeLayer(){
    const lines = this.lineCount();
    const maxCol = this.content.split("\n").reduce((m,l)=> Math.max(m,l.length), 0);
    const h = PADT*2 + lines*this.lh;
    const w = PADL + Math.max(40, maxCol+6) * this.cw + 40;
    this.ta.style.height = h + "px";
    this.ta.style.width = w + "px";
    const layer = this.scroll.querySelector(".st2-layer");
    if(layer){ layer.style.height = h + "px"; layer.style.width = w + "px"; }
  }

  scrollTo(offset){
    const p = this._xy(offset);
    const st = this.scroll;
    if(p.y < st.scrollTop+40) st.scrollTop = Math.max(0, p.y-60);
    else if(p.y > st.scrollTop + st.clientHeight - 40) st.scrollTop = p.y - st.clientHeight + 60;
    if(p.x > st.scrollLeft + st.clientWidth - 60) st.scrollLeft = Math.max(0, p.x - st.clientWidth/2);
  }
  revealLine(line){
    const y = PADT + line*this.lh;
    const st = this.scroll;
    if(y < st.scrollTop) st.scrollTop = Math.max(0, y-40);
    else if(y > st.scrollTop + st.clientHeight - this.lh) st.scrollTop = y - st.clientHeight + this.lh + 40;
  }
  xyToOffset(clientX, clientY){
    const r = this.scroll.getBoundingClientRect();
    const x = clientX - r.left + this.scroll.scrollLeft - PADL;
    const y = clientY - r.top + this.scroll.scrollTop - PADT;
    const line = Math.max(0, Math.floor(y / this.lh));
    const col = Math.max(0, Math.round(x / this.cw));
    return { line, col, pos: Math.min(this.content.length, this.posAt(line, col)) };
  }
}// ---- Phase 1b: events, keymap, folding, find/replace, minimap
const clamp = (v,a,b)=> v<a?a:v>b?b:v;

Object.assign(StEditor.prototype, {

  // ================= textarea wiring =================
  _taEvent(){
    const ta = this.ta;
    this._lastValue = "";
    ta.addEventListener("input", ()=>this._onInput());
    ta.addEventListener("keydown", e=>this._onKey(e));
    ta.addEventListener("click", ()=>{ this._fromTA(); this.render(); });
    ta.addEventListener("select", ()=>{ this._fromTA(); this.render(); });
    ta.addEventListener("scroll", ()=>{ this._renderMinimap(); });
    this.scroll.addEventListener("scroll", ()=>{ this._renderMinimap(); });
    this.mm.addEventListener("click", e=>{
      const r = this.mm.getBoundingClientRect();
      const line = Math.floor((e.clientY - r.top) / 2);
      this.setSelection(this.posAt(line,0), this.lineEnd(line));
      this.focus();
    });
    this.gut.addEventListener("click", e=>{
      const f = e.target.closest("[data-fold]");
      if(f){ this.toggleFold(f.dataset.fold); return; }
      const ln = e.target.closest(".ln");
      if(ln){
        const idx = [...this.gut.querySelectorAll(".ln")].indexOf(ln);
        const line = Math.floor(this.scroll.scrollTop/this.lh) + idx;
        this.setSelection(this.posAt(line,0), this.lineEnd(line));
        this.focus();
      }
    });
  },

  _onInput(){
    const nv = this.ta.value, ov = this._lastValue;
    if(this.sel.length>1 && ov!=null && nv!==ov){
      let p=0; const max=Math.min(ov.length,nv.length);
      while(p<max && ov[p]===nv[p]) p++;
      let q=0; while(q<max-p && ov[ov.length-1-q]===nv[nv.length-1-q]) q++;
      const inserted = nv.slice(p, nv.length-q);
      const oldP = this._preSel0 || this.sel[0];
      // replicate the same edit at every secondary cursor (back to front)
      let out = "";
      let text = this.content;
      for(let i=this.sel.length-1;i>=1;i--){
        const c = this.sel[i];
        text = text.slice(0,c.s) + inserted + text.slice(c.s);
        if(c.s===c.e) this.sel[i] = { s:c.s, e:c.s };
        else if(c.s===oldP.s && c.e===oldP.e) this.sel[i] = { s:c.s+inserted.length, e:c.s+inserted.length };
        else this.sel[i] = { s:c.s, e:c.e+inserted.length };
      }
      this.content = text;
      this._syncTA(); this.render();
      if(this.on.change) this.on.change(this.content, "input");
      return;
    }
    this.content = nv;
    this.sel[0] = { s:ta0(this.ta).s, e:ta0(this.ta).e };
    this.render();
    if(this.on.change) this.on.change(this.content, "input");
  },

  // ================= keymap =================
  _onKey(e){
    const ta = this.ta;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const lc = k.length===1 ? k.toLowerCase() : k;
    this._preSel0 = { s:ta.selectionStart, e:ta.selectionEnd };

    // ---- history
    if(mod && lc==="z" && !e.shiftKey){ e.preventDefault(); this.undo(); return; }
    if((mod && lc==="y") || (mod && e.shiftKey && lc==="z")){ e.preventDefault(); this.redo(); return; }
    if(mod && lc==="a"){ e.preventDefault(); this.setSelections([{s:0,e:this.content.length}]); return; }

    // ---- hand off to the app
    if(mod && ["s","f","h","p","b","g",",","/"].indexOf(lc)>=0 && !(lc==="/" && !e.shiftKey && false)){
      if(lc==="/" && !e.shiftKey){ /* our comment toggle */ }
      else if(this.on.key){ this.on.key(lc, e); }
      e.preventDefault(); return;
    }
    if(e.shiftKey && mod && lc==="p"){ if(this.on.key) this.on.key("shiftp", e); e.preventDefault(); return; }
    if(mod && k==="P" && e.shiftKey){ if(this.on.key) this.on.key("shiftp", e); e.preventDefault(); return; }
    if(mod && e.shiftKey && lc==="e"){ e.preventDefault(); this.selectAllOccurrences(); return; }
    if(mod && e.shiftKey && lc==="l"){ e.preventDefault(); this.selectLine(); return; }
    if(e.shiftKey && e.altKey && lc==="f"){ e.preventDefault(); this.format(); return; }

    // ---- multi-cursor
    if(mod && e.altKey && (k==="ArrowUp"||k==="ArrowDown")){ e.preventDefault(); this.addCursorVert(k==="ArrowUp"?-1:1); return; }
    if(mod && k==="d" && !e.shiftKey){ e.preventDefault(); this.addNextOccurrence(); return; }
    if(k==="Escape"){ if(this.sel.length>1){ e.preventDefault(); this.setSelections([this.primary]); } return; }

    if(mod && e.shiftKey && lc==="k"){ e.preventDefault(); this.deleteLines(); return; }
    if(e.altKey && !e.ctrlKey && (k==="ArrowUp"||k==="ArrowDown") && !e.shiftKey){ e.preventDefault(); this.moveLines(k==="ArrowUp"?-1:1); return; }
    if(e.shiftKey && e.altKey && (k==="ArrowDown"||k==="ArrowUp")){ e.preventDefault(); this.duplicateLines(k==="ArrowDown"?1:-1); return; }
    if(mod && lc==="/"){ e.preventDefault(); this.toggleComment(); return; }
    if(mod && (k==="]"||k==="[")){ e.preventDefault(); this.indentSelection(k==="]" ? 1 : -1); return; }

    // ---- tabs
    if(k==="Tab"){
      // a pending inline suggestion wins over indentation
      if(!e.shiftKey && this.ghost && this.ghost.text && this.on.acceptGhost && this.on.acceptGhost()) return;
      e.preventDefault();
      if(e.shiftKey) this.outdent();
      else {
        const multi = this.sel.some(c=>this.content.slice(c.s,c.e).indexOf("\n")>=0);
        if(multi) this.indentSelection(1);
        else this.insert(this.spec.indent===4 ? "    " : "  ");
      }
      return;
    }

    // ---- newline
    if(k==="Enter" && !mod && !e.altKey){
      e.preventDefault(); this.smartEnter(); return;
    }

    // ---- auto close / skip
    if(k.length===1 && !mod && !e.altKey && this.spec.pairs[k]){
      e.preventDefault();
      const p = this.primary;
      if(p.s!==p.e){ this.wrap(k, this.spec.pairs[k]); return; }
      const next = this.content[p.s];
      const prev = this.content[p.s-1];
      const wrapSel = /[\w"'`]/.test(next||"") && !/[\s(]/.test(prev||"");
      this.insert(k + (wrapSel ? this.spec.pairs[k] : ""));
      this.setSelection(p.s+1, p.s+1);
      return;
    }
    if(k.length===1 && !mod && /[\)\]\}]/.test(k)){
      if(this.primary.s===this.primary.e && this.content[this.primary.s]===k && !this.sel.some(c=>c.s!==c.e)){
        e.preventDefault(); this.setSelection(this.primary.s+1, this.primary.s+1); return;
      }
    }
    if(k.length===1 && /["'`]/.test(k) && !mod && this.primary.s===this.primary.e &&
       this.content[this.primary.s]===k && this.spec.esc){
      e.preventDefault(); this.setSelection(this.primary.s+1, this.primary.s+1); return;
    }

    // ---- smart home / end
    if(k==="Home" && !mod && !e.shiftKey){ e.preventDefault(); this.smartHome(e.altKey); return; }
    if(k==="End"  && !mod && !e.shiftKey){ e.preventDefault(); this.setSelection(this.lineEnd(this.lineOf(this.caret)), this.lineEnd(this.lineOf(this.caret))); return; }

    // ---- backspace / delete with several cursors
    if((k==="Backspace"||k==="Delete") && this.sel.length>1){
      e.preventDefault();
      if(this.sel.some(c=>c.s!==c.e)){ this.apply(()=>{
        let out="",last=0;
        this.sel.forEach(c=>{ out+=this.content.slice(last,c.s); last=Math.max(last,c.e); });
        out+=this.content.slice(last);
        const m=out.length; return { text:out, sel:[{s:m,e:m}] };
      }, {kind:"delete"}); }
      else this.delChars(k==="Backspace"?-1:1);
      return;
    }
    if(k==="Backspace" && !mod){
      const p=this.primary;
      if(p.s===p.e && p.s>0){
        const before = this.content.slice(0,p.s);
        if(/^\s+$/.test(this.content.slice(p.s, this.lineEnd(this.lineOf(p.s)))) === false && /[ \t]{2,}$/.test(before) && !/^\s*$/.test(before)){
          const ind = this.currentIndent();
          if(before.length - before.replace(/[ \t]+$/,"").length >= ind){ e.preventDefault(); this.backspaceIndent(); return; }
        }
        const w = this.wordRangeAt(p.s-1);
        if(p.s-1 >= w.s && w.s < p.s-1 && /[A-Za-z0-9_$]/.test(this.content[p.s-1]) && /[A-Za-z0-9_$]/.test(this.content[w.s])){
          e.preventDefault(); this.setSelection(w.s,p.s); this.delChars(-1); return;
        }
      }
    }

    // bracket matching highlight follows the caret
    if(k==="ArrowLeft"||k==="ArrowRight"||k==="ArrowUp"||k==="ArrowDown"||k==="Backspace"||k==="Delete"){
      setTimeout(()=>{ this._fromTA(); this.sel.length>1?this.sel[0]=this.primary:null; this.render(); },0);
    }
  },

  // ================= line operations =================
  currentIndent(){
    const line = this.lineText(this.lineOf(this.caret));
    const m = /^[ \t]*/.exec(line)[0];
    const unit = this.spec.indent===4 ? "    " : "  ";
    return m.includes("\t") ? "\t" : unit;
  },
  lineRangeOf(pos){
    const l = this.lineOf(pos);
    return { from:l, to:l };
  },
  blockRange(){
    let a=Infinity, b=-Infinity;
    this.sel.forEach(c=>{
      const l1=this.lineOf(c.s), l2=this.lineOf(c.e);
      a=Math.min(a,l1); b=Math.max(b,l2);
    });
    if(!isFinite(a)){ const l=this.lineOf(this.caret); a=b=l; }
    return { from:a, to:b };
  },
  indentSelection(dir){
    const {from,to} = this.blockRange();
    const unit = this.spec.indent===4 ? "    " : "  ";
    let deltaTotal = 0; const deltas = [];
    const lines = this.content.split("\n");
    for(let i=from;i<=to;i++){
      if(dir>0){ deltas.push(unit.length); deltaTotal += unit.length; }
      else {
        const m = /^[ \t]+/.exec(lines[i]||"");
        const rm = m ? m[0].replace(/ {1,2}$/,"") : "";
        deltas.push(-(m?m[0].length:0) + rm.length);
        deltaTotal += deltas[i-from];
      }
    }
    this.snapshot();
    const fix = l => {
      const m = /^[ \t]+/.exec(l);
      if(!m) return l;
      const target = Math.max(0, m[0].length - this.spec.indent);
      return " ".repeat(Math.min(target, m[0].length)) + l.slice(m[0].length).replace(/^ +/,"");
    };
    const out2 = lines.map((l,i)=> (i<from||i>to) ? l : (dir>0 ? unit+l : fix(l))).join("\n");
    let acc = 0;
    const newSel = this.sel.map(c=>{
      const before = this.lineOf(c.s);
      const shift = before>from ? (before<=to ? deltas[before-from]||0 : 0) : 0;
      return { s:c.s+shift, e:c.e+shift };
    });
    this.content = out2; this.sel = newSel;
    this._syncTA(); this.render();
    if(this.on.change) this.on.change(this.content, "indent");
  },
  outdent(){ this.indentSelection(-1); },
  backspaceIndent(){
    const l = this.lineOf(this.caret);
    const lines = this.content.split("\n");
    const ind = this.spec.indent;
    const cur = /^[ \t]*/.exec(lines[l])[0].length;
    const rm = Math.min(ind, cur);
    lines[l] = lines[l].slice(rm);
    const pos = this.posAt(l, Math.max(0, this.primary.s - this.lineStart(l) - rm));
    this.snapshot();
    this.content = lines.join("\n");
    this.setSelection(pos,pos);
    if(this.on.change) this.on.change(this.content, "delete");
  },
  selectLine(){
    const {from,to} = this.blockRange();
    this.setSelection(this.lineStart(from), this.lineEnd(to));
  },
  selectAllOccurrences(){
    const w = this.wordAtCaret;
    if(!w) return;
    const re = new RegExp("\\b"+w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g");
    const sels = []; let m;
    while((m=re.exec(this.content))) sels.push({s:m.index,e:m.index+w.length});
    if(sels.length){ this.setSelections(sels); }
  },
  addNextOccurrence(){
    const p = this.primary;
    if(p.s!==p.e){ const w=this.content.slice(p.s,p.e);
      const re=new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"g");
      let m, from = p.e;
      while((m=re.exec(this.content))){ if(m.index>=from){ this.setSelections(this.sel.concat([{s:m.index,e:m.index+w.length}])); this.focus(); return; } }
      return;
    }
    const w = this.wordAtCaret;
    if(!w || w.length<2) return;
    const re = new RegExp("\\b"+w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g");
    const taken = new Set(this.sel.map(c=>c.s));
    let m;
    while((m=re.exec(this.content))){ if(!taken.has(m.index)){ this.setSelections(this.sel.concat([{s:m.index,e:m.index+w.length}])); this.focus(); return; } }
  },
  addCursorVert(dir){
    const p = this.primary;
    const line = this.lineOf(p.s===p.e?p.s:p.s);
    const col = p.e - this.lineStart(line);
    let target;
    if(dir<0){
      let l=line-1;
      while(l>=0 && this.lineText(l).trim()==="") l--;
      if(l<0){ this.setSelections([{s:0,e:0}]); return; }
      target = Math.min(this.lineStart(l)+col, this.lineEnd(l));
    } else {
      let l=line+1;
      while(l<this.lineCount() && this.lineText(l).trim()==="") l++;
      if(l>=this.lineCount()){ this.setSelections([{s:this.content.length,e:this.content.length}]); return; }
      target = Math.min(this.lineStart(l)+col, this.lineEnd(l));
    }
    const sels = this.sel.filter(c=>c.s!==target || c.e!==target);
    sels.push({s:target,e:target});
    this.setSelections(sels); this.focus();
  },
  moveLines(dir){
    const {from,to} = this.blockRange();
    const lines = this.content.split("\n");
    if(dir<0 && from===0) return;
    if(dir>0 && to>=lines.length-1) return;
    const blk = lines.splice(from, to-from+1);
    lines.splice(dir<0 ? from-1 : to+1, 0, ...blk);
    const shift = dir<0 ? -1 : blk.length;
    this.snapshot();
    this.content = lines.join("\n");
    const mk = c => {
      const l1=this.lineOf(c.s), l2=this.lineOf(c.e);
      return { s:this.posAt(clamp(l1+shift,0,lines.length-1), c.s-this.lineStart(l1)),
               e:this.posAt(clamp(l2+shift,0,lines.length-1), c.e-this.lineStart(l2)) };
    };
    const sels = this.sel.map(mk).sort((a,b)=>a.s-b.s);
    this.sel = sels; this._syncTA(); this.render();
    if(this.on.change) this.on.change(this.content, "move");
  },
  duplicateLines(dir){
    const {from,to} = this.blockRange();
    const lines = this.content.split("\n");
    const blk = lines.slice(from, to+1);
    if(dir>0) lines.splice(to+1, 0, ...blk); else lines.splice(from, 0, ...blk);
    this.snapshot();
    this.content = lines.join("\n");
    if(dir>0){
      this.sel = this.sel.map(c=>({ s:c.s + blk.join("\n").length + 1, e:c.e + blk.join("\n").length + 1 }));
    } else this.sel = this.sel.map(c=>({ s:c.s, e:c.e }));
    this._syncTA(); this.render();
    if(this.on.change) this.on.change(this.content, "dup");
  },
  deleteLines(){
    const {from,to} = this.blockRange();
    const lines = this.content.split("\n");
    lines.splice(from, to-from+1);
    this.snapshot();
    this.content = lines.join("\n");
    const pos = this.posAt(clamp(from,0,lines.length-1), 0);
    this.sel = [{s:pos,e:pos}];
    this._syncTA(); this.render();
    if(this.on.change) this.on.change(this.content, "delete");
  },
  toggleComment(){
    const {from,to} = this.blockRange();
    const lines = this.content.split("\n");
    const lc = (this.spec.line && this.spec.line[0]) || "//";
    const nonEmpty = lines.slice(from,to+1).filter(l=>l.trim());
    const allCommented = nonEmpty.length && nonEmpty.every(l=>l.trim().startsWith(lc));
    this.snapshot();
    for(let i=from;i<=to;i++){
      if(!lines[i].trim()) continue;
      if(allCommented){
        const i2 = lines[i].indexOf(lc);
        const after = lines[i].slice(i2+lc.length);
        lines[i] = lines[i].slice(0,i2) + after.replace(/^ ?/,"");
      } else {
        const ind = /^[ \t]*/.exec(lines[i])[0];
        lines[i] = ind + lc + (lc==="//"?" ":"") + lines[i].slice(ind.length);
      }
    }
    this.content = lines.join("\n");
    this._syncTA(); this.render();
    if(this.on.change) this.on.change(this.content, "comment");
  },
  smartHome(toEnd){
    const l = this.lineOf(this.caret);
    const text = this.lineText(l);
    const ind = /^[ \t]*/.exec(text)[0].length;
    const pos = this.caret;
    let target;
    if(this._lastHome!=null && this._lastHome===pos) target = pos-this.lineStart(l);
    else target = Math.max(pos-this.lineStart(l), ind) + this.lineStart(l);
    this._lastHome = target;
    this.setSelection(target, target);
  },
  smartEnter(){
    const p = this.primary;
    const l = this.lineOf(p.s);
    const text = this.lineText(l);
    const ind = /^[ \t]*/.exec(text)[0];
    const before = text.slice(0, p.s - this.lineStart(l)).replace(/\s+$/,"");
    const unit = this.spec.indent===4 ? "    " : "  ";
    let extra = "";
    const opens = /[{([]\s*$/.test(before);
    const pyColon = this.spec.id==="python" && /:\s*$/.test(before);
    const kwBlock = /\b(?:if|else|elif|for|while|try|except|finally|with|match|case|def|class|switch|catch|do|foreach)\b[^:]*:\s*$/.test(before);
    if(opens || pyColon || kwBlock) extra = unit;
    const after = this.content.slice(p.s);
    const closes = after.trimStart();
    if(extra && ["}","]",")"].includes(closes[0]) && (opens || pyColon || kwBlock)){
      const mid = this.content.slice(p.s, p.s + (after.length - closes.length));
      const body = "\n" + ind + extra + mid + "\n" + ind;
      this.snapshot();
      this.content = this.content.slice(0,p.s) + body + this.content.slice(p.s + (after.length - closes.length));
      this.setSelection(p.s + 1 + ind.length + extra.length, p.s + 1 + ind.length + extra.length);
      if(this.on.change) this.on.change(this.content, "enter");
      return;
    }
    this.insert("\n" + ind + extra);
  },
  format(){
    const p = this.primary;
    const spec = this.spec;
    const lc = (spec.line && spec.line[0]) || "//";
    let out = this.content;
    if(spec.id==="python"){
      out = out.replace(/[ \t]+$/gm,"");
    } else if(spec.regexp){
      out = out.split("\n").map(l=>{
        if(/^\s*\/\//.test(l)) return l.replace(/\s+$/,"");
        return l.replace(/;{2,}.*$/,"").replace(/[ \t]+$/,"").replace(/([{,])\s+/g,"$1 ");
      }).join("\n");
    } else if(spec.id==="json"||spec.id==="jsonc"){
      try{ out = JSON.stringify(JSON.parse(this.content), null, 2); }catch(e){ return; }
    }
    if(out===this.content) return;
    this.snapshot(); this.content = out;
    this.sel = [{s:clamp(p.s,0,out.length), e:clamp(p.e,0,out.length)}];
    this._syncTA(); this.render();
    if(this.on.change) this.on.change(this.content, "format");
  },

  // ================= folding =================
  computeFolds(){
    const toks = LANG.tokenize(this.content, this.spec);
    const ls = SYMBOLS.lineStarts(this.content);
    const openers = Object.keys(this.spec.pairs||{});
    const stack = []; const folds = [];
    let id = 0;
    const lineStartsWS = this.content.split("\n").map(l=>/^[ \t]*/.exec(l)[0].length);
    for(const t of toks){
      if(t.t!=="op" && t.t!=="pun") continue;
      const ch = this.content[t.s];
      const line = SYMBOLS.lineOf(ls, t.s);
      if(openers.includes(ch)) stack.push({ch, line, col:lineStartsWS[line]});
      else if(Object.values(this.spec.pairs||{}).includes(ch)){
        const o = stack.pop();
        if(!o) continue;
        if(o.col===0 && line - o.line >= 1) folds.push({ id: "f"+(id++), from:o.line, to:line, kind:"brace" });
      }
    }
    // consecutive comment runs
    const lines = this.content.split("\n");
    let run = -1;
    const lc = (this.spec.line||[])[0] || (this.spec.block||[])[0]?.[0];
    for(let i=0;i<=lines.length;i++){
      const isC = i<lines.length && lc && lines[i].trim().startsWith(lc);
      if(isC && run<0) run=i;
      if(!isC && run>=0){
        if(i-run>=4) folds.push({ id:"f"+(id++), from:run-1, to:i-1, kind:"comment" });
        run=-1;
      }
    }
    this.folds = folds;
  },
  toggleFold(id){
    if(this.collapsed.has(id)) this.collapsed.delete(id);
    else {
      this.computeFolds();
      this.collapsed.add(id);
    }
    this.render();
    if(this.on.folds) this.on.folds();
  },
  unfoldAll(){ this.collapsed = new Set(); this.render(); },

  // ================= find / replace =================
  setFind(q, {replace, caseOn, whole, regex}={}){
    if(!q){ this.find=null; this.render(); return 0; }
    const flags = (caseOn?"":"i");
    let re;
    try{
      re = regex ? new RegExp(q, flags+"g") : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"), flags+"g");
    }catch(err){ this.find={q,matches:[],bad:true}; this.render(); return 0; }
    const ms = []; let m, guard=0;
    while((m=re.exec(this.content)) && guard++<3000){
      if(!whole || /[\w$]/.test(this.content[m.index-1]||" ") && /[\w$]/.test(this.content[m.index+m[0].length]||" ")){ }
      ms.push({ s:m.index, e:m.index+m[0].length });
      if(m[0].length===0) re.lastIndex++;
    }
    if(whole){
      const w = new RegExp("\\b"+q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g");
      const ws=[]; let k;
      while((k=w.exec(this.content))) ws.push({s:k.index,e:k.index+q.length});
      ms.length=0; ms.push(...ws);
    }
    this.find = { q, matches:ms, idx:0, replace, caseOn, whole, regex };
    this.render();
    return ms.length;
  },
  findNext(dir){
    if(!this.find || !this.find.matches.length) return false;
    this.find.idx = (this.find.idx + (dir>0?1:-1) + this.find.matches.length) % this.find.matches.length;
    const m = this.find.matches[this.find.idx];
    this.setSelection(m.s, m.e);
    this.scrollTo(m.s);
    this.render();
    return true;
  },
  replaceCurrent(repl){
    if(!this.find || !this.find.matches.length) return false;
    const m = this.find.matches[this.find.idx];
    const text = repl.replace(/\\n/g,"\n").replace(/\\t/g,"\t").replace(/\$(\d)/g,(x,d)=>{
      const mm = this.find.matches[+d]; return mm? this.content.slice(mm.s,mm.e) : x;
    });
    this.snapshot();
    this.content = this.content.slice(0,m.s) + text + this.content.slice(m.e);
    this.sel=[{s:m.s,e:m.s+text.length}];
    this._syncTA();
    this.setFind(this.find.q, {replace:repl, caseOn:this.find.caseOn, whole:this.find.whole, regex:this.find.regex});
    if(this.find.matches.length){ this.find.idx = Math.min(this.find.idx, this.find.matches.length-1); const mm=this.find.matches[this.find.idx]; this.setSelection(mm.s,mm.e); }
    this.render();
    if(this.on.change) this.on.change(this.content, "replace");
    return true;
  },
  replaceAll(repl){
    if(!this.find || !this.find.matches.length) return 0;
    const ms = this.find.matches.slice().sort((a,b)=>b.s-a.s);
    const text = repl.replace(/\\n/g,"\n").replace(/\\t/g,"\t");
    this.snapshot();
    for(const m of ms) this.content = this.content.slice(0,m.s) + text + this.content.slice(m.e);
    const at = ms[ms.length-1].s;
    this.sel=[{s:at,e:at+text.length}];
    this._syncTA();
    this.setFind(this.find.q, {replace:repl, caseOn:this.find.caseOn, whole:this.find.whole, regex:this.find.regex});
    this.render();
    if(this.on.change) this.on.change(this.content, "replaceAll");
    return ms.length;
  },

  // ================= minimap =================
  _renderMinimap(){
    if(!this.mmc) return;
    const total = this.lineCount();
    const W = 78, H = Math.min(4000, Math.max(60, total*2));
    if(this.mmc.width!==W || this.mmc.height!==H){ this.mmc.width=W; this.mmc.height=H; }
    const ctx = this.mmc.getContext("2d");
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle="#0d0820"; ctx.fillRect(0,0,W,H);
    const runs = HL.minimapRuns(this.content, this.spec);
    for(const r of runs){
      ctx.fillStyle = r.c;
      ctx.fillRect(r.x, r.y, Math.min(r.w, W-r.x), 1);
    }
    const st = this.scroll;
    const ratio = H / Math.max(1, (PADT*2 + total*this.lh));
    this.mmv.style.top = (st.scrollTop*ratio)+"px";
    this.mmv.style.height = Math.max(14, st.clientHeight*ratio)+"px";
    this.mmc2.style.top = (this._xy(this.caret).y*ratio)+"px";
  }
});

function ta0(ta){ return { s:ta.selectionStart, e:ta.selectionEnd }; }