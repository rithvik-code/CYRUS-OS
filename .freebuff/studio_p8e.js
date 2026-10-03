// ---- context menus, dialogs, welcome, project info ------------------------
Object.assign(StApp.prototype, {

  showContextMenu(paths, x, y){
    closeCtxMenu();
    const n = paths.length;
    const one = n===1;
    const items = [
      ["📂", "Open", ()=>this.explorer.open(paths[0])],
      ["✏️", "Rename…", ()=>this.explorer.renameInline(paths[0])],
      ["⧉", one ? "Duplicate" : `Duplicate ${n} items`, ()=>this.explorer.duplicateSel()],
      null,
      ["📋", "Copy", ()=>{ this.explorer.copy(); this.toast(n+" copied","ok"); }],
      ["✂", "Cut", ()=>{ this.explorer.cut(); this.toast(n+" cut","ok"); }],
      ["📥", "Paste here", ()=>this.explorer.paste(paths[0]), this.explorer.clip],
      ["📋", "Copy path", ()=>this.toast(copied(paths.join("\n")),"ok")],
      null,
      ["🤖", "Ask CYRUS about this", ()=>this.askAI("Explain "+paths.map(p=>p2(p,this.root)).join(", "))],
      ["🧭", "Find in workspace…", ()=>{ this.r.filter.value=paths.length===1?VFS.base(paths[0]):""; this.explorer.search(this.r.filter.value); }],
      null,
      ["🗑", one ? "Delete" : `Delete ${n} items`, ()=>this.explorer.remove()],
    ];
    const m = buildCtxMenu(items, x, y);
    return m;
  },
  showTabMenu(p, x, y){
    closeCtxMenu();
    const t = this.tabs.find(a=>a.path===p);
    buildCtxMenu([
      ["📂","Open",()=>this.openPath(p)],
      ["↩","Close",()=>this.closeTab(p)],
      ["×","Close Others",()=>{ this.tabs.filter(a=>a.path!==p).forEach(a=>a.dirty=false); this.tabs=this.tabs.filter(a=>a.path===p); this.renderTabs(); }],
      ["▥","Split Right",()=>{ this.openPath(p); this.splitEditor(); }],
      ["🔍","Reveal in Explorer",()=>this.explorer.reveal(p)],
      t&&t.dirty ? ["💾","Save",()=>this.save()] : null,
      ["📋","Copy path",()=>this.toast(copied(p),"ok")]
    ], x, y);
  },

  async newFile(){
    const dir = await this.pickTarget("Where should the new file go?");
    if(!dir) return;
    const name = await this.promptText("New file name", "untitled.js");
    if(!name) return;
    const r = StFS.newFile(dir, name);
    if(!r.ok){ this.toast(r.err,"err"); return; }
    this.explorer.expanded.add(dir);
    this.refreshExplorer();
    this.openPath(r.path);
  },
  async newFolder(){
    const dir = await this.pickTarget("Where should the new folder go?");
    if(!dir) return;
    const name = await this.promptText("New folder name", "src");
    if(!name) return;
    const r = StFS.newFolder(dir, name);
    if(!r.ok){ this.toast(r.err,"err"); return; }
    this.explorer.expanded.add(dir); this.explorer.expanded.add(r.path);
    this.refreshExplorer();
  },
  pickTarget(title){
    const dirs = [];
    const walk = (p, d)=>{
      const n = VFS.node(p); if(!n||n.type!=="dir") return;
      dirs.push({ path:p, depth:d });
      if(d>3) return;
      Object.keys(n.children).sort().forEach(k=>{ if(n.children[k].type==="dir" && !k.startsWith(".")) walk(p+"/"+k, d+1); });
    };
    walk(this.root, 0);
    return new Promise(resolve=>{
      let done = false;
      StPalette.open({ tag:"folder", placeholder:title||"Pick a folder…", items:dirs,
        render:(d,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}" style="padding-left:${11+d.depth*16}px"><span class="ic">${d.depth?"":"📁"}</span><span class="lbl">${esc(VFS.base(d.path)||"/")}</span><span class="sub">${esc(p2(d.path,"~"))}</span></div>`,
        quick:(q,items)=>Fuzzy.rank(q,items,x=>x.path).map(x=>x.item),
        onPick:(d)=>{ done=true; StPalette.close(); resolve(d.path); },
        onCancel:()=>{ if(!done) resolve(null); } });
    });
  },
  promptText(title, def){
    return new Promise(resolve=>{
      const back = stModal();
      back.innerHTML = `<div class="st2-pal" style="width:460px">
        <div class="st2-pal-in"><span class="tag">input</span><input placeholder="${esc(def||"")}" value="${esc(def||"")}" spellcheck="false"></div>
        <div class="st2-pal-f"><b>enter</b> confirm · <b>esc</b> cancel</div></div>`;
      document.body.appendChild(back);
      const inp = back.querySelector("input");
      const done = v => { back.remove(); document.removeEventListener("keydown", trap, true); resolve(v); };
      const trap = e => { e.stopPropagation(); if(e.key==="Escape"){ e.preventDefault(); done(null); } };
      document.addEventListener("keydown", trap, true);
      inp.addEventListener("keydown", e=>{
        e.stopPropagation();
        if(e.key==="Enter"){ e.preventDefault(); done(inp.value.trim()||null); }
        if(e.key==="Escape"){ e.preventDefault(); done(null); }
      });
      back.addEventListener("mousedown", e=>{ if(e.target===back) done(null); });
      setTimeout(()=>{ inp.focus(); inp.select(); },20);
      this._activePrompt = done;
    });
  },
  openFolderPicker(){
    const dirs = [];
    const walk = (p,d)=>{
      const n=VFS.node(p); if(!n||n.type!=="dir") return;
      dirs.push({path:p,depth:d});
      if(d>4) return;
      Object.keys(n.children).sort().forEach(k=>{ if(n.children[k].type==="dir") walk(p+"/"+k,d+1); });
    };
    walk("/home/rithvik", 0);
    StPalette.open({ tag:"workspace", placeholder:"Open a folder as the workspace…", items:dirs,
      render:(d,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}" style="padding-left:${11+d.depth*16}px"><span class="ic">📁</span><span class="lbl">${esc(VFS.base(d.path)||"/")}</span><span class="sub">${esc(p2(d.path,"~"))}</span></div>`,
      quick:(q,items)=>Fuzzy.rank(q,items,x=>x.path).map(x=>x.item),
      onPick:(d)=>{ const proj=StProject.detect(d.path); this.setRoot(proj?proj.root:d.path);
        this.tabs=[]; this.active=null; this.editor.setFile("","");
        this.renderTabs(); this.renderWelcome(); this.analyze(); this.renderRight(); } });
  },
  newProjectDialog(){
    const kinds = [["node","Node.js"],["python","Python"],["rust","Rust"],["go","Go"],["static","Static site"],["blank","Empty workspace"]];
    StPalette.open({ tag:"new", placeholder:"What kind of project?", items:kinds.map(k=>({id:k[0],name:k[1]})),
      render:(k,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">✦</span><span class="lbl">${esc(k.name)}</span><span class="sub">${k.id==="blank"?"just "+MANIFEST:"scaffolded with a run config"}</span></div>`,
      onPick:async(k)=>{
        const name = await this.promptText("Project name", "my-project");
        if(!name) return;
        const dir = VFS.norm(this.root, name);
        if(VFS.node(dir)) return this.toast("That folder already exists","err");
        VFS.mkdirp(dir);
        const r = StProject.scaffold(dir, name, k.id);
        if(!r.ok) return this.toast(r.err,"err");
        this.setRoot(dir);
        this.tabs=[]; this.active=null;
        this.renderTabs(); this.renderWelcome();
        const first = StProject.suggestExports(dir)[0];
        if(first) this.openPath(dir+"/"+first);
        this.toast("Created "+name+" with "+MANIFEST,"ok");
      } });
  },
  async initWorkspace(){
    const name = await this.promptText("Workspace name", VFS.base(this.root));
    if(!name) return;
    const r = StProject.scaffold(this.root, name, "blank");
    if(!r.ok) return this.toast(r.err,"err");
    this.toast(MANIFEST+" created — open it to edit the definition","ok");
    this.openPath(this.root+"/"+MANIFEST);
    this.renderProject();
  },
  projectInfo(){
    const r = StProject.resolved(this.root);
    const s = StProject.learn(this.root);
    const files = StProject.files(this.root);
    const langs = {};
    files.forEach(p=>{ const t=LANG.forPath(p); langs[t.name]=(langs[t.name]||0)+1; });
    const rows = Object.entries(langs).sort((a,b)=>b[1]-a[1]);
    const html =
      `<div class="st2-sec">${esc(r.name)}</div>`+
      `<div class="st2-prow"><span class="cl">root</span><span>${esc(p2(this.root,"~"))}</span></div>`+
      `<div class="st2-prow"><span class="cl">marker</span><span>${esc(this.marker||MANIFEST)}</span></div>`+
      `<div class="st2-prow"><span class="cl">manifest</span><span>${r.error?`<span style="color:#e8798f">invalid JSON — ${esc(r.error)}</span>`:(StProject.read(this.root)?"declared":"not yet created")}</span></div>`+
      `<div class="st2-prow"><span class="cl">entry</span><span>${esc(r.entry||"(none declared)")}</span></div>`+
      `<div class="st2-prow"><span class="cl">roots</span><span>${esc(r.roots.join(", "))}</span></div>`+
      `<div class="st2-sec">LEARNED STYLE</div>`+
      `<div class="st2-prow"><span class="cl">indent</span><span>${esc(s.indent)}</span></div>`+
      `<div class="st2-prow"><span class="cl">quotes</span><span>${esc(s.quotes)}</span></div>`+
      `<div class="st2-prow"><span class="cl">semicolons</span><span>${esc(s.semicolons)}</span></div>`+
      `<div class="st2-sec">LANGUAGES (${rows.length})</div>`+
      (rows.length? rows.slice(0,12).map(([k,v])=>`<div class="st2-prow"><span class="cl">${esc(k)}</span><span>${v}</span></div>`).join("")
        : '<span class="d">No recognised source files in this workspace.</span>')+
      `<div class="st2-sec">RUN CONFIGS</div>`+
      (r.runs.length? r.runs.map(c=>`<div class="st2-prow"><span class="cl">${esc(c.name)}</span><span class="d">${esc(c.command)}</span></div>`).join("")
        : `<span class="d">None declared. Edit ${MANIFEST} to add them.</span>`);
    this.showExtPanel("Project", html);
    this.dockPanel();
  },

  // ---- breadcrumbs / welcome ---------------------------------------------
  renderBread(){
    if(!this.active){ this.r.bread.classList.add("hidden"); return; }
    this.r.bread.classList.remove("hidden");
    const parts = this.active.split("/").filter(Boolean);
    let acc = "";
    const crumbs = parts.map(seg=>{ acc += "/"+seg; return { path:acc, name:seg }; });
    const p = this.editor.primary;
    const line = this.editor.lineOf(p.e);
    const spec = LANG.forPath(this.active, this.editor.text);
    const syms = SYMBOLS.extract(this.editor.text, spec);
    const at = SYMBOLS.at(syms, line, p.e - this.editor.lineStart(line));
    this.r.bread.innerHTML =
      `<span class="bs" data-bs="${esc(this.root)}">${esc(VFS.base(this.root)||"/")}</span>`+
      crumbs.slice(1).map(c=>`<span style="opacity:.4">›</span><span class="bs" data-bs="${esc(c.path)}">${esc(c.name)}</span>`).join("")+
      (at? `<span style="opacity:.4">›</span><span class="bs on">${at.kind==="fn"?"ƒ":at.kind==="cls"?"◈":"▪"} ${esc(at.name)}</span>`:"");
    this.r.bread.querySelectorAll("[data-bs]").forEach(b=>{
      b.addEventListener("click", ()=>{ const pth=b.dataset.bs; if(VFS.node(pth).type==="dir") this.setRoot(pth); else this.openPath(pth); });
    });
  },
  renderWelcome(){
    const has = this.tabs.length>0;
    this.r.edwrap.style.display = has ? "flex" : "none";
    this.r.wel.style.display = has ? "none" : "flex";
    this.r.bread.style.display = has ? "flex" : "none";
    if(has) return;
    const proj = StProject.resolved(this.root);
    const recent = (StSettings.get("recent")||[]).filter(p=>VFS.node(p)).slice(0,6);
    const langs = Object.values(LANG.byId).filter(s=>!s.derived).slice(0,26).map(s=>s.name);
    this.r.wel.innerHTML = `
      <h2>CYRUS STUDIO</h2>
      <div class="sub">An AI-native editor that reads the project instead of guessing it.<br>
        ${esc(proj.name)} · ${esc(p2(this.root,"~"))} · ${LANG.count} languages · ${StExt.list().length} extensions</div>
      <div class="grid">
        <div class="card" data-w="qopen"><div class="k">🔎 <span>Go to File</span><kbd>Ctrl P</kbd></div><div class="d">Fuzzy search by name, or by what is inside the file</div></div>
        <div class="card" data-w="palette"><div class="k">⌘ <span>Command Palette</span><kbd>Ctrl ⇧ P</kbd></div><div class="d">Every command CYRUS Studio has</div></div>
        <div class="card" data-w="symbol"><div class="k">≣ <span>Go to Symbol</span><kbd>Ctrl ⇧ O</kbd></div><div class="d">Every function, class and type in this file</div></div>
        <div class="card" data-w="wssym"><div class="k">🧭 <span>Workspace Symbols</span><kbd>Ctrl T</kbd></div><div class="d">Symbols across every file</div></div>
        <div class="card" data-w="newfile"><div class="k">✚ <span>New File</span><kbd>Ctrl ⌥ N</kbd></div><div class="d">Create files and folders in any folder of the workspace</div></div>
        <div class="card" data-w="newproj"><div class="k">✦ <span>New Project</span><kbd>—</kbd></div><div class="d">Scaffold one with ${MANIFEST} already written</div></div>
        <div class="card" data-w="ext"><div class="k">🧩 <span>Extensions</span><kbd>Ctrl ⇧ X</kbd></div><div class="d">Capability-gated plugins</div></div>
        <div class="card" data-w="honest"><div class="k">◐ <span>What CYRUS won't fake</span><kbd>—</kbd></div><div class="d">The honest list of what this editor really does</div></div>
      </div>
      ${recent.length? `<div style="margin-top:18px;width:100%;max-width:720px"><div class="st2-sec" style="text-align:left;padding-left:4px">RECENT</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${recent.map(p=>`<button class="st2-btn" data-recent="${esc(p)}">${this.iconFor(p)} ${esc(VFS.base(p))}</button>`).join("")}</div></div>`:""}
      <div class="langs">${langs.map(l=>`<span>${esc(l)}</span>`).join("")}<span style="border-color:var(--accent);color:var(--accent2)">+${LANG.count-langs.length} more</span></div>`;
    this.r.wel.querySelectorAll("[data-w]").forEach(c=>c.addEventListener("click", ()=>{
      const w=c.dataset.w;
      if(w==="qopen") this.quickOpen();
      if(w==="palette") this.commandPalette();
      if(w==="symbol") this.gotoSymbol();
      if(w==="wssym") this.gotoWorkspaceSymbol();
      if(w==="newfile") this.newFile();
      if(w==="newproj") this.newProjectDialog();
      if(w==="ext") this.showExtensions();
      if(w==="honest") this.showHonesty();
    }));
    this.r.wel.querySelectorAll("[data-recent]").forEach(b=>b.addEventListener("click", ()=>this.openPath(b.dataset.recent)));
  },
  renderProject(){
    const r = StProject.resolved(this.root);
    const s = StProject.learn(this.root);
    this.r.proj.innerHTML =
      `<div style="color:#a99ccc;font-weight:600">${esc(r.name)}</div>`+
      `<div style="font-size:10.5px">${esc(p2(this.root,"~"))}</div>`+
      (r.error? `<div style="color:#e8798f">manifest invalid</div>` : "")+
      `<div style="color:#5b5382;margin-top:3px">${esc(s.summary)}</div>`;
    this.r.title.innerHTML = `<b>${esc(r.name)}</b>` + (this.active? ` — ${esc(p2(this.active,this.root))}` : "");
  },
});