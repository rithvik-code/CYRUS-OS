// ---------------------------------------------------------------------------
// PHASE 2 — THE EXPLORER
// Every mutation goes through StFS, which is policy-gated: a destructive op
// asks for confirmation and writes to the audit log like everything else in
// CYRUS OS. The explorer never talks to the VFS directly.
// ---------------------------------------------------------------------------
const StFS = {
  // risk table for editor file operations — mirrors the OS permission model
  risk(op, target, many){
    switch(op){
      case "read": case "open": return "low";
      case "write": case "newFile": case "newFolder": case "save": return "low";
      case "rename": case "copy": case "move": case "duplicate": case "paste": return "low";
      case "delete": return many ? "high" : "medium";
      case "saveAll": return "low";
      default: return "low";
    }
  },
  CRITICAL: ["/", "/home", "/home/rithvik", "/home/rithvik/Documents", "/home/rithvik/Projects"],
  // whole subtrees the editor must never rewrite, matched by prefix so a new
  // system directory cannot be reached by naming a child of it
  SYSTEM: ["/etc","/bin","/sbin","/lib","/usr","/var","/boot","/dev","/proc","/sys","/opt"],
  protected(p){ return this.CRITICAL.includes(p) || this.SYSTEM.some(s => p===s || p.startsWith(s+"/")); },

  async guard(op, targets, describe){
    targets = Array.isArray(targets) ? targets : [targets];
    const many = targets.length > 1;
    const critical = targets.filter(t => this.protected(t));
    if(critical.length){
      Log.record("studio: " + op, "studio_file_op", {op, targets}, "high", false, false,
                 "Blocked: " + describe + " on a critical path (" + critical.join(", ") + ")");
      Toast.show("CYRUS Studio", "Blocked — that path is protected by the OS policy.", null, "err");
      return false;
    }
    const risk = this.risk(op, targets, many);
    if(risk==="medium" || risk==="high"){
      const names = targets.slice(0,6).map(t=>VFS.base(t)||"/").join(", ") + (many?` +${targets.length-6} more`:"");
      const ok = await Modal.confirm({
        title: many ? `Delete ${targets.length} items?` : "Delete " + VFS.base(targets[0]) + "?",
        body: `${describe}\n\n${names}\n\nEvery delete is written to the audit log. This cannot be undone from inside Studio.`,
        confirmText:"Delete", danger:true });
      if(!ok){
        Log.record("studio: " + op, "studio_file_op", {op, targets}, risk, false, false, "Cancelled by user");
        return false;
      }
      targets.forEach(t=>VFS.remove(t));
      Log.record("studio: " + op, "studio_file_op", {op, targets}, risk, true, true, describe);
      Bus.emit("vfs");
      return true;
    }
    return true;
  },

  newFile(dir, name){
    const p = VFS.norm(dir, name);
    if(VFS.node(p)) return { ok:false, path:p, err:"A file or folder called “"+VFS.base(p)+"” already exists." };
    if(!VFS.writeFile(p, "")) return { ok:false, path:p, err:"Cannot create a file inside “"+VFS.base(dir)+"”." };
    Log.record("studio: new file " + p, "studio_file_op", {op:"newFile", path:p}, "low", false, true, "Created "+p);
    Bus.emit("vfs"); return { ok:true, path:p };
  },
  newFolder(dir, name){
    const p = VFS.norm(dir, name);
    if(VFS.node(p)) return { ok:false, path:p, err:"“"+VFS.base(p)+"” already exists." };
    if(!VFS.mkdirp(p)) return { ok:false, path:p, err:"Cannot create that folder." };
    Log.record("studio: new folder " + p, "studio_file_op", {op:"newFolder", path:p}, "low", false, true, "Created "+p);
    Bus.emit("vfs"); return { ok:true, path:p };
  },
  rename(from, toName){
    const to = VFS.norm(VFS.parent(from), toName);
    if(from===to) return { ok:false, err:"Same name." };
    if(VFS.node(to)) return { ok:false, err:"“"+VFS.base(to)+"” already exists here." };
    const node = VFS.detach(from);
    if(!node) return { ok:false, err:"Not found." };
    node.name = toName;
    VFS.attach(VFS.parent(to), node);
    Log.record(`studio: rename ${from} → ${to}`, "studio_file_op", {op:"rename", from, to}, "low", false, true, "Renamed");
    Bus.emit("vfs"); return { ok:true, path:to };
  },
  copy(paths, destDir){
    let n = 0;
    for(const p of paths){
      const node = VFS.node(p); if(!node) continue;
      const clone = JSON.parse(JSON.stringify(node));
      let name = node.name, i = 1;
      while(VFS.node(VFS.norm(destDir, name))){ const dot = name.lastIndexOf("."); name = dot>0 ? name.slice(0,dot)+" copy"+i+name.slice(dot) : name+" copy"+i; i++; }
      clone.name = name;
      VFS.attach(destDir, clone); n++;
    }
    if(n) Log.record(`studio: copy ${n} item(s) → ${destDir}`, "studio_file_op", {op:"copy", paths, destDir}, "low", false, true, "Copied "+n);
    Bus.emit("vfs"); return { ok:true, n };
  },
  duplicate(paths){
    let n = 0;
    for(const p of paths){
      const dir = VFS.parent(p);
      const r = StFS.copy([p], dir);
      if(r.ok) n++;
    }
    return { ok:true, n };
  },
  move(paths, destDir){
    let n = 0;
    for(const p of paths){
      if(destDir===p || destDir.startsWith(p+"/")) continue;
      if(VFS.move(p, destDir)) n++;
      else Log.record("studio: move " + p, "studio_file_op", {op:"move", from:p, to:destDir}, "low", false, false, "Move failed");
    }
    if(n) Log.record(`studio: move ${n} item(s) → ${destDir}`, "studio_file_op", {op:"move", paths, destDir}, "low", false, true, "Moved "+n);
    Bus.emit("vfs"); return { ok:true, n };
  },
  uniqueName(dir, base){
    let name = base, i = 1;
    while(VFS.node(VFS.norm(dir, name))){ const d = base.lastIndexOf("."); name = d>0 ? base.slice(0,d)+" "+i+base.slice(d) : base+" "+i; i++; }
    return name;
  },
  // render a file as a tree-selectable target for open-with
  countLines(p){ const n=VFS.node(p); return n&&n.type==="file" ? (n.content||"").split("\n").length : 0; }
};

// ---- explorer ------------------------------------------------------------
class StExplorer {
  constructor(host, opts){
    this.host = host;
    this.on = opts.on || {};
    this.root = opts.root || "/home/rithvik";
    this.sel = [];
    this.clip = null;
    this.expanded = new Set([this.root]);
    this.problems = {};
    this.filter = "";
    this._drag = null;
    this.render();
  }
  setRoot(p){
    if(!VFS.node(p)) return;
    this.root = p;
    this.sel = [];
    this.expanded = new Set([p]);
    this.render();
  }
  setProblems(map){ this.problems = map || {}; this.render(); }

  visible(){
    const rows = [];
    const walk = (p, depth) => {
      const node = VFS.node(p);
      if(!node || node.type!=="dir") return;
      const keys = Object.keys(node.children).sort((a,b)=>{
        const A=node.children[a], B=node.children[b];
        return (A.type===B.type) ? A.name.localeCompare(B.name, undefined, {numeric:true}) : (A.type==="dir"?-1:1);
      });
      for(const name of keys){
        const cp = p+"/"+name;
        const c = node.children[name];
        const isDir = c.type==="dir";
        const hidden = name.startsWith(".") && name!==".gitignore" && name!==".env";
        if(hidden && !this.expanded.has(p+"!")) continue;
        if(this.filter && !this._matches(cp,c)) continue;
        rows.push({ path:cp, name, type:c.type, depth, mtime:c.mtime, size:c.size });
        if(isDir && this.expanded.has(cp)) walk(cp, depth+1);
      }
    };
    walk(this.root, 0);
    return rows;
  }
  _matches(p, node){
    const q = this.filter.toLowerCase();
    if(node.type==="dir") return true;   // keep folders so the match below is reachable
    if(node.name.toLowerCase().includes(q)) return true;
    if(q.length>2 && node.content && node.content.toLowerCase().includes(q)) return true;
    return false;
  }

  render(){
    const rows = this.visible();
    if(!rows.length){
      this.host.innerHTML = '<div class="st2-empty">'+(this.filter?"No matches for “"+esc(this.filter)+"”":"This folder is empty")+"</div>";
      return;
    }
    const html = rows.map(r=>{
      const isDir = r.type==="dir";
      const sel = this.sel.includes(r.path);
      const open = isDir && this.expanded.has(r.path);
      const probs = this.problems[r.path];
      const bad = probs ? (probs.err?'<span class="bad" title="'+probs.err+' errors"></span>':'<span class="mod" title="'+probs.warn+' warnings"></span>') : "";
      const cut = this.clip && this.clip.mode==="cut" && this.clip.paths.includes(r.path);
      const tag = LANG.forPath(r.path).id;
      const disp = tag==="plain" ? "📄" : LANG.byId.get(tag) ? ({"javascript":"🟨","typescript":"🟦","python":"🐍","html":"🌐","css":"🎨","markdown":"📘","json":"🧩"}[tag] || "📄") : "📄";
      return `<div class="st2-row ${isDir?"dir":"file"} ${sel?"on":""} ${cut?"cut":""}" data-p="${esc(r.path)}" data-d="${r.depth}" draggable="true" title="${esc(r.path)}">
        <span class="tw ${open?"":"closed"}">${isDir?"▾":"·"}</span>
        <span>${isDir?"📁":disp}</span><span class="nm">${esc(r.name)}</span>${bad}
      </div>`;
    }).join("");
    this.host.innerHTML = html;
    this._wire();
  }

  _wire(){
    const rows = [...this.host.querySelectorAll(".st2-row")];
    rows.forEach(row=>{
      const p = row.dataset.p;
      row.addEventListener("mousedown", e=>{
        if(e.button===2) return;
        if(e.ctrlKey||e.metaKey) this.toggleSel(p);
        else if(e.shiftKey) this.rangeSel(p);
        else if(!this.sel.includes(p)) this.select(p);
        // the chevron is the only collapse affordance; clicking the row opens a folder
        const node = VFS.node(p);
        if(node && node.type==="dir"){
          if(e.target.closest(".tw")) this.toggle(p);
          else if(!this.expanded.has(p)) this.toggle(p);
        }
        this.on.activate && this.on.activate(this.selection());
      });
      row.addEventListener("dblclick", ()=>this.open(p));
      row.addEventListener("contextmenu", e=>{
        e.preventDefault(); e.stopPropagation();
        if(!this.sel.includes(p)) this.select(p);
        if(this.on.context) this.on.context(this.selection(), e.clientX, e.clientY);
      });
      row.addEventListener("dragstart", e=>{
        if(!this.sel.includes(p)) this.select(p);
        this._drag = this.selection();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", p);
      });
      row.addEventListener("dragover", e=>{
        const n = VFS.node(p);
        if(!n || n.type!=="dir") return;
        e.preventDefault(); e.dataTransfer.dropEffect = "move";
        row.style.boxShadow = "inset 0 0 0 1.5px var(--accent)";
      });
      row.addEventListener("dragleave", ()=>{ row.style.boxShadow=""; });
      row.addEventListener("drop", async e=>{
        e.preventDefault(); row.style.boxShadow="";
        const n = VFS.node(p); if(!n||n.type!=="dir") return;
        const srcs = (e.dataTransfer.getData("text/plain")||"").split("\n").filter(Boolean);
        if(!srcs.length) return;
        StFS.move(srcs, p);
        this.expanded.add(p);
        this.render();
        if(this.on.changed) this.on.changed();
      });
    });
  }
  select(p){ this.sel = [p]; this.render(); }
  toggleSel(p){ this.sel = this.sel.includes(p) ? this.sel.filter(x=>x!==p) : this.sel.concat([p]); this.render(); }
  rangeSel(p){
    const rows = this.visible().map(r=>r.path);
    const a = this.sel.length ? rows.indexOf(this.sel[this.sel.length-1]) : -1;
    const b = rows.indexOf(p);
    if(a<0 || b<0) return this.select(p);
    this.sel = rows.slice(Math.min(a,b), Math.max(a,b)+1);
    this.render();
  }
  selection(){ return this.sel.length ? this.sel.slice() : []; }
  primarySel(){ return this.sel[this.sel.length-1] || null; }

  toggle(p){
    if(this.expanded.has(p)) this.expanded.delete(p); else this.expanded.add(p);
    this.render();
    if(this.on.expanded) this.on.expanded([...this.expanded]);
  }
  async open(p){
    const n = VFS.node(p);
    if(!n){ Toast.show("Studio","Not found: "+p,null,"err"); return; }
    if(n.type==="dir"){ this.expanded.add(p); this.render(); return; }
    this.expanded.add(VFS.parent(p));
    this.render();
    this.select(p);
    if(this.on.open) this.on.open(p);
  }
  reveal(p){
    const parts = p.split("/").filter(Boolean);
    let cur = "";
    parts.forEach(seg=>{ cur += "/"+seg; this.expanded.add(cur); });
    this.sel = [p];
    this.render();
  }
  copy(){ this.clip = { mode:"copy", paths:this.selection() }; this.render(); if(this.on.changed) this.on.changed(); }
  cut(){ this.clip = { mode:"cut", paths:this.selection() }; this.render(); if(this.on.changed) this.on.changed(); }
  async paste(destDir){
    const d = destDir || (this.primarySel() ? (VFS.node(this.primarySel())?.type==="dir" ? this.primarySel() : VFS.parent(this.primarySel())) : this.root);
    if(!this.clip){ Toast.show("Studio","Clipboard is empty",null,"warn"); return; }
    if(this.clip.mode==="copy"){ const r = StFS.copy(this.clip.paths, d); Toast.show("Studio","Copied "+r.n+" item"+(r.n===1?"":"s"),null,"ok"); }
    else { const r = StFS.move(this.clip.paths, d); Toast.show("Studio","Moved "+r.n+" item"+(r.n===1?"":"s"),null,"ok"); this.clip=null; }
    this.expanded.add(d); this.render();
    if(this.on.changed) this.on.changed();
  }
  async remove(){
    const paths = this.selection();
    if(!paths.length) return;
    const n = await StFS.guard("delete", paths, "Deleting from the workspace");
    if(n){ this.sel = []; this.render(); if(this.on.changed) this.on.changed(); }
  }
  async duplicateSel(){
    const paths = this.selection(); if(!paths.length) return;
    const r = StFS.duplicate(paths);
    Toast.show("Studio","Duplicated "+r.n+" item"+(r.n===1?"":"s"),null,"ok");
    this.render(); if(this.on.changed) this.on.changed();
  }
  async renameInline(p){
    const n = VFS.node(p); if(!n) return;
    const rows = [...this.host.querySelectorAll(".st2-row")];
    const row = rows.find(r=>r.dataset.p===p); if(!row) return;
    const nm = row.querySelector(".nm");
    const input = el("input");
    input.value = n.name;
    input.style.cssText = "background:#0d0820;border:1px solid var(--accent);border-radius:4px;color:#e6dffc;font-size:12.5px;padding:1px 5px;width:130px;font-family:inherit";
    nm.replaceWith(input);
    input.focus(); input.select();
    const finish = async (ok)=>{
      const v = input.value.trim();
      if(ok && v && v!==n.name){
        const r = StFS.rename(p, v);
        if(!r.ok) Toast.show("Studio", r.err, null, "err");
        else if(this.on.renamed) this.on.renamed(p, r.path);
      }
      this.render(); if(this.on.changed) this.on.changed();
    };
    input.addEventListener("blur", ()=>finish(true));
    input.addEventListener("keydown", e=>{
      e.stopPropagation();
      if(e.key==="Enter"){ e.preventDefault(); finish(true); }
      if(e.key==="Escape"){ e.preventDefault(); finish(false); }
    });
  }
  search(q){ this.filter = q||""; this.render(); }
}// ---------------------------------------------------------------------------
// PHASE 3 — cyrus.project.json
// The "perfectly defined workspace": Studio reads the project instead of
// guessing. One file declares roots, entry points, run configs, env, the
// folders extensions may touch, and the instructions the AI is held to.
// ---------------------------------------------------------------------------
const MANIFEST = "cyrus.project.json";

const StProject = {
  MANIFEST,
  markers: ["cyrus.project.json","package.json","pyproject.toml","Cargo.toml","go.mod",
            "pom.xml","build.gradle","requirements.txt","setup.py","Makefile",".git","deno.json","composer.json"],

  // walk up from a folder looking for a project marker
  detect(from){
    let p = VFS.norm("/", from||"/");
    let guard = 0;
    while(guard++ < 40){
      for(const m of this.markers){
        if(VFS.node(p+"/"+m)) return { root:p, marker:m, manifest: m===MANIFEST ? p+"/"+m : null };
      }
      if(p==="/" || p==="") break;
      p = VFS.parent(p);
    }
    return null;
  },
  path(root){ return VFS.norm(root||"/", MANIFEST); },

  read(root){
    const p = this.path(root);
    const n = VFS.node(p);
    if(!n || n.type!=="file") return null;
    try{
      const j = JSON.parse(n.content);
      return j && typeof j==="object" ? j : null;
    }catch(e){ return { __error: e.message }; }
  },
  write(root, obj){
    const p = this.path(root);
    const text = JSON.stringify(obj, null, 2);
    if(!VFS.writeFile(p, text)) return { ok:false, err:"Cannot write "+p };
    Log.record("studio: save "+MANIFEST, "studio_project", {root}, "low", false, true, "Workspace manifest updated");
    return { ok:true, path:p };
  },

  scaffold(root, name, kind){
    const obj = {
      name: name || VFS.base(root),
      version: "0.1.0",
      description: "",
      roots: ["."],
      exclude: ["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", "target", ".next"],
      entry: "",
      runs: [],
      env: {},
      ai: { instructions: "" },
      extensions: []
    };
    const presets = {
      node: { entry:"src/index.js", runs:[{name:"start", command:"node src/index.js", watch:["src"]},
                {name:"test", command:"npm test"}],
              extensions:["javascript","git"] },
      python:{ entry:"main.py", runs:[{name:"start", command:"python main.py", watch:["."]},
                {name:"test", command:"python -m pytest -q"}], extensions:["python","git"] },
      rust:  { entry:"src/main.rs", runs:[{name:"build", command:"cargo build"},
                {name:"run", command:"cargo run"}, {name:"test", command:"cargo test"}], extensions:["rust","git"] },
      go:    { entry:"main.go", runs:[{name:"build", command:"go build ./..."},
                {name:"run", command:"go run ."}, {name:"test", command:"go test ./..."}], extensions:["go","git"] },
      static:{ entry:"index.html", runs:[{name:"preview", command:"open index.html"}], extensions:["html","css"] },
      blank: { }
    };
    Object.assign(obj, presets[kind||"blank"]||{});
    if(kind==="node") obj.dependencies = { "dependencies": {} };
    if(kind==="python") obj.dependencies = { "requires": ["python>=3.9"] };
    if(kind==="rust") obj.dependencies = { "crate": "", "edition": "2021" };
    if(kind==="go") obj.dependencies = { "module": (name||"app").replace(/[^a-z0-9]/gi,"").toLowerCase() };
    const r = this.write(root, obj);
    if(r.ok){
      if(kind==="node" && !VFS.node(root+"/src")){ VFS.mkdirp(root+"/src"); VFS.writeFile(root+"/src/index.js", "console.log('hello from "+obj.name+"');\n"); }
      if(kind==="python" && !VFS.node(root+"/main.py")) VFS.writeFile(root+"/main.py", 'def main():\n    print("hello from '+obj.name+'")\n\n\nif __name__ == "__main__":\n    main()\n');
      if(kind==="go" && !VFS.node(root+"/main.go")) VFS.writeFile(root+"/main.go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello from '+obj.name+'")\n}\n');
      if(kind==="rust"){ if(!VFS.node(root+"/src")) VFS.mkdirp(root+"/src");
        if(!VFS.node(root+"/Cargo.toml")) VFS.writeFile(root+"/Cargo.toml", '[package]\nname = "'+obj.name+'"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n');
        if(!VFS.node(root+"/src/main.rs")) VFS.writeFile(root+"/src/main.rs", 'fn main() {\n    println!("hello from '+obj.name+'");\n}\n'); }
      if(kind==="static" && !VFS.node(root+"/index.html")) VFS.writeFile(root+"/index.html", '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>'+obj.name+'</title></head>\n<body><h1>'+obj.name+'</h1></body>\n</html>\n');
    }
    return r;
  },

  // ---- what the manifest means to the rest of Studio --------------------
  resolved(root){
    const m = this.read(root) || {};
    const roots = Array.isArray(m.roots) && m.roots.length ? m.roots : ["."];
    const exclude = Array.isArray(m.exclude) ? m.exclude : ["node_modules",".git","__pycache__"];
    return {
      raw:m, roots, exclude,
      name: m.name || VFS.base(root),
      entry: m.entry || "",
      runs: Array.isArray(m.runs) ? m.runs : [],
      env: m.env || {},
      ai: m.ai || {},
      extensions: Array.isArray(m.extensions) ? m.extensions : [],
      deps: m.dependencies || {},
      error: m.__error || null
    };
  },
  inProject(root, path){
    const r = this.resolved(root);
    const rel = path.replace(root, "").replace(/^\//,"");
    const first = rel.split("/")[0];
    if(r.exclude.includes(first)) return false;
    if(r.roots.includes(".") || r.roots.includes("*")) return true;
    return r.roots.some(x=> rel===x || rel.startsWith(x+"/"));
  },
  // every source file the project declares
  files(root){
    const out = [];
    const walk = (p)=>{
      const n = VFS.node(p); if(!n) return;
      if(n.type==="file"){
        const ext = LANG.forPath(p);
        if(!["plain","json","csv","log","md"].includes(ext.id) || /\.(json|md)$/i.test(p)) out.push(p);
        return;
      }
      for(const name of Object.keys(n.children)) walk(p+"/"+name);
    };
    walk(root);
    return out.filter(p=>this.inProject(root,p)).sort();
  },
  // how the project actually writes code — learned, not declared
  learn(root){
    const files = this.files(root).slice(0,60);
    const stats = { indent:{2:0,4:0,tab:0}, quotes:{d:0,s:0}, semi:{on:0,off:0}, langs:{} };
    for(const p of files){
      const n = VFS.node(p); if(!n||n.type!=="file") continue;
      const spec = LANG.forPath(p, n.content);
      stats.langs[spec.name] = (stats.langs[spec.name]||0)+1;
      if(spec.markdown) continue;
      const lines = (n.content||"").split("\n").slice(0,400);
      for(const l of lines){
        const m = /^[ \t]+/.exec(l);
        if(!m) continue;
        if(m[0].includes("\t")) stats.indent.tab++;
        else if(m[0].length % 4 === 0) stats.indent[4]++;
        else stats.indent[2]++;
        if(/;\s*$/.test(l.trim())) stats.semi.on++;
        if(/;/.test(l) && !/for\s*\(/.test(l)) stats.semi.off++;
      }
      const dq = (n.content.match(/"/g)||[]).length, sq = (n.content.match(/'/g)||[]).length;
      if(spec.id==="python"){} else if(dq>=sq) stats.quotes.d+=dq; else stats.quotes.s+=sq;
    }
    const top = (o)=> Object.entries(o).sort((a,b)=>b[1]-a[1])[0]||["",0];
    const ind = top(stats.indent), q = top(stats.quotes);
    const langs = Object.entries(stats.langs).sort((a,b)=>b[1]-a[1]).slice(0,4).map(x=>x[0]+" "+Math.round(x[1]/files.length*100)+"%");
    return {
      indent: ind[0]==="tab" ? "tabs" : (ind[0]==="4" ? "4 spaces" : "2 spaces"),
      quotes: q[0]==="s" ? "single" : "double",
      semicolons: stats.semi.on >= stats.semi.off ? "yes" : "no",
      langs, files: files.length,
      summary: `${files.length} source files · ${ind[0]==="tab"?"tabs":ind[0]+"-space"} indent · ${q[0]==="s"?"single":"double"} quotes`
    };
  },
  // the prompt fragment every AI call in this workspace receives
  aiContext(root){
    const r = this.resolved(root);
    const s = this.learn(root);
    const lines = [];
    lines.push(`Workspace: ${r.name} (root ${root})`);
    if(r.entry) lines.push(`Entry point: ${r.entry}`);
    if(r.roots.length && r.roots[0]!==".") lines.push(`Source roots: ${r.roots.join(", ")}`);
    if(r.deps && Object.keys(r.deps).length) lines.push(`Dependencies: ${JSON.stringify(r.deps)}`);
    lines.push(`Observed style: ${s.summary}`);
    if(r.runs.length) lines.push(`Run configs: ${r.runs.map(x=>x.name+" = "+x.command).join(" | ")}`);
    if(r.ai.instructions) lines.push("Project instructions: " + r.ai.instructions);
    return lines.join("\n");
  },
  runFor(root, path){
    const r = this.resolved(root);
    if(!r.runs.length) return null;
    if(r.entry && path && (path===r.entry || path.startsWith(r.entry.split("/").slice(0,-1).join("/"))))
      return r.runs[0];
    const ext = LANG.forPath(path||"").id;
    const byLang = { javascript:["node","node"], typescript:["ts-node","tsc"], python:["python","python"], go:["go run","go"], rust:["cargo run","cargo"] };
    const pref = byLang[ext];
    if(!pref) return r.runs[0];
    return r.runs.find(x=> (x.command||"").startsWith(pref[0])) || r.runs[0];
  },
  suggestExports(root){
    // conventional entry files a project probably has
    const want = ["main.py","app.py","index.js","index.ts","src/index.js","src/main.rs","main.go","cmd/*/main.go",
                  "index.html","README.md","requirements.txt","package.json","Cargo.toml","go.mod"];
    const found = want.filter(w=>!w.includes("*") && VFS.node(root+"/"+w));
    return found;
  }
};// ---------------------------------------------------------------------------
// PHASE 4 — THE RUNNER
// What can actually run in a browser runs for real (JavaScript, JSON, HTML).
// What cannot is never faked: the panel names the host command, offers to copy
// it, and says plainly why it cannot run here. Honesty is the product thesis.
// ---------------------------------------------------------------------------
const StRun = {
  hostRuntime: { python:"python3", node:"node", rust:"cargo run", go:"go run", ruby:"ruby",
                 java:"java", php:"php", lua:"lua", r:"Rscript", julia:"julia", swift:"swift run" },
  runnable(langId){ return ["javascript","typescript","json","jsonc","html","xml","css","markdown"].includes(langId); },

  // resolve the command CYRUS would run, from the manifest when it declares one
  plan(root, path, content){
    const spec = LANG.forPath(path||"", content||"");
    const cfg = StProject.runFor(root, path);
    if(cfg) return { name:cfg.name||"run", command:cfg.command, watch:cfg.watch||[], fromManifest:true, spec };
    const host = this.hostRuntime[spec.id];
    return { name:"run", command: host ? `${host} ${path.replace(root+"/","")}` : null,
             watch:[], fromManifest:false, spec, noHost:!host && !this.runnable(spec.id) };
  },

  // execute. returns {ok, out, err, ms, kind}
  async exec(root, path, content){
    const t0 = performance.now();
    const spec = LANG.forPath(path||"", content||"");
    const r = { kind:spec.id, ok:true, out:"", err:"", ms:0, cmd:this.plan(root,path,content).command };

    if(spec.id==="json" || spec.id==="jsonc"){
      try{
        JSON.parse(String(content).replace(/^\s*\/\/.*$/gm,""));
        r.out = "Valid JSON ✓";
      }catch(e){ r.ok=false; r.err = e.message; }
      r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="html" || spec.id==="xml"){
      r.kind = "preview"; r.preview = content; r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="markdown"){
      r.kind = "preview"; r.preview = renderMarkdown(content); r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="css"){
      r.kind = "preview";
      r.preview = `<style>${content}</style><div style="font-family:system-ui;padding:20px;color:#111;background:#fff">
        <h1>Heading</h1><p>Paragraph text to show the stylesheet in context.</p>
        <button>Button</button><a href="#">Link</a></div>`;
      r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="javascript" || spec.id==="typescript"){
      let src = content;
      if(spec.id==="typescript"){
        src = stripTypes(content);
        r.out = "Type annotations stripped — CYRUS runs the JavaScript subset.\n";
      }
      r.kind = "js";
      const logs = [];
      const MAX = 4000;
      const fmt = a => a.map(x=>{ try{ return typeof x==="object"&&x!==null ? JSON.stringify(x) : String(x); }catch(e){ return String(x); } }).join(" ");
      const con = { log:(...a)=>logs.push(fmt(a)), info:(...a)=>logs.push(fmt(a)),
                    warn:(...a)=>logs.push("⚠ "+fmt(a)), error:(...a)=>{ logs.push("✖ "+fmt(a)); },
                    debug:(...a)=>logs.push(fmt(a)), table:(...a)=>logs.push(fmt(a)),
                    time:()=>{}, timeEnd:()=>{} };
      try{
        const fn = new Function("console","fetch","setTimeout","clearTimeout","setInterval","clearInterval",
                                "window","document","localStorage","alert","prompt","confirm", src + "\n//# sourceURL=" + path);
        const guarded = t => { if(logs.length>MAX) throw new Error("stopped after "+MAX+" log lines"); };
        await Promise.race([
          fn(con, undefined, (f,t)=>setTimeout(f,t), clearTimeout, setTimeout, clearInterval,
             undefined, undefined, undefined, undefined, undefined, ()=>false),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error("execution exceeded 3s — possible infinite loop")),3000))
        ]);
      }catch(e){
        r.ok = false;
        r.err = e.message;
        const m = /(\w+\.html?):(\d+)/.exec(e.stack||"");
        if(m) r.at = { line:+m[2] };
      }
      r.out = (r.out||"") + (logs.length ? logs.join("\n") : (r.ok ? "(ran — no console output)" : ""));
      r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="python"){
      r.kind = "python";
      const py = PyRun.run(content);
      r.out = py;
      if(/Traceback|Unsupported|SyntaxError/.test(py)) r.ok = false;
      r.note = "PyRun is a line-level sandbox: print and assignment are real; loops and control flow are not evaluated.";
      r.ms = performance.now()-t0; return r;
    }
    // everything else: name the command, do not pretend
    r.kind = "unavailable";
    r.ok = false;
    r.out = "No host runtime for " + spec.name + " inside the browser.";
    r.err = r.cmd ? `Run this in your terminal:\n\n  ${r.cmd}` : `CYRUS has no runner for .${(path.split(".").pop()||"")} — add a run config to ${MANIFEST}.`;
    r.ms = performance.now()-t0;
    return r;
  },

  // a run written to the audit log, exactly like every other OS action
  record(root, path, res){
    Log.record(`studio: run ${VFS.base(path)}`, "run_script", {path, kind:res.kind, ms:Math.round(res.ms)},
               res.ok ? "low" : "medium", false, res.ok,
               res.ok ? `Ran ${VFS.base(path)} (${res.kind}, ${Math.round(res.ms)}ms)` : `Run failed: ${(res.err||"").split("\n")[0]}`);
  }
};

function stripTypes(src){
  let s = src;
  s = s.replace(/^\s*(?:export\s+)?(?:interface|type)\s+\w+[\s\S]*?^\}/gm, "");
  s = s.replace(/\binterface\s+\w+\s*(?:extends\s+\w+\s*)?\{[^}]*\}/g, "");
  s = s.replace(/\btype\s+\w+\s*=\s*[^;]+;/g, "");
  s = s.replace(/^\s*import\s+type\b[^\n]*\n/gm, "");
  // `declare` statements are types-only: they have no runtime meaning at all,
  // so the whole line goes rather than trying to strip its annotations.
  s = s.replace(/^\s*declare\s+[^\n]*\n?/gm, "");
  s = s.replace(/\bas\s+const\b/g, "");
  // generic parameter list on an arrow function: <T,>(v) => ... -> (v) => ...
  s = s.replace(/<[A-Za-z_$][\w$<>\[\]|&.,\s]*,?>\s*(?=\()/g, "");
  // variable annotations: const x: number = 5  ->  const x = 5
  s = s.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>\[\]|&., ]*\s*=/g, "$1 $2 =");
  // value-position casts: x as Foo<T> -> x. Lookbehind so `a as B as C` fully strips;
  // `import { a as b }` is unaffected because `{` precedes the keyword.
  s = s.replace(/(?<=[\w$)\]])\s+as\s+[A-Za-z_$][\w$]*(?:<[^<>()]*>)?/g, "");
  // explicit type arguments on calls: foo<number>(x) -> foo(x)
  s = s.replace(/([\w$)\]])<[^<>()]*>(?=\s*\()/g, "$1");
  // return types: `): string {` -> `) {`. Runs BEFORE the parameter rule so the
  // parameter rule cannot chew the closing paren of a signature.
  s = s.replace(/(\))\s*:\s*[A-Za-z_$][\w$<>\[\]|&., ]*(\s*(?:\{|=>))/g, "$1$2");
  // parameter types: anchored to "(" or "," so object literals, ternaries and
  // labels (`{a: 1}`, `x ? a : b`, `case 1:`) are never mistaken for one.
  s = s.replace(/([(,]\s*)([A-Za-z_$][\w$]*)\s*\??\s*:\s*[A-Za-z_$][\w$<>\[\]|&., ]*(?=\s*[,)=])/g, "$1$2");
  s = s.replace(/\b(private|public|protected|readonly)\s+/g, "");
  s = s.replace(/\?\s*:/g, ":");
  s = s.replace(/!\./g, ".");
  return s;
}

function renderMarkdown(src){
  const escH = s => s.replace(/[&<>]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const blocks = [];
  let out = "", i = 0;
  while(i < src.length){
    const fence = /^```([\w-]*)\n([\s\S]*?)^```/m.exec(src.slice(i));
    if(fence){ out += "<pre><code>"+escH(fence[2].replace(/\n$/,""))+"</code></pre>"; i += fence[0].length; continue; }
    out += escH(src[i]); i++;
  }
  out = out
    .replace(/^###### (.*)$/gm, "<h6>$1</h6>").replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>").replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|\W)\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^(\s*)[-*+] /gm, "$1• ")
    .replace(/\n{2,}/g, "</p><p>");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#fff;color:#1b1b22;padding:22px 26px;line-height:1.65;font-size:14px;border-radius:6px;overflow:auto;height:100%">
    <style>.mdx h1{font-size:26px;border-bottom:1px solid #e5e5ea;padding-bottom:8px}
    .mdx h2{font-size:20px;border-bottom:1px solid #eee;padding-bottom:5px}.mdx h3{font-size:16px}
    .mdx code{background:#f2f2f5;padding:1px 5px;border-radius:4px;font-size:12.5px}
    .mdx pre{background:#f6f6f9;padding:10px 12px;border-radius:7px;overflow:auto}
    .mdx pre code{background:none;padding:0}.mdx blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:12px;color:#555}
    .mdx table{border-collapse:collapse}.mdx td,.mdx th{border:1px solid #ddd;padding:5px 9px}</style>
    <div class="mdx">${out}</div></div>`;
}

// ---- the simulated terminal ---------------------------------------------
const StTerm = {
  cwd: "/home/rithvik",
  history: [],
  hi: -1,
  async exec(line, ctx){
    const s = line.trim();
    if(!s) return "";
    this.history.push(s); this.hi = this.history.length;
    const [cmd, ...rest] = s.split(/\s+/);
    const arg = rest.join(" ");
    const echo = (o, cls)=> `<span class="${cls||"d"}">${esc(o)}</span>`;
    const abs = p => VFS.norm(this.cwd, p);
    switch(cmd){
      case "help":
        return echo("Available in this in-browser shell:","i")+"\n"+
          echo("  ls [path]        list a directory")+"\n"+
          echo("  cd <path>        change directory")+"\n"+
          echo("  cat <file>       print a file")+"\n"+
          echo("  tree <path>      show the tree")+"\n"+
          echo("  find <text>      search file names and contents")+"\n"+
          echo("  open <file>      open it in CYRUS Studio")+"\n"+
          echo("  run <file>       run it with the Studio runner")+"\n"+
          echo("  whoami           who you are")+"\n"+
          echo("  policy           the CYRUS permission table")+"\n"+
          echo("  audit            the last audit-log entries")+"\n"+
          echo("  clear            clear this panel")+"\n"+
          echo("Anything else is printed back with the command your terminal would need — CYRUS does not fake a shell it does not have.","d");
      case "ls": {
        const p = arg || this.cwd;
        const n = VFS.node(p);
        if(!n) return echo("ls: "+p+": no such path","e");
        if(n.type==="file") return echo(n.name,"d");
        const keys = Object.keys(n.children).sort();
        if(!keys.length) return echo("(empty)","d");
        return keys.map(k=>{
          const c = n.children[k];
          const tag = LANG.forPath(k).id;
          return c.type==="dir" ? echo("📁 "+k, "g") : echo((["javascript","typescript","python","html","css","json","markdown"].includes(tag)?"· ":"· ")+k, "d");
        }).join("   ");
      }
      case "cd": {
        const p = abs(arg || "/home/rithvik");
        const n = VFS.node(p);
        if(!n || n.type!=="dir") return echo("cd: "+p+": not a directory","e");
        this.cwd = p; return echo("→ "+p,"d");
      }
      case "pwd": return echo(this.cwd,"d");
      case "cat": {
        const p = abs(arg);
        const n = VFS.node(p);
        if(!n || n.type!=="file") return echo("cat: "+arg+": no such file","e");
        return esc(n.content||"");
      }
      case "tree": {
        const p = abs(arg || this.cwd);
        const lines = [esc(p)];
        const walk = (q, d)=>{
          const n = VFS.node(q); if(!n||n.type!=="dir"||d>4) return;
          Object.keys(n.children).sort().forEach(k=>{
            const c = n.children[k];
            lines.push(esc("  ".repeat(d+1)+(c.type==="dir"?"📁 ":"· ")+k));
            if(c.type==="dir") walk(q+"/"+k, d+1);
          });
        };
        walk(p,0);
        return lines.join("\n");
      }
      case "find": {
        if(!arg) return echo("find: what are you looking for?","e");
        const q = arg.toLowerCase(); const hits = [];
        VFS.walk(this.cwd, (p,n)=>{
          if(n.type==="file" && (n.name.toLowerCase().includes(q) || (n.content||"").toLowerCase().includes(q)))
            hits.push(p);
        });
        return hits.length ? hits.slice(0,60).map(esc).join("\n") : echo("no matches","d");
      }
      case "open": {
        const p = abs(arg);
        if(!VFS.node(p)) return echo("open: "+arg+": not found","e");
        if(ctx && ctx.open) ctx.open(p);
        return echo("opened "+p+" in CYRUS Studio","d");
      }
      case "run": {
        const p = abs(arg);
        const n = VFS.node(p);
        if(!n || n.type!=="file") return echo("run: "+arg+": not a file","e");
        if(ctx && ctx.run) await ctx.run(p);
        return echo("running "+VFS.base(p)+"…","d");
      }
      case "whoami": return echo("rithvik — the owner of this CYRUS OS. Every action you take is in the audit log.","d");
      case "policy":
        return echo("low  → run   ·   medium → confirm   ·   high → blocked","i")+"\n"+
               echo("read/write/new/rename/move/copy   → low (run)","d")+"\n"+
               echo("delete one                         → medium (confirm)","d")+"\n"+
               echo("delete many, or a critical path    → high (blocked)","d");
      case "audit":
        return Log.recent(12).map(l=>esc(
          new Date(l.ts*1000).toLocaleTimeString()+"  "+l.risk.padEnd(7)+" "+(l.ok?"ok  ":"FAIL")+"  "+l.message)).join("\n") || echo("(empty)","d");
      case "clear": return "\u0000CLEAR";
      default:
        return echo("$ "+cmd+" "+arg+"  — no such built-in.","i")+"\n"+
               echo("In your real terminal that would run as:", "d")+"\n"+
               "  "+esc(s)+"\n"+
               echo("CYRUS runs commands it understands and names the ones it does not. Try `help`.","d");
    }
  }
};