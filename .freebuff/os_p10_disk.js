// ============================================================================
//  OS PHASE 10 — REAL DISK
//  Phase 0 LANG · Phase 1 EDIT · Phase 2 XPL · Phase 3 PROJ · Phase 4 RUN
//  Phase 5 AI · Phase 6 NAV · Phase 7 EXT · Phase 8 POLISH · Phase 10 DISK
// ============================================================================
//  What this adds, and what it deliberately does not do.
//
//  CYRUS used to have exactly one filesystem: an in-memory tree inside a
//  localStorage JSON blob. Every window, the explorer and the shell talked to
//  it and nothing else existed. That is why `ls /` could never show a real
//  folder — there wasn't one to show.
//
//  This adds a `/mnt/<name>/...` namespace. A path under `/mnt/` is routed to a
//  backend; every other path keeps hitting the original tree **byte for byte**.
//  That is the whole trick. Nothing inside VFS was rewritten, no call site was
//  edited, and with nothing mounted CYRUS behaves exactly as it did before.
//
//  THE MIRROR IS NOT OPTIONAL — READ THIS BEFORE EDITING
//  ---------------------------------------------------
//  VFS is synchronous. Every one of its callers — the Files app, `cat`, the
//  Studio explorer, `rm` — expects a value back immediately. The three real
//  backends are not synchronous: `showDirectoryPicker()` hands back a promise,
//  and the bridge is HTTP. So a mount keeps a *mirror* of the real tree in
//  memory, built by an async `scan()`. Reads come from the mirror; writes
//  update the mirror immediately (so the rest of the OS sees a consistent
//  filesystem) and are pushed to the real device in the background.
//
//  The consequence, stated plainly rather than hidden: between a `write()` and
//  the push landing, a crash loses that write. `Mnt.flush()` resolves once
//  everything has landed, and every mount shows its own last-sync time, so the
//  window is visible rather than assumed away.
//
//  SAFETY
//  ------
//  A `showDirectoryPicker()` handle is scoped by the browser to the folder the
//  user actually chose — a mount physically cannot escape its root. The bridge
//  confines every path to `indexed_paths` in config.yaml and refuses to spawn a
//  shell, so CYRUS still never hands the model a terminal. Both are audited
//  through the same Log the rest of the OS uses.
// ============================================================================

// ------------------------------------------------ shared namespace
// Every later OS phase hangs off this one object. Defined here because this is
// the first chunk the build splices.
const Cyrus = {
  version:"p10-disk",
  // Defer work that touches globals defined *after* the splice point.
  // The marker sits at ~line 8586, but SCHEMAS / IntentEngine / Actions are
  // declared ~line 10100+, so a chunk that reads them at load time would throw
  // a temporal-dead-zone ReferenceError. `onReady` fires after the whole script
  // has run.
  _ready:[], _readyFired:false,
  onReady(fn){ if(this._readyFired){ try{ fn(); }catch(e){ console.error("[cyrus:onReady]",e); } } else this._ready.push(fn); },
  fireReady(){ if(this._readyFired) return; this._readyFired=true; this._ready.splice(0).forEach(fn=>{ try{ fn(); }catch(e){ console.error("[cyrus:onReady]",e); } }); },
  el(tag, cls, html){ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; },
  // `esc`, `fmtSize`, `sleep`, `Log`, `Toast`, `Modal`, `VFS`, `Store`, `Apps`,
  // `WM`, `Bus`, `CMDS`, `MAN` are all declared above the splice point and are
  // reachable directly. Anything below it must go through `onReady`.
  audit(user_text, intent, fields, risk, confirmed, ok, message){
    try{ Log.record(user_text, intent, fields, risk, confirmed, ok, message); }catch(e){ console.error("[cyrus:audit]",e); }
  },
};
// One timer after the script finishes is enough, and it costs no polling.
if(typeof window!=="undefined") setTimeout(()=>Cyrus.fireReady(), 0);

// A file too big to hold in the mirror is represented by size + mtime only.
// 1 MB is well past what the editor or `cat` can usefully show in one go.
const MIRROR_MAX = 1048576;

// ============================================================================
//  Mnt — the mount registry
// ============================================================================
const Mnt = {
  // name -> { name, label, kind, root, perms:{read,write}, tree, ready,
  //           lastSync, error, backend, dirty:Set<relPath> }
  mounts:new Map(),
  LISTENERS:[],

  get(name){ return this.mounts.get(name) || null; },
  names(){ return [...this.mounts.keys()]; },
  list(){ return [...this.mounts.values()]; },
  onChange(fn){ this.LISTENERS.push(fn); },
  emitChange(){ this.LISTENERS.forEach(f=>{ try{ f(); }catch(e){ console.error("[mnt:onChange]",e); } }); Bus.emit("mnt"); },

  // Parse "/mnt/real/Documents/a.txt" into {mount, sub:"/Documents/a.txt"}.
  // Returns null for any path that is not a mount path — which is the common
  // case, and the reason this is cheap to put in front of every VFS call.
  parse(path){
    if(typeof path!=="string" || path.indexOf("/mnt/")!==0) return null;
    const rest = path.slice(5);                 // strip "/mnt/"
    const slash = rest.indexOf("/");
    const name = slash<0 ? rest : rest.slice(0, slash);
    if(!name) return null;
    const m = this.mounts.get(name);
    if(!m) return null;
    const sub = slash<0 ? "/" : ("/" + rest.slice(slash+1));
    return { mount:m, name, sub };
  },
  isMounted(path){ return !!this.parse(path); },

  // "/mnt" itself lists the mounts; everything under it is a mount path.
  normalize(base, p){
    if(typeof p!=="string" || p==="") return base;
    let out = p.startsWith("/") ? p : (base+"/"+p);
    out = VFS.norm(base, out);
    if(out==="/mnt") return out;
    if(out.startsWith("/mnt/")) return out.replace(/\/+$/,"") || "/mnt";
    return out;
  },

  // ---- lifecycle -----------------------------------------------------------
  async mount(name, opts){
    const kind = opts.kind;
    const backend = this.backendFor(kind);
    if(!backend) throw new Error("no backend for kind: " + kind);
    const handle = opts.handle || await backend.acquire(opts);
    if(!handle) throw new Error("no handle — permission or a cancelled picker");
    const m = {
      name, label: opts.label || name, kind,
      root: handle,
      perms: { read: opts.read!==false, write: opts.write!==false },
      tree: mkDirNode("/", {}),
      ready:false, error:null, lastSync:0, dirty:new Set(),
      async scan(){ return backend.scan(handle); },
      backend,
    };
    this.mounts.set(name, m);
    await this.refresh(name);
    Cyrus.audit("mount "+name, "mount_disk", {kind, name}, "medium", true, true,
               "Mounted a real location as /mnt/"+name);
    this.emitChange();
    return m;
  },

  unmount(name){
    const m = this.mounts.get(name);
    if(!m) return false;
    this.mounts.delete(name);
    Cyrus.audit("umount "+name, "unmount_disk", {name}, "medium", true, true,
               "Unmounted /mnt/"+name);
    this.emitChange();
    return true;
  },

  // Re-read the real tree into the mirror. Called on mount, on demand from the
  // System panel, and after any operation that could have changed the disk
  // behind our back (someone in Explorer, a build finishing, the bridge running
  // a registered script).
  async refresh(name){
    const m = this.mounts.get(name);
    if(!m) return null;
    try{
      m.tree = await m.scan();
      m.ready = true; m.error = null; m.lastSync = Date.now();
    }catch(e){
      m.error = e && e.message ? e.message : String(e);
      m.ready = false;
      console.error("[mnt:refresh:"+name+"]", e);
    }
    return m;
  },

  // Resolve once every pending write has reached the real device. Anything that
  // must not lose work awaits this first.
  async flush(){
    const jobs = [];
    for(const m of this.mounts.values()){
      for(const rel of Array.from(m.dirty)){
        m.dirty.delete(rel);
        const node = nodeAt(m.tree, rel);
        jobs.push(m.backend.write(m.root, rel, node ? node.content : "")
          .catch(e=>{ m.error = e.message || String(e); console.error("[mnt:write]",e); }));
      }
    }
    await Promise.all(jobs);
    return jobs.length;
  },

  backendFor(kind){ return BACKENDS[kind] || null; },
  available(){ return Object.keys(BACKENDS).filter(k => BACKENDS[k].available()); },
};

// ---- tiny tree helpers (mirror format mirrors the VFS node shape exactly) ----
function mkDirNode(name, children){ return { type:"dir", name, children:children||{}, mtime:Date.now() }; }
function mkFileNode(name, content, size, mtime){
  return { type:"file", name, ext:(name.split(".").pop()||"").toLowerCase(),
           content: content==null ? null : String(content),
           size: size!=null ? size : String(content==null?"":content).length,
           mtime: mtime || Date.now(), mirrored:true };
}
function nodeAt(root, rel){
  let cur = root;
  for(const seg of String(rel).split("/").filter(Boolean)){
    if(!cur || cur.type!=="dir") return null;
    cur = cur.children[seg];
  }
  return cur || null;
}
function ensureDir(root, rel){
  let cur = root;
  for(const seg of String(rel).split("/").filter(Boolean)){
    if(!cur.children[seg] || cur.children[seg].type!=="dir") cur.children[seg] = mkDirNode(seg,{});
    cur = cur.children[seg];
  }
  return cur;
}

// ============================================================================
//  Backends — all async, all normalised to the same three operations
// ============================================================================
const BACKENDS = {

  // ---- the original in-browser tree, exposed as a mount -------------------
  // Not offered in the picker (it is always reachable at /), but defined so the
  // bridge and the panels can talk about every location in one vocabulary.
  vfs:{
    label:"CYRUS disk (browser storage)",
    available(){ return true; },
    async acquire(){ return null; },
    async scan(){ return VFS.node("/") ? VFS.node("/") : mkDirNode("/",{}); },
    async write(){ throw new Error("the CYRUS disk is written through VFS directly"); },
  },

  // ---- File System Access API: a real folder the user picked ---------------
  fsapi:{
    label:"Real folder (this device)",
    available(){ return typeof window!=="undefined" && typeof window.showDirectoryPicker==="function"; },
    hint:"Needs Chrome/Edge (or another Chromium browser) on a real page — a file:// tab has no picker.",
    async acquire(){
      return await window.showDirectoryPicker({ mode:"readwrite", id:"cyrus-root", startIn:"documents" });
    },
    async scan(dir){
      const out = mkDirNode("/", {});
      await walkFs(dir, "", out, 0);
      return out;
    },
    async write(dir, rel, content){
      const parts = String(rel).split("/").filter(Boolean);
      if(!parts.length) return;
      let d = dir;
      for(let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i], {create:true});
      const fh = await d.getFileHandle(parts[parts.length-1], {create:true});
      const w = await fh.createWritable();
      await w.write(content==null? "" : String(content));
      await w.close();
    },
    async remove(dir, rel){
      const parts = String(rel).split("/").filter(Boolean);
      let d = dir;
      for(let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i]);
      await d.removeEntry(parts[parts.length-1], {recursive:true});
    },
    async mkdir(dir, rel){ await ensureFsDir(dir, rel); },
    async move(dir, from, to){
      // The File System Access API has no rename, and there is no cross-device
      // move. Read-then-write is honest and correct; it is not atomic.
      const src = await nodeAt(await this.scan(dir), from);
      await this.write(dir, to, src && src.content!=null ? src.content : "");
    },
  },

  // ---- Origin Private File System: real files, private to this origin ------
  opfs:{
    label:"OPFS (private to this browser)",
    available(){ return !!(navigator.storage && navigator.storage.getDirectory); },
    hint:"Real files with no picker. Private to this browser profile; clearing site data deletes them.",
    async acquire(){
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle("cyrus", {create:true});
    },
    async scan(dir){ const out = mkDirNode("/",{}); await walkFs(dir, "", out, 0); return out; },
    async write(dir, rel, content){
      const parts = String(rel).split("/").filter(Boolean);
      if(!parts.length) return;
      let d = dir;
      for(let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i], {create:true});
      const fh = await d.getFileHandle(parts[parts.length-1], {create:true});
      const w = await fh.createWritable(); await w.write(content==null? "" : String(content)); await w.close();
    },
    async remove(dir, rel){
      const parts = String(rel).split("/").filter(Boolean);
      let d = dir;
      for(let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i]);
      await d.removeEntry(parts[parts.length-1], {recursive:true});
    },
    async mkdir(dir, rel){ await ensureFsDir(dir, rel); },
    async move(dir, from, to){ return BACKENDS.fsapi.move.call(this, dir, from, to); },
  },

  // ---- the optional local daemon ------------------------------------------
  bridge:{
    label:"CYRUS bridge (localhost)",
    available(){ return typeof location!=="undefined" && /^https?:$/.test(location.protocol); },
    hint:"Run `python -m cyrus.bridge` on this machine. Confined to indexed_paths; no shell.",
    async acquire(){ await Bridge.probe(); if(!Bridge.online) throw new Error(Bridge.lastError || "no bridge answered"); return {url:Bridge.url}; },
    async scan(){
      const tree = await Bridge.call("list", {path:"/"});
      return tree && tree.tree ? tree.tree : mkDirNode("/",{});
    },
    async write(dir, rel, content){ await Bridge.call("write", {path:rel, content:content==null?"":String(content)}); },
    async remove(dir, rel){ await Bridge.call("delete", {path:rel}); },
    async mkdir(dir, rel){ await Bridge.call("mkdir", {path:rel}); },
    async move(dir, from, to){
      // The bridge has a real rename primitive; use it rather than read-write-delete,
      // which would lose a file if the daemon died between the two calls.
      await Bridge.call("move", {from, to});
    },
  },
};

// Shared recursive scan for the two File System Access style backends.
const SCAN_MAX_FILES = 2000, SCAN_MAX_DEPTH = 12;
async function walkFs(dir, prefix, out, depth){
  if(depth > SCAN_MAX_DEPTH) return;
  let count = 0;
  for await(const [name, handle] of dir.entries()){
    if(count++ > SCAN_MAX_FILES || out.__full) return;
    const rel = prefix + "/" + name;
    if(handle.kind === "directory"){
      const sub = mkDirNode(name, {});
      out.children[name] = sub;
      await walkFs(handle, rel, sub, depth+1);
      if(out.__full) return;
    }else{
      try{
        const f = await handle.getFile();
        if(f.size > MIRROR_MAX){
          out.children[name] = mkFileNode(name, null, f.size, f.lastModified);
        }else{
          out.children[name] = mkFileNode(name, await f.text(), f.size, f.lastModified);
        }
      }catch(e){ out.children[name] = mkFileNode(name, null, 0, Date.now()); }
    }
  }
}
async function ensureFsDir(dir, rel){
  let d = dir;
  for(const seg of String(rel).split("/").filter(Boolean)) d = await d.getDirectoryHandle(seg, {create:true});
  return d;
}

// ============================================================================
//  Bridge — loopback client for the optional daemon
// ============================================================================
//  The daemon is not a shell. It exposes six file verbs plus `sensors`, and it
//  re-enforces the same whitelist and path confinement that
//  cyrus/cyrus/actions.py already applies on the native side. A second
//  enforcement of an existing boundary — not a new one.
const Bridge = {
  url: localStorage.getItem("cyrus_bridge_url") || "",
  token: sessionStorage.getItem("cyrus_bridge_token") || "",
  online:false, lastError:"", roots:[], version:"", lastSeen:0,

  save(){ try{ localStorage.setItem("cyrus_bridge_url", this.url||""); }catch(e){} },
  saveToken(){ try{ sessionStorage.setItem("cyrus_bridge_token", this.token||""); }catch(e){} },

  TIMEOUT_MS: 45000,   // a cold read of a OneDrive/network folder is slow, not broken

  // The daemon prints its URL with no trailing path, and that is exactly the
  // string a user pastes into Settings. Concatenating it directly with a verb
  // produced "http://127.0.0.1:8787ping", which fails to parse as a URL and
  // surfaced as the misleading "could not reach the bridge" — when the bridge
  // was running and answering fine. One separator, inserted here, once.
  endpoint(op){
    const base = String(this.url || "").replace(/\/+$/, "");
    return base + "/" + String(op || "").replace(/^\/+/, "");
  },

  async call(op, args){
    if(!this.url) throw new Error("no bridge URL — start one in Settings → System");
    let r;
    // fetch() has no timeout of its own, so a bridge that accepts the request
    // and then stalls would hang CYRUS indefinitely. An explicit abort turns
    // that into a message the user can act on.
    const ac = ("AbortController" in window) ? new AbortController() : null;
    const timer = ac ? setTimeout(()=>ac.abort(), this.TIMEOUT_MS) : null;
    try{
      r = await fetch(this.endpoint(op), {
        method:"POST",
        headers:{ "Content-Type":"application/json", "X-Cyrus-Token":this.token },
        body: JSON.stringify(args || {}),
        signal: ac ? ac.signal : undefined,
      });
    }catch(e){
      if(e && (e.name === "AbortError" || /abort/i.test(e.message||""))){
        this.online = false;
        this.lastError = "the bridge did not answer " + op + " within " + Math.round(this.TIMEOUT_MS/1000) +
                          "s — a folder on a network drive can be slow to read on first access";
        throw new Error(this.lastError);
      }
      this.online = false;
      // A refused connection and a wrong origin look identical to fetch(). Say
      // which one it most likely is instead of showing a bare "failed".
      this.lastError = "could not reach " + this.endpoint(op) + " — is `python -m cyrus.bridge` running?";
      throw new Error(this.lastError);
    }finally{ if(timer) clearTimeout(timer); }
    let body;
    try{ body = await r.json(); }catch(e){ body = {ok:false, error:"bridge sent a non-JSON reply"}; }
    if(!r.ok || body.ok === false){
      this.lastError = body.error || ("bridge returned " + r.status);
      throw new Error(this.lastError);
    }
    this.online = true; this.lastSeen = Date.now();
    return body.result || {};
  },

  async probe(){
    if(!this.url){ this.online=false; this.lastError="no bridge URL configured"; return false; }
    if(!/^https?:$/.test(location.protocol)) return false;
    try{
      const b = await this.call("ping", {});
      this.online = true; this.lastError = "";
      this.roots = b.roots || []; this.version = b.version || "";
      return true;
    }catch(e){ this.online = false; this.lastError = e.message || String(e); return false; }
  },

  // The daemon reports where it found its token; the OS can tell the user
  // exactly what to do instead of "not connected".
  async adopt(token, url){
    this.token = token || ""; if(url) this.url = url;
    this.saveToken(); this.save();
    return await this.probe();
  },
};

// ============================================================================
//  VFS interception
// ============================================================================
//  Only these four methods change. `norm`, `parent`, `base`, `walk`,
//  `allFiles` and `sizeOf` keep their original implementations and work
//  unchanged over both trees, which is why nothing else in the OS had to be
//  touched.
(function patchVFS(){
  const origNode    = VFS.node;
  const origWrite   = VFS.writeFile;
  const origMkdirp  = VFS.mkdirp;
  const origRemove  = VFS.remove;

  VFS.node = function(path){
    const p = Mnt.parse(path);
    if(!p) return origNode.call(this, path);
    if(p.sub === "/") return p.mount.tree;
    return nodeAt(p.mount.tree, p.sub);
  };

  VFS.writeFile = function(path, content){
    const p = Mnt.parse(path);
    if(!p) return origWrite.call(this, path, content);
    const m = p.mount;
    if(!m.perms.write){ throw new Error("mount /mnt/"+p.name+" is read-only"); }
    if(p.sub === "/") return false;
    const dir = ensureDir(m.tree, VFS.parent(p.sub));
    const name = VFS.base(p.sub);
    if(dir.children[name] && dir.children[name].type === "dir") return false;
    dir.children[name] = mkFileNode(name, content);
    m.dirty.add(p.sub);                       // pushed on flush()
    Bus.emit("vfs"); Mnt.emitChange();
    return true;
  };

  VFS.mkdirp = function(path){
    const p = Mnt.parse(path);
    if(!p) return origMkdirp.call(this, path);
    const m = p.mount;
    if(!m.perms.write) return null;
    const d = ensureDir(m.tree, p.sub);
    m.dirty.add(p.sub);
    Bus.emit("vfs"); Mnt.emitChange();
    return d;
  };

  VFS.remove = function(path){
    const p = Mnt.parse(path);
    if(!p) return origRemove.call(this, path);
    const m = p.mount;
    if(!m.perms.write) return false;
    const node = nodeAt(m.tree, p.sub);
    if(!node) return false;
    const parent = VFS.parent(p.sub);
    if(parent === p.sub || p.sub === "/") return false;
    delete nodeAt(m.tree, parent).children[VFS.base(p.sub)];
    m.dirty.add("!" + p.sub);                 // "!" prefix marks a removal
    Bus.emit("vfs"); Mnt.emitChange();
    return true;
  };
})();

// Push removals (and writes) down to the real device. Anything after this
// point is a real effect on a real disk, so it is audited as one.
Mnt.flush = async function(){
  let n = 0;
  for(const m of Mnt.mounts.values()){
    for(const rel of Array.from(m.dirty)){
      m.dirty.delete(rel);
      try{
        if(rel.charAt(0) === "!"){ await m.backend.remove(m.root, rel.slice(1)); n++; }
        else {
          const node = nodeAt(m.tree, rel);
          await m.backend.write(m.root, rel, node && node.content != null ? node.content : "");
          n++;
        }
      }catch(e){ m.error = e.message || String(e); console.error("[mnt:flush]", e); }
    }
    m.lastSync = Date.now();
  }
  if(n) Mnt.emitChange();
  return n;
};

// ============================================================================
//  Shell integration
// ============================================================================
Object.assign(MAN, {
  mount:"mount — list real locations, or `mount --pick [name]` to grant CYRUS a folder on this device.",
  umount:"umount <name> — detach /mnt/<name>.",
  mounts:"mounts — every mounted location, its kind, its permissions and when it last synced.",
  sync:"sync [name] — re-read a real location, or flush pending writes when called with no argument.",
  df:"df -h — real storage: this origin's quota from the browser, and every real disk the bridge reports.",
});

Object.assign(CMDS, {
  mount:{
    man:"mount",
    async run(a, s, pr){
      if(a.length === 1 && (a[0]==="--pick" || a[0]==="-p")){
        await MntPicker.show();
        return;
      }
      const rows = Mnt.list();
      if(!rows.length){
        return pr("Nothing is mounted.\n\nCYRUS disk is always available at /.\n"+
                  "Add a real location:  mount --pick\n"+
                  "Or from Settings → System → Locations.");
      }
      pr("MOUNT                       KIND      ACCESS   LAST SYNC");
      for(const m of rows){
        const t = m.lastSync ? new Date(m.lastSync).toLocaleTimeString() : "never";
        pr((("/mnt/"+m.name).padEnd(27)) + m.kind.padEnd(9) +
           ((m.perms.read?"r":"")+(m.perms.write?"w":"-")).padEnd(9) + t);
      }
    }
  },
  umount:{
    man:"umount",
    run(a, s, pr){
      if(!a[0]) return pr("umount: name a mount, e.g. `umount real`", "err");
      const name = String(a[0]).replace(/^\/mnt\//,"").replace(/\/+$/,"");
      return pr(Mnt.unmount(name) ? ("unmounted /mnt/"+name) : ("umount: " + name + ": not mounted"), Mnt.get(name)?null:"err");
    }
  },
  mounts:{
    man:"mounts",
    run(a, s, pr){
      const rows = Mnt.list();
      if(!rows.length) return pr("no real locations mounted (the CYRUS disk at / is always present)");
      rows.forEach(m=>pr(("/mnt/"+m.name).padEnd(18) + m.kind.padEnd(10) + (m.ready?"mounted":"error") +
                         (m.error? " — " + m.error : "")));
    }
  },
  sync:{
    man:"sync",
    async run(a, s, pr){
      const flushed = await Mnt.flush();
      if(flushed) pr("flushed " + flushed + " change(s) to the real device");
      if(a[0]){
        const m = Mnt.get(String(a[0]).replace(/^\/mnt\//,""));
        if(!m) return pr("sync: no such mount: " + a[0], "err");
        await Mnt.refresh(m.name);
        return pr("re-read /mnt/" + m.name);
      }
      const rows = Mnt.list();
      for(const m of rows) await Mnt.refresh(m.name);
      pr(rows.length ? ("re-read " + rows.length + " mount(s)") : "nothing mounted to sync");
    }
  },
  df:{
    man:"df -h",
    async run(a, s, pr){
      pr(await DiskUsage.report());
    }
  },
});

// ============================================================================
//  Real storage figures — no invented numbers
// ============================================================================
//  The old system_report answered this question with a literal "512 GB".
//  Anything that cannot be measured says so instead of guessing.
const DiskUsage = {
  async browser(){
    try{
      const est = await navigator.storage.estimate();
      return { ok:true, usage:est.usage||0, quota:est.quota||0 };
    }catch(e){ return { ok:false, error:e.message||String(e) }; }
  },
  async report(){
    const L = [];
    L.push("Filesystem            Size       Used      Avail    Source");
    const b = await this.browser();
    // storage.estimate() and psutil both report BYTES; fmtSize expects KILOBYTES.
    // pad() truncates when it runs out of room, and "157.5 G" is ambiguous
    // enough to be wrong, so these columns are sized to hold a full unit.
    if(b.ok && b.quota){
      const pct = b.quota ? Math.round(b.usage/b.quota*100) : 0;
      L.push(pad("this origin",14) + pad(fmtSize(b.quota/1024),10) + pad(fmtSize(b.usage/1024),10) +
             pad(fmtSize(Math.max(0,b.quota-b.usage)/1024),9) + pct + "%  browser storage.estimate()");
    }else{
      L.push(pad("this origin",14) + "unknown       —          —         storage.estimate() unavailable: " + (b.error||"denied"));
    }
    if(Bridge.online || Bridge.url){
      try{
        const res = await Bridge.call("sensors", {});
        (res.disks||[]).forEach(d=>{
          L.push(pad("/mnt/"+(d.mount||"bridge"),14) + pad(fmtSize(d.total/1024),10) +
                 pad(fmtSize(d.used/1024),10) + pad(fmtSize(Math.max(0,d.total-d.used)/1024),9) +
                 (d.used&&d.total? " " + Math.round(d.used/d.total*100) + "%" : "") + "  bridge");
        });
      }catch(e){ L.push("bridge disks       unavailable — " + (e.message||e)); }
    }
    const m = Mnt.list().filter(x=>x.kind==="fsapi");
    if(m.length) L.push("", m.map(x=>"/mnt/"+x.name+"        a real folder you granted — CYRUS cannot see outside it.").join("\n"));
    return L.join("\n");
  },
};
function pad(s, n){ s = String(s==null?"":s); return s.length>=n ? s.slice(0,n-1)+" " : s+" ".repeat(n-s.length); }

// ============================================================================
//  MntPicker — grant a real location
// ============================================================================
const MntPicker = {
  async show(){
    const rows = Mnt.list();
    const kinds = [];
    for(const k of ["fsapi","opfs","bridge"]){
      const b = BACKENDS[k];
      if(!b.available()){ kinds.push(`<div class="mp-row off"><b>${esc(b.label)}</b><span>unavailable in this browser</span></div>`); continue; }
      kinds.push(`<button class="mp-row" data-k="${k}"><b>${esc(b.label)}</b><span>${esc(b.hint||"")}</span></button>`);
    }
    const cur = rows.length
      ? rows.map(m=>`<div class="mp-row live"><b>/mnt/${esc(m.name)}</b><span>${esc(m.kind)} · ${m.perms.write?"read/write":"read-only"} · ` +
                    `${m.ready?("synced " + new Date(m.lastSync).toLocaleTimeString()) : esc(m.error||"error")}</span>` +
                    `<button class="mp-un" data-un="${esc(m.name)}">unmount</button></div>`).join("")
      : `<div class="mp-cur dim">nothing mounted — the CYRUS disk at / is always present</div>`;

    WM.open({
      id:"cyrus-locations", title:"Locations", icon:"💾", w:520, h:460,
      build(win){
        win.body.innerHTML = `<div class="mp">
          <p class="mp-h">CYRUS can read a real location on this device. The browser scopes the grant to the folder you pick — CYRUS cannot see outside it, and every write goes to the audit log.</p>
          <div class="mp-k">MOUNTED</div>
          <div class="mp-list">${cur}</div>
          <div class="mp-k">ADD A LOCATION</div>
          ${kinds.join("")}
          <div class="mp-note">A folder you pick is deleted when you say so, from Finder or Explorer, like any other. CYRUS will show it as missing on the next refresh — that is a real state, not an error to hide.</div>
        </div>`;
        win.body.querySelectorAll("[data-k]").forEach(btn=>{
          btn.addEventListener("click", async ()=>{
            const kind = btn.dataset.k, name = kind;
            const label = btn.querySelector("b").textContent;
            btn.setAttribute("disabled","");
            btn.querySelector("span").textContent = "Requesting permission…";
            try{
              await Mnt.mount(name, {kind, label:BACKENDS[kind].label});
              Toast.show("Locations","Mounted at /mnt/"+name,null,"ok");
              WM.close("cyrus-locations");
            }catch(e){
              btn.removeAttribute("disabled");
              btn.querySelector("span").textContent = "Grant permission again — " + (e.message||e);
              Toast.show("Locations","Not mounted — " + (e.message||e),null,"err");
            }
          });
        });
        win.body.querySelectorAll("[data-un]").forEach(b=>{
          b.addEventListener("click", ()=>{ Mnt.unmount(b.dataset.un); WM.close("cyrus-locations"); MntPicker.show(); });
        });
      },
    });
    return true;
  },
};

// ============================================================================
//  Files — the Locations sidebar
// ============================================================================
//  CYRUS already had a Files app; this adds the root list above it rather than
//  replacing it, so no existing window behaviour changes.
Apps.register("locations", {
  title:"Locations", icon:"💾",
  launch(){ MntPicker.show(); }
});

function mountIndicator(){
  let el$ = document.getElementById("cyrus-mnt-badge");
  const on = Mnt.list().length;
  if(!on){ if(el$) el$.remove(); return; }
  if(!el$){
    el$ = Cyrus.el("div","cyrus-mnt-badge","");
    el$.id = "cyrus-mnt-badge";
    el$.addEventListener("click", ()=>MntPicker.show());
    document.body.appendChild(el$);
  }
  el$.innerHTML = "💾 " + Mnt.names().map(n=>"mnt/"+n).join("  ");
  el$.title = Mnt.list().map(m=>"/mnt/"+m.name+" — "+m.kind+", "+(m.perms.write?"read/write":"read-only")+
                                 ", synced "+(m.lastSync?new Date(m.lastSync).toLocaleTimeString():"never")).join("\n");
}
Mnt.onChange(mountIndicator);
Cyrus.onReady(mountIndicator);

// Push pending writes before the tab goes away. A browser cannot await on
// unload, so `visibilitychange` is the honest hook: it fires when the user
// actually switches away, and it is the last moment a page can still finish.
document.addEventListener("visibilitychange", ()=>{
  if(document.visibilityState === "hidden"){ Mnt.flush(); }
});
window.addEventListener("pagehide", ()=>{ Mnt.flush(); });