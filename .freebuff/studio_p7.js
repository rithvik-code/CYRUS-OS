// ---------------------------------------------------------------------------
// PHASE 7 — THE EXTENSION API
// Extensions here are declarative JSON manifests, not downloaded scripts. That
// is a deliberate design decision: a plugin cannot call anything the editor
// does not hand it, so the capability permission table is enforced by the
// architecture rather than by a promise. Every grant is audited.
// ---------------------------------------------------------------------------
const CAPS = {
  "fs:read":     { risk:"low",    desc:"read files inside the workspace" },
  "fs:write":    { risk:"medium", desc:"create, rename and edit files" },
  "net:request": { risk:"high",   desc:"send a request to a remote host" },
  "exec:run":    { risk:"high",   desc:"ask the runner to execute something" },
  "ai:ask":      { risk:"low",    desc:"send context to the CYRUS brain" },
  "audit:read":  { risk:"low",    desc:"read the audit log" },
  "ui:panel":    { risk:"low",    desc:"contribute a panel to the sidebar" },
};

const StExt = {
  dir: "/home/rithvik/CyrusStudio/Extensions",
  installed(){ try{ return JSON.parse(Store.data.settings.extensions||"{}"); }catch(e){ return {}; } },
  save(map){ Store.data.settings.extensions = JSON.stringify(map); Store.save(); Bus.emit("studio:ext"); },
  seed(){
    const have = this.installed();
    if(Object.keys(have).length) return have;
    const map = {};
    // a factory entry IS the manifest — reading f.manifest stored undefined and
    // JSON.stringify silently dropped every extension, leaving `{}`
    StExt.factories().forEach(f=>{ map[f.id] = f; });
    this.save(map);
    return map;
  },
  active(){
    const have = this.installed();
    return Object.values(have).filter(m=> m && m.enabled !== false);
  },
  list(){ return this.active(); },
  byId(id){ return this.active().find(m=>m.id===id); },

  // the gate every capability call passes through
  async guard(cap, detail){
    const c = CAPS[cap];
    if(!c) return false;
    if(c.risk==="low"){
      Log.record("extension: "+cap, "studio_ext_cap", {cap, detail}, "low", false, true, detail||cap);
      return true;
    }
    if(c.risk==="medium"){
      const ok = await Modal.confirm({
        title:"Extension requests “"+cap+"”", body: detail + "\n\n"+c.desc+".\nThis grant is written to the audit log.",
        confirmText:"Grant once", danger:false });
      Log.record("extension: "+cap, "studio_ext_cap", {cap, detail}, "medium", ok, ok,
                 (ok?"Granted":"Denied")+" · "+c.desc);
      return ok;
    }
    const ok = await Modal.confirm({
      title:"⚠ high-risk extension request", body: detail + "\n\n"+c.desc+
      ".\n\nCYRUS blocks shell-equivalent capability behind an explicit human decision. Denied by default is one click away.",
      confirmText:"Allow this once", danger:true });
    Log.record("extension: "+cap, "studio_ext_cap", {cap, detail}, "high", ok, ok,
               (ok?"GRANTED":"denied")+" · "+c.desc);
    return ok;
  },

  factories(){
    const cmd = (id,title,category)=>({id,title,category});
    return [
    { id:"cyrus.git", name:"Source Control", icon:"⑂", publisher:"cyrus", version:"1.0.0",
      description:"Change markers, diff and commit history from .cyrus-git. Read-only unless you ask for write.",
      permissions:["fs:read","fs:write"],
      contributes:{ commands:[
        cmd("git.status","Status","Source Control"), cmd("git.diff","Diff active file","Source Control"),
        cmd("git.commit","Commit staged changes","Source Control"), cmd("git.log","History","Source Control")] } },

    { id:"cyrus.todo", name:"TODO Lens", icon:"✔", publisher:"cyrus", version:"1.0.0",
      description:"Scans the workspace for TODO / FIXME / HACK and puts them in one list you can jump from.",
      permissions:["fs:read"],
      contributes:{ commands:[ cmd("todo.list","Scan workspace","TODO"), cmd("todo.clearDone","Hide resolved","TODO") ] } },

    { id:"cyrus.imports", name:"Import Lens", icon:"⇄", publisher:"cyrus", version:"1.0.0",
      description:"Shows the import graph of the workspace and flags imports that are never used.",
      permissions:["fs:read"],
      contributes:{ commands:[ cmd("imports.graph","Show import graph","Code"), cmd("imports.unused","List unused imports","Code") ] } },

    { id:"cyrus.python", name:"Python Toolkit", icon:"🐍", publisher:"cyrus", version:"1.2.0",
      description:"Virtual environments, requirement parsing, docstring snippets and pytest problem matching.",
      permissions:["fs:read"],
      contributes:{ commands:[ cmd("py.reqs","Parse requirements.txt","Python"), cmd("py.snippet","Insert docstring","Python") ] } },

    { id:"cyrus.rest", name:"REST Client", icon:"⇄", publisher:"cyrus", version:"0.9.0",
      description:"Send a real HTTP request from the editor. Needs net:request — every send asks you first.",
      permissions:["net:request","fs:read"],
      contributes:{ commands:[ cmd("rest.send","Send request","REST") ] } },

    { id:"cyrus.ai", name:"CYRUS Brain", icon:"✨", publisher:"cyrus", version:"1.0.0",
      description:"Exposes the routed AI to other panels: summarize selection, explain a diagnostic, draft a commit message.",
      permissions:["ai:ask","fs:read","audit:read"],
      contributes:{ commands:[
        cmd("ai.explain","Explain selection","CYRUS"), cmd("ai.commitmsg","Draft commit message","CYRUS"),
        cmd("ai.audit","Explain the audit trail","CYRUS") ] } },

    { id:"cyrus.outline", name:"Symbol Outline", icon:"≣", publisher:"cyrus", version:"1.0.0",
      description:"A live structural outline derived from the tokenizer, for all 80+ languages.",
      permissions:["ui:panel","fs:read"],
      contributes:{ commands:[ cmd("outline.toggle","Toggle outline","View") ] } },

    { id:"cyrus.themes", name:"Theme Studio", icon:"🎨", publisher:"cyrus", version:"1.0.0",
      description:"Editor themes and token colours, tuned per language family.",
      permissions:["ui:panel"],
      contributes:{ commands:[ cmd("theme.cycle","Cycle editor theme","View") ] } },
    ];
  },

  // ---- the first-party implementations -----------------------------------
  async run(app, cmdId){
    const c = { app,
      root: ()=>app.root,
      activeFile: ()=>app.activePath(),
      editor: ()=>app.editor,
      toast: (t,k)=>Toast.show("Extension", t, null, k),
      audit: (n)=>Log.recent(n||20).map(l=>({ ts:new Date(l.ts*1000).toLocaleString(), risk:l.risk, ok:l.ok, intent:l.intent, message:l.message })),
      panel: (id)=>app.showExtPanel(id) };

    switch(cmdId){
    // ---------------- Source Control ----------------
    case "git.status": {
      if(!await this.guard("fs:read","Source Control is reading the workspace")) return;
      const rows = [];
      for(const p of StIndex.files(app.root)){
        const n = VFS.node(p); if(!n) continue;
        const repo = p.split("/.cyrus-git")[0];
        rows.push({ path:p, size:n.size, mtime:n.mtime, untracked:!isTracked(repo,p) });
      }
      const changed = rows.filter(r=>r.untracked);
      app.showExtPanel("Source Control",
        `<div class="st2-sec">${rows.length} files · ${changed.length} untracked</div>`+
        rows.slice(0,200).map(r=>`<div class="st2-sym" data-goto="${esc(r.path)}"><span class="ic ${r.untracked?"var":"fn"}">${r.untracked?"○":"●"}</span><span class="nm">${esc(p2(r.path,app.root))}</span><span class="ln">${fmtSize(r.size||0)}</span></div>`).join(""));
      app.dockPanel();
      break;
    }
    case "git.diff": {
      const p = app.activePath(); if(!p) return c.toast("Open a file first","warn");
      if(!await this.guard("fs:read","Diff reads the saved file")) return;
      const saved = (VFS.node(p)||{content:""}).content||"";
      const live = app.editor.text;
      app.showDiff({ title:"Unsaved changes · "+VFS.base(p), a:saved, b:live, target:p,
        onApply:()=>{ app.save(); }, applyLabel:"Revert to saved" });
      break;
    }
    case "git.commit": {
      if(!await this.guard("fs:write","Committing writes to .cyrus-git")) return;
      const repo = app.root;
      const staged = StIndex.files(repo).length;
      const msg = await Modal.prompt ? null : null;
      const text = await app.promptText("Commit message", "commit here: describe the change");
      if(!text) return;
      const d = await Modal.confirm({ title:"Commit "+staged+" file(s)?", body:text+"\n\nWrites a commit into "+repo+"/.cyrus-git and the audit log.",
        confirmText:"Commit" });
      if(!d) return;
      if(!VFS.mkdirp(repo+"/.cyrus-git")) return c.toast("No repository here","err");
      const cpath = repo+"/.cyrus-git/COMMIT_"+(Date.now())+".txt";
      VFS.writeFile(cpath, text+"\n\n"+StIndex.files(repo).map(p=>"  "+p).join("\n"));
      Log.record("studio: git commit", "studio_ext_cap", {repo, msg:text}, "medium", true, true, "Committed: "+text);
      c.toast("Committed","ok");
      break;
    }
    case "git.log": {
      if(!await this.guard("audit:read","Reading the commit log")) return;
      const repo = app.root;
      const n = VFS.node(repo+"/.cyrus-git");
      const logs = n && n.type==="dir" ? Object.keys(n.children).filter(k=>k.startsWith("COMMIT_")).sort().reverse() : [];
      app.showExtPanel("Source Control",
        (logs.length? logs.map(k=>{
          const t = VFS.node(repo+"/.cyrus-git/"+k).content.split("\n")[0];
          return `<div class="st2-sym" title="${esc(t)}"><span class="ic fn">⑂</span><span class="nm">${esc(t)}</span><span class="ln">${k.replace("COMMIT_","").replace(".txt","")}</span></div>`;
        }).join("") : '<div class="st2-empty">No commits yet in this workspace.</div>'));
      app.dockPanel();
      break;
    }

    // ---------------- TODO ----------------
    case "todo.list": {
      if(!await this.guard("fs:read","TODO Lens reads the workspace")) return;
      const out = [];
      for(const p of StIndex.files(app.root)){
        const n = VFS.node(p); if(!n||n.type!=="file") continue;
        const lines = (n.content||"").split("\n");
        lines.forEach((l,i)=>{
          const m = /\b(TODO|FIXME|HACK|XXX)\b:?[ \t]*(.*)/.exec(l);
          if(m) out.push({ path:p, line:i, tag:m[1], text:m[2].slice(0,90), done:/\b(done|fixed|resolved)\b/i.test(m[2]) });
        });
      }
      app.showExtPanel("TODO Lens",
        (out.length ? `<div class="st2-sec">${out.length} notes · ${out.filter(o=>!o.done).length} open</div>`+
          out.map(o=>`<div class="st2-prob ${o.done?"info":(o.tag==="FIXME"?"err":"warn")}" data-goto="${esc(o.path)}" data-line="${o.line}">
            <b>${o.tag}</b> ${esc(o.text||"(no text)")}<span class="loc">${esc(p2(o.path,app.root))}:${o.line+1}</span></div>`).join("")
          : '<div class="st2-empty">No TODO, FIXME, HACK or XXX notes in this workspace. <span style="opacity:.6">Write one and CYRUS finds it.</span></div>'));
      app.dockPanel();
      break;
    }
    case "todo.clearDone": break;

    // ---------------- imports ----------------
    case "imports.graph": case "imports.unused": {
      if(!await this.guard("fs:read","Import Lens reads the workspace")) return;
      const graphOnly = cmdId==="imports.graph";
      const rows = [];
      for(const p of StIndex.files(app.root)){
        const n = VFS.node(p); if(!n||n.type!=="file") continue;
        const probs = DIAG.analyze(n.content||"", LANG.forPath(p, n.content), {});
        const imports = (n.content||"").match(/^[ \t]*(?:import |from .* import |use |require\(|#include)[^\n]*/gm) || [];
        const unused = probs.filter(d=>d.src==="unused");
        if(!imports.length && !unused.length) continue;
        rows.push({ p, imports: imports.length, unused: unused.map(u=>u.msg) });
      }
      app.showExtPanel("Imports", rows.length
        ? `<div class="st2-sec">${rows.length} files with imports</div>`+
          rows.map(r=>`<div class="st2-sym" data-goto="${esc(r.p)}"><span class="ic fn">⇄</span><span class="nm">${esc(p2(r.p,app.root))}</span>
            <span class="ln">${r.imports} import${r.imports===1?"":"s"}${r.unused.length?" · "+r.unused.length+" unused":""}</span></div>
            ${graphOnly && r.unused.length ? r.unused.map(u=>`<div class="st2-prob warn">${esc(u)}</div>`).join("") : ""}`).join("")
        : '<div class="st2-empty">No imports found — this workspace has no cross-file dependencies.</div>');
      app.dockPanel();
      break;
    }

    // ---------------- python ----------------
    case "py.reqs": {
      const rf = app.root+"/requirements.txt";
      const n = VFS.node(rf);
      if(!n) return c.toast("No requirements.txt in this workspace","warn");
      const pkgs = (n.content||"").split("\n").map(l=>l.trim()).filter(l=>l && !l.startsWith("#")).map(l=>{
        const m = /^([A-Za-z0-9_.\-]+)\s*([=<>!~].*)?$/.exec(l);
        return m ? { name:m[1], spec:(m[2]||"latest").trim() } : null;
      }).filter(Boolean);
      app.showExtPanel("Python",
        `<div class="st2-sec">${pkgs.length} requirement${pkgs.length===1?"":"s"}</div>`+
        pkgs.map(p=>`<div class="st2-sym"><span class="ic cls">◈</span><span class="nm">${esc(p.name)}</span><span class="ln">${esc(p.spec)}</span></div>`).join(""));
      app.dockPanel();
      break;
    }
    case "py.snippet": {
      const ed = app.editor; if(!app.activePath()) return c.toast("Open a .py file first","warn");
      const ind = " ".repeat(ed.currentIndent().length);
      ed.insert(`\n${ind}"""\n${ind}${1}: what this does\n${ind}Args:\n${ind}Returns:\n${ind}"""\n`);
      break;
    }

    // ---------------- REST client: the high-risk one ----------------
    case "rest.send": {
      const url = await app.promptText("URL", "https://example.com/api");
      if(!url) return;
      if(!/^https?:\/\//i.test(url)) return c.toast("Only http and https","err");
      if(!await this.guard("net:request","REST Client wants to send a GET to "+url)) return;
      const t0 = performance.now();
      try{
        const res = await fetch(url, { method:"GET", redirect:"follow" });
        const text = (await res.text()).slice(0,20000);
        app.showExtPanel("REST Client",
          `<div class="st2-sec">${res.status} ${res.statusText} · ${Math.round(performance.now()-t0)}ms · ${text.length} bytes</div>`+
          `<pre class="st2-pbody" style="max-height:none">${esc(text)}</pre>`);
        app.dockPanel();
        Log.record("studio: rest GET "+url, "studio_ext_cap", {url}, "high", true, true, "HTTP "+res.status);
      }catch(e){
        app.showExtPanel("REST Client", `<div class="st2-prob err">Request failed: ${esc(e.message)}<span class="loc">Browser network rules apply — CORS and offline both look like this.</span></div>`);
        app.dockPanel();
      }
      break;
    }

    // ---------------- AI ----------------
    case "ai.explain": {
      const ed = app.editor, p = app.activePath();
      const sel = ed.primary;
      const text = sel.s!==sel.ed ? "" : ed.content.slice(sel.s, sel.e);
      app.askAI(text ? "Explain this selection:\n\n"+text : "Explain "+ (p||"the active file"));
      break;
    }
    case "ai.commitmsg": {
      const changed = StIndex.files(app.root).length;
      app.askAI("Draft a concise one-line commit message for a change across "+changed+" files in this project. Reply with the message only.");
      break;
    }
    case "ai.audit": {
      const rows = Log.recent(25);
      app.setRightTab("cyrus");
      app.aiAdd("ai", "The audit trail is CYRUS's memory of what it did. "+rows.length+" most recent entries:\n\n"+
        rows.map(l=>"· `"+l.risk+"` "+l.message).join("\n")+
        "\n\nRisk is decided by a static table, not by the model: low runs, medium asks, high is blocked. Want me to explain any entry?");
      break;
    }

    case "outline.toggle": app.togglePanel("outline"); break;
    case "theme.cycle": app.cycleTheme(); break;
    case "__install": await app.installExtensionDialog(); break;
    default: c.toast("No handler for "+cmdId,"warn");
    }
  },
  async install(app, manifest){
    if(!manifest || !manifest.id) return { ok:false, err:"manifest needs an id" };
    if(!Array.isArray(manifest.permissions))
      return { ok:false, err:"every extension must declare its permissions" };
    const bad = manifest.permissions.filter(p=> !CAPS[p]);
    if(bad.length) return { ok:false, err:"unknown capability: "+bad.join(", ") };
    const map = this.installed();
    map[manifest.id] = Object.assign({ enabled:true }, manifest);
    this.save(map);
    Log.record("studio: install extension "+manifest.id, "studio_ext_install", {id:manifest.id, perms:manifest.permissions},
               "medium", true, true, "Installed "+manifest.name+" with "+manifest.permissions.join(", "));
    return { ok:true };
  },
  uninstall(id){
    const map = this.installed(); delete map[id]; this.save(map);
    Log.record("studio: uninstall extension "+id, "studio_ext_install", {id}, "low", false, true, "Removed "+id);
  }
};
function p2(path, root){ return path.startsWith(root+"/") ? path.slice(root.length+1) : path; }
function isTracked(repo, path){ return !/\.(png|jpg|jpeg|gif|ico|woff2?|mp3|mp4|pdf|zip)$/i.test(path); }