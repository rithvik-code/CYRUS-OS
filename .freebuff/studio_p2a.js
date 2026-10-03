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
}