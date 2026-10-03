// ---------------------------------------------------------------------------
// PHASE 8 — SETTINGS, THEMES, COMMANDS
// ---------------------------------------------------------------------------
const StSettings = {
  KEY:"cyrus_studio",
  data:null,
  defaults(){
    return {
      root:"/home/rithvik/Projects",
      fontSize:12.5, lineHeight:20, tabSize:4, wordWrap:false,
      minimap:true, gutter:true, diagnostics:true, unusedHints:true,
      inlineAI:true, aiDelay:650, aiMaxLines:8,
      autoSave:false, autoSaveDelay:2000, formatOnSave:false,
      theme:"cyrus", panel:"problems", sideWidth:236, rightWidth:330,
      expanded:[], recent:[], lastPanel:"problems",
      explorerFilter:"", cursorBlink:true, smoothScroll:true,
      confirmDelete:true, telemetry:false
    };
  },
  load(){
    try{ this.data = Object.assign(this.defaults(), JSON.parse(localStorage.getItem(this.KEY)||"{}")); }
    catch(e){ this.data = this.defaults(); }
    return this.data;
  },
  save(){ try{ localStorage.setItem(this.KEY, JSON.stringify(this.data)); }catch(e){} },
  get(k){ return this.data[k]; },
  set(k,v){ this.data[k]=v; this.save(); },
  reset(){ localStorage.removeItem(this.KEY); this.data=this.defaults(); this.save(); }
};

const StThemes = {
  cyrus:    { name:"CYRUS Royal", bg:"#0b0618", panel:"#100a20", panel2:"#150d29", text:"#cfc6ea",
              map:{ kw:"#c58af0", bi:"#6fb3f2", str:"#9ad48b", num:"#e0a86b", fn:"#e8c96b", ty:"#7ee0c4",
                    cls:"#f0b57a", cmt:"#5e5480", op:"#b9aed6", pun:"#8a80ab", var:"#e09ad8", tag:"#f0b57a",
                    attr:"#7ee0c4", dec:"#9a7ee0", regexp:"#7ee0c4", esc:"#7ee0c4", ent:"#e8798f" } },
  midnight: { name:"Midnight", bg:"#0d1117", panel:"#11161d", panel2:"#161b22", text:"#c9d1d9",
              map:{ kw:"#ff7b72", bi:"#79c0ff", str:"#a5d6ff", num:"#ffa657", fn:"#d2a8ff", ty:"#7ee787",
                    cls:"#ffa657", cmt:"#6e7681", op:"#c9d1d9", pun:"#8b949e", var:"#ffa198", tag:"#7ee787",
                    attr:"#79c0ff", dec:"#d2a8ff", regexp:"#a5d6ff", esc:"#a5d6ff", ent:"#ff7b72" } },
  paper:    { name:"Paper Light", bg:"#fbfbfd", panel:"#ffffff", panel2:"#f2f2f6", text:"#2a2a33",
              map:{ kw:"#8b2fa8", bi:"#0b6fa4", str:"#1f7a37", num:"#b25000", fn:"#7a4d00", ty:"#0b6fa4",
                    cls:"#b25000", cmt:"#9a9aa8", op:"#2a2a33", pun:"#5a5a66", var:"#a11b6b", tag:"#1f7a37",
                    attr:"#0b6fa4", dec:"#8b2fa8", regexp:"#0b6fa4", esc:"#0b6fa4", ent:"#c62828" } },
  amber:    { name:"Amber CRT", bg:"#0a0703", panel:"#120c04", panel2:"#1a1106", text:"#f0c674",
              map:{ kw:"#ffb454", bi:"#8ab4f8", str:"#b8e994", num:"#ff8f00", fn:"#ffd700", ty:"#7ee0c4",
                    cls:"#ff7043", cmt:"#6b5a35", op:"#f0c674", pun:"#b08d57", var:"#ff9e64", tag:"#b8e994",
                    attr:"#8ab4f8", dec:"#ffb454", regexp:"#7ee0c4", esc:"#7ee0c4", ent:"#ff5370" } },
  mono:     { name:"Graphite", bg:"#1a1a1a", panel:"#212121", panel2:"#2a2a2a", text:"#c8c8c8",
              map:{ kw:"#e5e5e5", bi:"#9e9e9e", str:"#bdbdbd", num:"#9e9e9e", fn:"#f5f5f5", ty:"#bdbdbd",
                    cls:"#e5e5e5", cmt:"#6e6e6e", op:"#c8c8c8", pun:"#9e9e9e", var:"#e5e5e5", tag:"#f5f5f5",
                    attr:"#bdbdbd", dec:"#e5e5e5", regexp:"#bdbdbd", esc:"#bdbdbd", ent:"#ff5370" } },
  apply(id){
    const t = this[id] || this.cyrus;
    const r = document.documentElement;
    r.style.setProperty("--st-bg", t.bg);
    r.style.setProperty("--st-panel", t.panel);
    r.style.setProperty("--st-panel2", t.panel2);
    r.style.setProperty("--st-text", t.text);
    let css = "";
    for(const k in t.map) css += ".st2-hl ."+k+"{color:"+t.map[k]+"!important}";
    let node = document.getElementById("st-theme-css");
    if(!node){ node = document.createElement("style"); node.id="st-theme-css"; document.head.appendChild(node); }
    node.textContent = css;
    return t;
  },
  next(){
    const ids = Object.keys(this);
    const i = ids.indexOf(StSettings.get("theme"));
    return ids[(i+1)%ids.length];
  }
};

// ---- the command registry ------------------------------------------------
const StCmds = (()=>{
  const list = [];
  const add = (id,title,category,key,run,when)=> list.push({id,title,category,key,run,when});
  return {
    list,
    add,
    all(){ return list.filter(c=> !c.when || c.when()); },
    run(id){ const c = list.find(x=>x.id===id); if(!c) return; if(c.when && !c.when()) return; c.run(); },
    forPalette(){
      return this.all().map(c=>({ id:c.id, title:c.title, category:c.category, key:c.key, run:c.run }));
    },
    register(app){
      const S = ()=>StSettings;
      // ---- file
      add("file.new","New File…","File","Ctrl+Alt+N",()=>app.newFile());
      add("file.newFolder","New Folder…","File","",()=>app.newFolder());
      add("file.save","Save","File","Ctrl+S",()=>app.save());
      add("file.saveAll","Save All","File","Ctrl+K S",()=>app.saveAll());
      add("file.revert","Revert File","File","",async()=>{
        const p=app.activePath(); if(!p) return;
        if(await Modal.confirm({title:"Revert "+VFS.base(p)+"?", body:"Unsaved changes are lost.", confirmText:"Revert", danger:true})){
          app.editor.setContent((VFS.node(p)||{content:""}).content||""); app.markClean(); app.toast("Reverted","ok");
        }
      });
      add("file.copyPath","Copy Path","File","",()=>{ const p=app.activePath(); if(p) app.toast(copied(p),"ok"); });
      add("file.close","Close Editor","File","Ctrl+W",()=>app.closeTab(app.activePath()));
      add("file.closeAll","Close All Editors","File","Ctrl+K W",()=>app.closeAllTabs());
      // ---- edit
      add("edit.undo","Undo","Edit","Ctrl+Z",()=>app.editor.undo());
      add("edit.redo","Redo","Edit","Ctrl+Y",()=>app.editor.redo());
      add("edit.find","Find","Edit","Ctrl+F",()=>app.openFind(false));
      add("edit.replace","Replace","Edit","Ctrl+H",()=>app.openFind(true));
      add("edit.toggleComment","Toggle Line Comment","Edit","Ctrl+/",()=>app.editor.toggleComment());
      add("edit.format","Format Document","Edit","Shift+Alt+F",()=>{ app.editor.format(); app.toast("Formatted","ok"); });
      add("edit.deleteLine","Delete Line","Edit","Ctrl+Shift+K",()=>app.editor.deleteLines());
      add("edit.duplicate","Duplicate Line","Edit","Shift+Alt+Down",()=>app.editor.duplicateLines(1));
      add("edit.moveUp","Move Line Up","Edit","Alt+Up",()=>app.editor.moveLines(-1));
      add("edit.moveDown","Move Line Down","Edit","Alt+Down",()=>app.editor.moveLines(1));
      add("edit.selectAllOcc","Select All Occurrences","Edit","Ctrl+Shift+E",()=>app.editor.selectAllOccurrences());
      add("edit.addCursorBelow","Add Cursor Below","Edit","Ctrl+Alt+Down",()=>app.editor.addCursorVert(1));
      add("edit.addCursorAbove","Add Cursor Above","Edit","Ctrl+Alt+Up",()=>app.editor.addCursorVert(-1));
      add("edit.multiCursor","Add Next Occurrence","Edit","Ctrl+D",()=>app.editor.addNextOccurrence());
      // ---- navigate
      add("nav.quickOpen","Go to File…","Navigate","Ctrl+P",()=>app.quickOpen());
      add("nav.symbols","Go to Symbol in File…","Navigate","Ctrl+Shift+O",()=>app.gotoSymbol());
      add("nav.workspaceSymbols","Go to Symbol in Workspace…","Navigate","Ctrl+T",()=>app.gotoWorkspaceSymbol());
      add("nav.gotoLine","Go to Line…","Navigate","Ctrl+G",()=>app.gotoLine());
      add("nav.references","Find All References","Navigate","Shift+F12",()=>app.findReferences());
      add("nav.referencesPanel","Show References","Navigate","",()=>app.referencesPanel());
      add("nav.back","Go Back","Navigate","Alt+Left",()=>app.navBack());
      add("nav.forward","Go Forward","Navigate","Alt+Right",()=>app.navForward());
      // ---- view
      add("view.explorer","Toggle Explorer","View","Ctrl+B",()=>app.toggleSide());
      add("view.ai","Toggle Copilot","View","Ctrl+Alt+I",()=>app.toggleRight());
      add("view.panel","Toggle Panel","View","Ctrl+J",()=>app.togglePanel());
      add("view.problems","Show Problems","View","Ctrl+Shift+M",()=>app.setPanelTab("problems"));
      add("view.output","Show Output","View","",()=>app.setPanelTab("output"));
      add("view.terminal","Show Terminal","View","Ctrl+`",()=>app.setPanelTab("terminal"));
      add("view.outline","Show Outline","View","Ctrl+Shift+E",()=>app.togglePanel("outline"));
      add("view.minimap","Toggle Minimap","View","",()=>{ S().set("minimap", !S().get("minimap")); app.applySettings(); });
      add("view.wordWrap","Toggle Word Wrap","View","Alt+Z",()=>{ S().set("wordWrap", !S().get("wordWrap")); app.applySettings(); });
      add("view.split","Split Editor","View","Ctrl+\\",()=>app.splitEditor());
      add("view.theme","Change Editor Theme","View","Ctrl+K Ctrl+T",()=>app.cycleTheme());
      add("conn.manage","Connections: Manage Providers…","View","",()=>StConn.sheet(null));
      add("conn.puter","Connect Puter (one-time sign-in)","View","",()=>StConn.connectPuter());
      add("conn.recheck","Connections: Re-check All","View","",()=>StConn.restore());
      // ---- run
      add("run.run","Run Active File","Run","Ctrl+Enter",()=>app.run(),()=>!!app.activePath());
      add("run.runConfig","Run a Configuration…","Run","",()=>app.runConfigPicker());
      add("run.runAll","Run all configurations","Run","",()=>app.runAllConfigs());
      add("run.stop","Stop","Run","",()=>app.stopRun(),()=>app.running);
      add("run.restart","Restart","Run","",()=>app.restartRun());
      add("run.debugExplain","Why did this fail?","Run","",()=>app.explainFailure());
      // ---- workspace
      add("ws.openFolder","Open Folder…","Workspace","",()=>app.openFolderPicker());
      add("ws.newProject","Create Project…","Workspace","",()=>app.newProjectDialog());
      add("ws.editManifest","Edit "+MANIFEST,"Workspace","",()=>{ app.openPath(app.root+"/"+MANIFEST); },()=>!!StProject.read(app.root));
      add("ws.projectInfo","Project Info","Workspace","",()=>app.projectInfo());
      add("ws.initStudio","Initialize Studio in this workspace","Workspace","",()=>app.initWorkspace(),()=>!StProject.read(app.root));
      add("ws.relearn","Re-learn project style","Workspace","",()=>{ const s=StProject.learn(app.root); app.toast(s.summary,"ok"); app.setRightTab("outline"); app.renderOutline(); });
      // ---- AI
      add("ai.chat","Focus Copilot","CYRUS","Ctrl+Alt+I",()=>app.focusAI());
      add("ai.explainFile","Explain Active File","CYRUS","",()=>app.askAI("Explain what this file does, step by step."));
      add("ai.findBugs","Find bugs and edge cases","CYRUS","",()=>app.askAI("Find real bugs, race conditions and edge cases in this file. For each: the line, why it is wrong, and the exact fix."));
      add("ai.document","Add documentation","CYRUS","",()=>app.askAI("Add clear, useful documentation to this file. Return the complete file.",{mode:"edit"}));
      add("ai.tests","Write tests","CYRUS","",()=>app.askAI("Write tests for this file. Match the project's testing conventions. Return the complete file.",{mode:"edit"}));
      add("ai.refactor","Refactor","CYRUS","",()=>app.promptText("Refactor to…","e.g. split this into smaller functions, remove duplication"));
      add("ai.fixProblem","Ask CYRUS to fix selected problem","CYRUS","",()=>app.fixProblem(),()=>app.selectedProblem);
      add("ai.quickFixSelected","Quick fix at cursor","CYRUS","Ctrl+.",()=>app.quickFixSelected(),()=>!!app.active);
      add("ai.fixAll","Fix all mechanical problems","CYRUS","",()=>app.fixAllMechanical(),()=>!!app.active);
      add("ai.explainProblem","Explain selected problem","CYRUS","",()=>app.explainProblem(),()=>app.selectedProblem);
      add("ai.toggleInline","Toggle inline suggestions","CYRUS","",()=>{ S().set("inlineAI", !S().get("inlineAI")); app.toast("Inline suggestions "+(S().get("inlineAI")?"on":"off"),"ok"); });
      // ---- extensions
      add("ext.marketplace","Extensions","Extensions","Ctrl+Shift+X",()=>app.showExtensions());
      add("ext.reload","Reload Extensions","Extensions","",()=>{ StExt.seed(); Bus.emit("studio:ext"); app.toast("Extensions reloaded","ok"); });
      // ---- help
      add("help.shortcuts","Keyboard Shortcuts","Help","Ctrl+K Ctrl+S",()=>app.showShortcuts());
      add("help.about","About CYRUS Studio","Help","",()=>app.showAbout());
      add("help.promise","What CYRUS will not fake","Help","",()=>app.showHonesty());
    }
  };
})();
function copied(text){
  try{ navigator.clipboard.writeText(text); }catch(e){}
  return "Copied to clipboard";}
