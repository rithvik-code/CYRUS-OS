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
}