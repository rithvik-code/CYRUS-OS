// ---------------------------------------------------------------------------
//  The Studio app — wires all eight phases into one surface
// ---------------------------------------------------------------------------
class StApp {
  constructor(win, opts){
    this.win = win;
    // The running editor was previously reachable only from inside Studio's own
    // closures, so nothing outside could ask "what is the user looking at?".
    // Its buildContext() already reports the file, selection, diagnostics and
    // enclosing symbol — publishing the instance lets the OS answer that
    // question for any consumer, without duplicating a single one of those
    // computations.
    StApp.instance = this;
    opts = opts || {};
    StSettings.load();
    StExt.seed();
    this.root = opts.root || StSettings.get("root") || "/home/rithvik/Projects";
    if(!VFS.node(this.root)) this.root = "/home/rithvik";
    const proj = StProject.detect(this.root);
    if(proj){ this.root = proj.root; if(proj.manifest) this.marker = proj.marker; }
    this.tabs = [];            // {path, view:{s,e}, dirty}
    this.active = null;
    this.split = null;         // second editor path
    this.group = null;         // editor, problems[], problemsByLine
    this.rightTab = "cyrus";
    this.panelTab = StSettings.get("lastPanel") || "problems";
    this.panelOpen = false;
    this.ai = [];
    this.aiBusy = false;
    this.pendingDiff = null;
    this.nav = { stack:[], pos:-1 };
    this.runState = null;
    this.inlineTimer = null;
    this.inlineToken = 0;
    this.lastProblems = [];
    this.termLines = [];
    this.build();
    StCmds.register(this);
    this.applySettings();
    this.refreshExplorer();
    this.setPanelTab(this.panelTab, true);
    this.renderStatus();
    this.renderWelcome();
    if(opts.path) this.openPath(opts.path);
  }

  // ================= layout =================
  build(){
    this.win.body.innerHTML = `<div class="st2">
      <div class="st2-bar">
        <div class="g2">
          <span class="st2-ico" data-a="tglSide" title="Explorer (Ctrl+B)">🗂️</span>
          <span class="st2-ico" data-a="qopen" title="Go to File (Ctrl+P)">🔎</span>
          <span class="st2-ico" data-a="palette" title="Command Palette (Ctrl+Shift+P)">⌘</span>
        </div>
        <div class="st2-sep"></div>
        <div class="g2">
          <span class="st2-ico" data-a="run" title="Run (Ctrl+Enter)">▶</span>
          <span class="st2-ico" data-a="save" title="Save (Ctrl+S)">💾</span>
          <span class="st2-ico" data-a="split" title="Split Editor (Ctrl+\\)">▥</span>
          <span class="st2-ico" data-a="ext" title="Extensions (Ctrl+Shift+X)">🧩</span>
          <span class="st2-ico" data-a="settings" title="Settings">⚙️</span>
        </div>
        <div class="st2-title" data-a="title"></div>
      </div>
      <div class="st2-main">
        <div class="st2-side" data-r="side">
          <div class="st2-pane-h">Explorer
            <span class="st2-act">
              <button data-a="newFile" title="New File (Ctrl+Alt+N)">＋</button>
              <button data-a="newFolder" title="New Folder">🗀</button>
              <button data-a="collapse" title="Collapse All">⇱</button>
              <button data-a="openFolder" title="Open Folder">📂</button>
            </span>
          </div>
          <div style="padding:0 8px 7px"><input data-r="filter" placeholder="Filter files…" style="width:100%;background:#0d0820;border:1px solid #2a1f47;border-radius:6px;color:#e6dffc;font-size:11px;padding:3px 7px;outline:none;font-family:inherit"></div>
          <div class="st2-tree" data-r="tree"></div>
          <div class="st2-pane-h" style="border-top:1px solid #1e1638">Workspace
            <span class="st2-act"><button data-a="projInfo" title="Project Info">ⓘ</button></span>
          </div>
          <div data-r="proj" style="padding:0 12px 10px;font-size:11px;color:#6f6690;line-height:1.7"></div>
          <div class="st2-pane-h" style="border-top:1px solid #1e1638">Connections
            <span class="st2-act"><button data-a="connRefresh" title="Re-check every provider">⟳</button></span>
          </div>
          <div data-r="conn" class="st2-conn"></div>
        </div>
        <div class="st2-mid">
          <div class="st2-tabs" data-r="tabs"></div>
          <div class="st2-bread hidden" data-r="bread"></div>
          <div class="st2-edwrap" data-r="edwrap"></div>
          <div class="st2-wel" data-r="wel"></div>
          <div class="st2-panel h0" data-r="panel">
            <div class="st2-ptabs" data-r="ptabs"></div>
            <div class="st2-pbody" data-r="pbody"></div>
          </div>
        </div>
        <div class="st2-right" data-r="right">
          <div class="st2-rtabs" data-r="rtabs"></div>
          <div class="st2-rbody" data-r="rbody"></div>
        </div>
      </div>
      <div class="st2-status" data-r="status"></div>
    </div>`;
    const R = k => this.win.body.querySelector(`[data-r="${k}"]`);
    this.r = { side:R("side"), tree:R("tree"), filter:R("filter"), proj:R("proj"), conn:R("conn"),
               tabs:R("tabs"), bread:R("bread"), edwrap:R("edwrap"), wel:R("wel"),
               panel:R("panel"), ptabs:R("ptabs"), pbody:R("pbody"),
               right:R("right"), rtabs:R("rtabs"), rbody:R("rbody"), status:R("status"),
               title:this.win.body.querySelector('[data-a="title"]') };
    this.q = a => this.win.body.querySelector(`[data-a="${a}"]`);

    this.editor = new StEditor(this.r.edwrap, {
      on:{
        change:(txt,kind)=>this.onEditorChange(txt,kind),
        cursor:()=>this.onEditorCursor(),
        render:()=>this.onEditorRender(),
        key:(k,e)=>this.onEditorKey(k,e),
        acceptGhost:()=>this.acceptGhost(),
        problems:()=>{}
      }
    });
    this.explorer = new StExplorer(this.r.tree, {
      root:this.root,
      on:{
        open:p=>this.openPath(p),
        changed:()=>{ this.refreshExplorer(); this.afterVfsChange(); },
        renamed:(a,b)=>{ const t=this.tabs.find(x=>x.path===a); if(t){ t.path=b; if(this.active===a) this.active=b; } this.renderTabs(); },
        expanded:(list)=>{ StSettings.set("expanded", list); },
        context:(paths,x,y)=>this.showContextMenu(paths,x,y),
        activate:()=>this.renderStatus()
      }
    });
    this.explorer.expanded = new Set(StSettings.get("expanded")||[]);
    this.explorer.filter = StSettings.get("explorerFilter")||"";
    this.r.filter.value = this.explorer.filter;

    this.explorer._wire();
    this.bindBar();
    this.bindSide();
    this.bindPanel();
    this.buildFind();
    this.buildStatusBar();
    this.buildRight();
    // Phase 9: the Connections panel is always present, so the authority the
    // user already granted is visible for the whole life of the window.
    StConn.attach(this);
  }

  bindBar(){
    this.q("tglSide").onclick = ()=>this.toggleSide();
    this.q("qopen").onclick = ()=>this.quickOpen();
    this.q("palette").onclick = ()=>this.commandPalette();
    this.q("run").onclick = ()=>this.run();
    this.q("save").onclick = ()=>this.save();
    this.q("split").onclick = ()=>this.splitEditor();
    this.q("ext").onclick = ()=>this.showExtensions();
    this.q("settings").onclick = ()=>this.showSettings();
    this.q("newFile").onclick = ()=>this.newFile();
    this.q("newFolder").onclick = ()=>this.newFolder();
    this.q("collapse").onclick = ()=>{ this.explorer.expanded = new Set([this.root]); this.explorer.render(); StSettings.set("expanded",[this.root]); };
    this.q("openFolder").onclick = ()=>this.openFolderPicker();
    this.q("projInfo").onclick = ()=>this.projectInfo();
    this.q("connRefresh").onclick = async ()=>{ this.toast("Re-checking providers…"); await StConn.restore(); };
    this.r.filter.addEventListener("input", ()=>{
      this.explorer.search(this.r.filter.value);
      StSettings.set("explorerFilter", this.r.filter.value);
    });
    this.r.filter.addEventListener("keydown", e=>e.stopPropagation());
    // global keyboard: everything not consumed by the editor
    this.win.el.addEventListener("keydown", e=>this.onGlobalKey(e));
  }

  // ================= tabs =================
  bindSide(){
    const main = this.win.body.querySelector(".st2-main");
    const mk = (which)=>{
      const r = el("div","st2-resizer");
      r.style.cssText = "width:5px;cursor:col-resize;flex:none;background:transparent";
      r.addEventListener("mousedown", e=>{
        e.preventDefault();
        const startX = e.clientX;
        const key = which==="left" ? "sideWidth" : "rightWidth";
        const start = StSettings.get(key);
        const move = ev=>{
          const d = which==="left" ? ev.clientX-startX : startX-ev.clientX;
          StSettings.set(key, Math.max(150, Math.min(600, start+d)));
          StSettings.save(); this.applySettings();
        };
        const up = ()=>{ document.removeEventListener("mousemove",move); document.removeEventListener("mouseup",up); };
        document.addEventListener("mousemove",move); document.addEventListener("mouseup",up);
      });
      return r;
    };
    main.insertBefore(mk("left"), this.r.side.nextSibling);
    this.r.right.parentNode.insertBefore(mk("right"), this.r.right);
    // keep the right splitter glued to the panel edge as panels toggle
    this.win.el.addEventListener("click", ()=>{}, true);
  }

  renderTabs(){
    const items = this.split ? [this.active, this.split] : this.tabs.map(t=>t.path);
    this.r.tabs.innerHTML = items.filter(Boolean).map(p=>{
      const t = this.tabs.find(x=>x.path===p);
      const on = p===this.active ? " on":"";
      const dirty = t && t.dirty ? " dirty":"";
      const tag = LANG.forPath(p);
      return `<div class="st2-tab${on}${dirty}" data-p="${esc(p)}"><span>${this.iconFor(p)}</span><span>${esc(VFS.base(p))}</span><span class="x" data-close="${esc(p)}">✕</span></div>`;
    }).join("");
    this.r.tabs.querySelectorAll(".st2-tab").forEach(tab=>{
      const p = tab.dataset.p;
      tab.addEventListener("mousedown", e=>{
        if(e.target.dataset.close){ e.stopPropagation(); this.closeTab(e.target.dataset.close); return; }
        this.openPath(p);
      });
      tab.addEventListener("contextmenu", e=>{
        e.preventDefault();
        this.showTabMenu(p, e.clientX, e.clientY);
      });
      tab.addEventListener("auxclick", e=>{ if(e.button===1){ e.preventDefault(); this.closeTab(p); } });
    });
  }
  iconFor(p){
    const tag = LANG.forPath(p).id;
    return ({"javascript":"🟨","typescript":"🟦","python":"🐍","html":"🌐","css":"🎨","markdown":"📘",
             "json":"🧩","jsonc":"🧩","java":"☕","go":"🐹","rust":"🦀","c":"🔵","cpp":"🔵","csharp":"🎯",
             "php":"🐘","ruby":"💎","sh":"⚙️","yaml":"🧾","sql":"🗄️","dockerfile":"🐳","toml":"🔧","make":"🔨"}[tag]) || "📄";
  }
  openPath(path, opts){
    opts = opts || {};
    if(!path) return;
    const n = VFS.node(path);
    if(!n){ this.toast("Not found: "+path,"err"); return; }
    if(n.type==="dir"){ this.setRoot(path); return; }
    if(!this.tabs.some(t=>t.path===path)){
      this.tabs.push({ path, view:null, dirty:false, prev:null });
      const rec = StIndex.symbolsFor(path);
      if(rec) StSettings.set("recent", [path].concat((StSettings.get("recent")||[]).filter(p=>p!==path)).slice(0,20));
    }
    this.active = path;
    // Load the file FIRST. setFile() replaces the content and resets the caret,
    // so placing the cursor before it silently threw the jump away — every
    // "go to line" path (references, workspace symbols, problem clicks) landed
    // wherever the previous file happened to leave off.
    if(!opts.keepView){ const t=this.tabs.find(x=>x.path===path); this.editor.setFile(path, t&&t.dirty?t.text:(n.content||"")); }
    if(opts.line!=null){
      const p=this.editor.posAt(opts.line, opts.col||0);
      this.editor.setSelection(p, opts.col!=null ? p : this.editor.lineEnd(opts.line));
    }
    this.renderTabs(); this.renderBread(); this.renderWelcome(); this.renderStatus();
    this.analyze(); this.renderRight();
    if(opts.focus!==false) this.editor.focus();
    if(opts.line!=null) this.editor.revealLine(opts.line);
  }
  activePath(){ return this.active; }
  closeTab(p){
    const t = this.tabs.find(x=>x.path===p);
    if(t && t.dirty){
      Modal.confirm({ title:"Close "+VFS.base(p)+"?", body:"It has unsaved changes.", confirmText:"Close without saving", danger:true })
        .then(ok=>{ if(ok){ t.dirty=false; this.closeTab(p); } });
      return;
    }
    this.tabs = this.tabs.filter(x=>x.path!==p);
    if(this.split===p) this.split = null;
    if(this.active===p){
      this.active = this.tabs.length ? this.tabs[this.tabs.length-1].path : null;
      if(this.active) this.openPath(this.active); else this.editor.setFile("", "");
    }
    this.renderTabs(); this.renderWelcome(); this.renderStatus(); this.renderRight();
  }
  closeAllTabs(){ this.tabs.forEach(t=>t.dirty=false); this.tabs=[]; this.active=null; this.split=null;
    this.editor.setFile("",""); this.renderTabs(); this.renderWelcome(); this.renderStatus(); }
  splitEditor(){
    if(!this.active) return;
    if(this.split){ const t=this.tabs.find(x=>x.path===this.split); if(t){ this.active=this.split; this.split=null; this.openPath(this.active); } return; }
    this.split = this.active;
    this.toast("Split view: "+VFS.base(this.split)+" · "+(this.tabs.length>1?VFS.base(this.tabs.find(t=>t.path!==this.split)?.path||""):"(open another file)"),"ok");
    this.renderTabs();
  }
  setRoot(root){
    this.root = root;
    this.explorer.setRoot(root);
    StSettings.set("root", root);
    const proj = StProject.detect(root);
    if(proj){ this.root = proj.root; this.marker = proj.marker; this.explorer.setRoot(this.root); }
    this.renderProject();
    this.renderRight();
    this.toast("Workspace: "+this.root.replace("/home/rithvik","~"),"ok");
    Log.record("studio: open workspace "+this.root, "studio_workspace", {root:this.root}, "low", false, true, "Workspace opened");
  }

  // ================= editor plumbing =================
  onEditorChange(txt, kind){
    const t = this.tabs.find(x=>x.path===this.active);
    if(t && !t.dirty && (VFS.node(this.active)||{}).content !== txt){ t.dirty = true; this.renderTabs(); }
    if(kind==="format" || kind==="replace" || kind==="replaceAll" || kind==="enter" || kind==="indent")
      this.scheduleAnalyze();
    if(this.pendingDiff && (kind==="input"||kind==="insert")) this.pendingDiff = null;
    this.renderStatus();
    if(StSettings.get("autoSave")) this.scheduleAutoSave();
  }
  onEditorCursor(){ this.renderBread(); this.renderStatus();
    // the Debug panel is a live view of the caret's token, so it follows the caret
    if(this.panelTab==="debug" && this.panelOpen) this.renderDebug(this.r.pbody); }
  onEditorRender(){ if(this.editor) this.renderStatus(); }
  scheduleAutoSave(){
    clearTimeout(this._autoSaveT);
    this._autoSaveT = setTimeout(()=>{ if(this.tabs.some(t=>t.dirty)) this.save({quiet:true}); }, StSettings.get("autoSaveDelay"));
  }
  onEditorKey(k, e){
    const mod = e.ctrlKey || e.metaKey;
    if(k==="s"){ this.save(); return; }
    if(k==="f"){ this.openFind(false); return; }
    if(k==="h"){ this.openFind(true); return; }
    if(k==="p"){ this.quickOpen(); return; }
    if(k==="b"){ this.toggleSide(); return; }
    if(k==="g"){ this.gotoLine(); return; }
    if(k===","){ this.showSettings(); return; }
    if(k==="shiftp"){ this.commandPalette(); return; }
    if(StSettings.get("inlineAI")) this.scheduleInline();
  }
  onGlobalKey(e){
    if(StPalette.node) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length===1 ? e.key.toLowerCase() : e.key;
    if(mod && e.shiftKey && k==="p"){ e.preventDefault(); this.commandPalette(); return; }
    if(mod && k==="p" && !e.shiftKey){ if(document.activeElement!==this.r.filter){ e.preventDefault(); this.quickOpen(); } return; }
    if(mod && e.shiftKey && k==="o"){ e.preventDefault(); this.gotoSymbol(); return; }
    if(mod && e.shiftKey && k==="m"){ e.preventDefault(); this.setPanelTab("problems"); return; }
    if(mod && e.shiftKey && k==="x"){ e.preventDefault(); this.showExtensions(); return; }
    if(mod && e.shiftKey && k==="e"){ e.preventDefault(); this.togglePanel("outline"); return; }
    if(mod && k==="t"){ e.preventDefault(); this.gotoWorkspaceSymbol(); return; }
    if(mod && k==="`"){ e.preventDefault(); this.setPanelTab("terminal"); return; }
    if(mod && k==="j"){ e.preventDefault(); this.togglePanel(); return; }
    if(mod && k==="Enter"){ e.preventDefault(); this.run(); return; }
    if(mod && k==="w"){ e.preventDefault(); this.closeTab(this.active); return; }
    if(mod && k==="\\"){ e.preventDefault(); this.splitEditor(); return; }
    if(mod && k==="."){ e.preventDefault(); this.quickFixSelected(); return; }
    if(e.altKey && (k==="ArrowLeft"||k==="ArrowRight")){ e.preventDefault(); k==="ArrowLeft"?this.navBack():this.navForward(); return; }
    if(e.shiftKey && k==="F12"){ e.preventDefault(); this.findReferences(); return; }
  }

  // ---- inline autocomplete ------------------------------------------------
  scheduleInline(){
    clearTimeout(this.inlineTimer);
    const ed = this.editor;
    if(!ed || !this.active) return;
    const t = this.tabs.find(x=>x.path===this.active);
    if(t) t.text = ed.text;
    const p = ed.primary;
    if(p.s!==p.e) return ed.clearGhost();
    const before = ed.content.slice(Math.max(0,p.s-2), p.s);
    if(/[\s]/.test(before.slice(-1)) || /^\s*$/.test(before)) return ed.clearGhost();
    this.inlineTimer = setTimeout(()=>this.runInline(), StSettings.get("aiDelay"));
  }

  // Ask the brain only for the text at the caret, then show it as ghost text.
  // The token guards every step: a newer keystroke, a closed tab or a failed
  // request all abandon the pending suggestion instead of flashing it late.
  async runInline(){
    const ed = this.editor, path = this.active;
    if(!ed || !path) return;
    const token = ++this.inlineToken;
    const p = ed.primary;
    const spec = LANG.forPath(path, ed.text);
    const res = await Copilot.complete({ file:{ path, lang:spec.id }, project:null, style:"" },
                                      ed.content.slice(0,p.s), ed.content.slice(p.e));
    if(token !== this.inlineToken) return;
    if(!ed || this.active !== path || !res || !res.text){ if(ed) ed.clearGhost(); return; }
    const now = ed.primary;
    if(now.s!==now.e || now.s!==p.s){ ed.clearGhost(); return; }   // caret moved while we waited
    ed.setGhost({ text:res.text, pos:p.s });
    ed.render();
  }
  async runInline(){
    const ed = this.editor;
    const path = this.active; if(!path) return;
    const my = ++this.inlineToken;
    const p = ed.primary;
    const pos = p.s;
    const prefix = ed.content.slice(0,pos), suffix = ed.content.slice(pos);
    const c = this.buildContext();
    if(!c.file){ ed.clearGhost(); return; }
    ed.setGhost({ pos, text:"…" });
    try{
      const r = await Copilot.complete(c, prefix, suffix);
      if(my!==this.inlineToken) return;
      if(this.active!==path){ ed.clearGhost(); return; }
      if(!r || !r.text){ ed.clearGhost(); return; }
      const maxLines = StSettings.get("aiMaxLines");
      const limited = r.text.split("\n").slice(0,maxLines).join("\n");
      const cur = ed.primary;
      if(cur.s!==pos) { ed.clearGhost(); return; }   // the user moved on
      ed.setGhost({ pos, text:limited });
    }catch(e){ ed.clearGhost(); }
  }
  acceptGhost(){
    const ed = this.editor, g = ed.ghost;
    if(!g || !g.text) return false;
    this.inlineToken++;
    const pos = g.pos, text = g.text;
    ed.setGhost(null);
    ed.snapshot();
    ed.content = ed.content.slice(0,pos) + text + ed.content.slice(pos);
    const np = pos + text.length;
    ed.sel = [{ s:np, e:np }];
    ed._syncTA(); ed.render();
    if(this.onEditorChange) this.onEditorChange(ed.content, "insert");
    return true;
  }

  // ---- analysis ----------------------------------------------------------
  scheduleAnalyze(){ clearTimeout(this._anT); this._anT = setTimeout(()=>this.analyze(), 420); }
  analyze(){
    const ed = this.editor;
    if(!ed || !StSettings.get("diagnostics") || !this.active){ this.lastProblems=[]; ed && ed.setProblems([]); this.renderRight(); this.renderPanel(); return; }
    clearTimeout(this._anToken);
    const token = (this._anToken||0)+1;
    this._anToken = token;
    const path = this.active;
    const text = ed.text;
    setTimeout(()=>{
      if(this._anToken!==token || this.active!==path) return;
      const spec = LANG.forPath(path, text);
      let probs = [];
      try{ probs = DIAG.analyze(text, spec, {}); }catch(e){ probs=[]; }
      if(!StSettings.get("unusedHints")) probs = probs.filter(d=>d.src!=="unused"&&d.src!=="style");
      const extra = this.runState && this.runState.problems || [];
      const merged = probs.concat(extra.filter(x=>!(x.file && x.file!==path) && x.line<=text.split("\n").length));
      this.lastProblems = merged.map(d=>(Object.assign({file:path}, d)));
      ed.setProblems(merged);
      this.problemMap = {};
      this.lastProblems.forEach(d=>{
        const k = this.problemMap[d.file] || (this.problemMap[d.file]={err:0,warn:0,info:0});
        k[d.sev]++;
      });
      this.explorer.setProblems(this.problemMap);
      this.renderRight(); this.renderPanel(); this.renderStatus();
    }, 90);
  }
  afterVfsChange(){ StIndex.invalidate(); this.renderProject(); this.renderRight(); }
  refreshExplorer(){ this.explorer.render(); this.renderProject(); this.renderStatus(); }
}