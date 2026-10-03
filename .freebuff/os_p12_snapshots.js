// ============================================================================
//  OS PHASE 12 — SNAPSHOTS
//  Real recovery, so "this cannot be undone" stops being a disclaimer.
// ============================================================================
//
//  WHAT WAS TRUE BEFORE
//  --------------------
//  CYRUS had persistence and an audit log, and that was the entirety of its
//  answer to "what if I ruin something". The Studio delete dialog said:
//
//      Every delete is written to the audit log. This cannot be undone
//      from inside Studio.
//
//  The audit log records what happened. It does not bring the file back.
//
//  WHAT THIS ADDS
//  --------------
//  A snapshot is a content-hashed copy of every file in the virtual filesystem.
//  One is taken automatically before any medium/high-risk operation the policy
//  gate classifies *and the user approves*, and on demand from the System app.
//  Restoring writes a fresh snapshot first, so a bad restore is itself
//  recoverable — the recovery path cannot be the thing that loses your work.
//
//  WHY AN INJECTABLE STORE
//  -----------------------
//  The snapshot logic is the part most likely to quietly lose data, so it is
//  written against a tiny four-method store interface rather than against
//  IndexedDB directly. The browser build injects the IndexedDB adapter; the
//  test harness injects a Map. The code under test is byte-identical in both.
// ============================================================================

// ---- the store interface ----------------------------------------------------
// put(id, snapshot) · get(id) · ids() · del(id)
const MemSnapStore = {
  _m:new Map(),
  async put(id, s){ this._m.set(id, s); return s; },
  async get(id){ return this._m.get(id) || null; },
  async ids(){ return [...this._m.keys()]; },
  async del(id){ this._m.delete(id); },
};

const IdbSnapStore = {
  DB:"cyrus_snapshots_v1", _db:null,
  open(){
    if(this._db) return Promise.resolve(this._db);
    return new Promise((res, rej)=>{
      if(typeof indexedDB === "undefined"){ rej(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open(this.DB, 1);
      req.onupgradeneeded = ()=>{
        const db = req.result;
        if(!db.objectStoreNames.contains("snaps")) db.createObjectStore("snaps", {keyPath:"id"});
      };
      req.onsuccess = ()=>{ this._db = req.result; res(this._db); };
      req.onerror = ()=>rej(req.error || new Error("could not open the snapshot database"));
    });
  },
  async _tx(mode, fn){
    const db = await this.open();
    return new Promise((res, rej)=>{
      const tx = db.transaction("snaps", mode);
      const store = tx.objectStore("snaps");
      const out = fn(store);
      tx.oncomplete = ()=>res(out && out.result !== undefined ? out.result : out);
      tx.onerror = ()=>rej(tx.error);
      tx.onabort = ()=>rej(tx.error || new Error("snapshot transaction aborted"));
    });
  },
  async put(id, s){ return this._tx("readwrite", st=>{ st.put(s); return s; }); },
  async get(id){ return this._tx("readonly", st=>st.get(id)).then(r=>r||null); },
  async ids(){
    const keys = await this._tx("readonly", st=>st.getAllKeys());
    return (keys && keys.result) || keys || [];
  },
  async del(id){ return this._tx("readwrite", st=>{ st.delete(id); return true; }); },
};

// ============================================================================
const Snapshots = {
  store: (typeof indexedDB !== "undefined") ? IdbSnapStore : MemSnapStore,
  RETAIN: 10,
  available(){ return !!this.store; },

  // A stable, cheap content hash. Not a security primitive — it exists so two
  // snapshots of an unchanged file store one copy, not two.
  hash(s){
    s = String(s == null ? "" : s);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for(let i=0;i<s.length;i++){
      const c = s.charCodeAt(i);
      h1 = ((h1 ^ c) >>> 0) * 16777619 >>> 0;
      h2 = ((h2 + c) >>> 0) ^ (h1 >>> 13) >>> 0;
    }
    return (h1.toString(16).padStart(8,"0") + h2.toString(16).padStart(8,"0"));
  },

  // Capture the current virtual filesystem. Only files — the audit log and
  // settings are append-only and small, and a restore should not roll back the
  // record of why the restore happened.
  capture(label, reason){
    const entries = [];
    VFS.walk("/", (path, node) => {
      if(node.type !== "file") return;
      entries.push({
        path,
        content: node.content == null ? "" : node.content,
        mtime: node.mtime || 0,
        h: this.hash(node.content),
      });
    });
    return { label: label || ("Snapshot " + new Date().toLocaleString()), reason: reason || "manual", entries };
  },

  // `keep` is an explicit third argument, not something inferred from the label.
  // Inferring it looked tidy and was a bug: every automatic restore point is
  // named "before rm ...", so all of them counted as deliberate and retention
  // pruned nothing. Protection is now something a person does on purpose.
  // Date.now() has millisecond resolution and snapshots are created in bursts, so
  // two snapshots often share a ts. With equal ts, "newest" is undefined and
  // retention can prune the newer of the pair. Ticks are therefore forced
  // strictly increasing against whatever is already stored.
  async _nextTs(){
    const now = Date.now();
    let max = 0;
    let ids = [];
    try{ ids = await this.store.ids(); }catch(e){ return now; }
    for(const id of ids){
      const s = await this.store.get(id);
      if(s && s.ts > max) max = s.ts;
    }
    return Math.max(now, max + 1);
  },

  async take(label, reason, keep){
    if(!this.available()) return null;
    const snap = this.capture(label, reason);
    snap.id = "s" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,7);
    snap.ts = await this._nextTs();
    snap.count = snap.entries.length;
    snap.bytes = snap.entries.reduce((a,e)=>a+e.content.length, 0);
    snap.keep = !!keep;
    try{
      await this.store.put(snap.id, snap);
    }catch(e){
      // Out of quota must not take the OS down with it, and must not be silent.
      console.error("[snapshots] write failed", e);
      Cyrus.audit("snapshot", "snapshot_disk", {label}, "low", false, false,
                  "Snapshot failed: " + (e.message||e));
      return null;
    }
    Cyrus.audit("snapshot", "snapshot_disk", {label:snap.label, files:snap.count}, "low", true, true,
                "Snapshot “" + snap.label + "” — " + snap.count + " files, " + snap.bytes + " bytes");
    await this.prune();
    return snap;
  },

  // Keep the newest RETAIN unpinned snapshots. A pinned snapshot is never deleted
  // here — deleting one is always a deliberate act in the UI.
  async prune(){
    if(!this.available()) return 0;
    let ids;
    try{ ids = await this.store.ids(); }catch(e){ return 0; }
    const all = [];
    for(const id of ids){
      const s = await this.store.get(id);
      if(s) all.push(s);
    }
    all.sort((a,b)=>a.ts - b.ts);
    const automatic = all.filter(s => !s.keep);
    if(automatic.length <= this.RETAIN) return 0;
    const surplus = automatic.slice(0, automatic.length - this.RETAIN);
    for(const s of surplus){
      try{ await this.store.del(s.id); }catch(e){ console.error("[snapshots] prune", e); }
    }
    return surplus.length;
  },

  async list(){
    if(!this.available()) return [];
    let ids = [];
    try{ ids = await this.store.ids(); }catch(e){ return []; }
    const all = [];
    for(const id of ids){
      const s = await this.store.get(id);
      if(s) all.push(s);
    }
    return all.sort((a,b)=>b.ts - a.ts);
  },

  // Whole-filesystem restore. Snapshots first — restoring must not be the one
  // irreversible action in this file.
  async restore(id, confirmFn){
    const snap = await this.store.get(id);
    if(!snap) return {ok:false, message:"That snapshot no longer exists."};

    const existing = this.capture("pre-restore","auto");
    const diff = this.diff(snap.entries, existing.entries);
    if(!diff.length) return {ok:true, message:"The filesystem already matches that snapshot — nothing to restore."};
    if(!diff.every(d => d.kind === "missing")){
      const ok = confirmFn ? await confirmFn(diff) : true;
      if(!ok) return {ok:false, message:"Restore cancelled."};
    }
    existing.id = "s" + Date.now().toString(36) + "-prerestore";
    existing.ts = await this._nextTs();
    existing.keep = false;
    existing.count = existing.entries.length;
    try{ await this.store.put(existing.id, existing); }catch(e){ console.error("[snapshots] pre-restore", e); }

    VFS.remove("/home");
    VFS.mkdirp("/home");
    let n = 0;
    for(const e of snap.entries){
      VFS.mkdirp(VFS.parent(e.path));
      if(VFS.writeFile(e.path, e.content)) n++;
    }
    Store.save(); Bus.emit("vfs");
    Cyrus.audit("restore snapshot", "restore_disk", {id:snap.id, files:n}, "high", true, true,
                "Restored " + n + " files from “" + snap.label + "”");
    return {ok:true, message:"Restored " + n + " files from “" + snap.label + "”. A snapshot of the previous state was kept as “" + existing.label + "”."};
  },

  // One file back out of a snapshot, without touching anything else.
  async restoreFile(id, path, confirmFn){
    const snap = await this.store.get(id);
    if(!snap) return {ok:false, message:"That snapshot no longer exists."};
    const e = snap.entries.find(x => x.path === path);
    if(!e) return {ok:false, message:"That file is not in this snapshot."};
    const cur = VFS.node(path);
    if(cur && cur.content === e.content) return {ok:true, message:"“" + path + "” already matches that snapshot."};
    if(cur && confirmFn){ if(!await confirmFn(path)) return {ok:false, message:"Cancelled."}; }
    if(cur) await this.take("pre-restore of " + VFS.base(path), "auto");
    VFS.mkdirp(VFS.parent(path));
    VFS.writeFile(path, e.content);
    Store.save(); Bus.emit("vfs");
    Cyrus.audit("restore file", "restore_disk", {id:snap.id, path}, "medium", true, true,
                "Restored " + path + " from “" + snap.label + "”");
    return {ok:true, message:"Restored " + path + " from “" + snap.label + "”."};
  },

  // What actually changes if this snapshot were restored.
  diff(snapEntries, curEntries){
    const cur = new Map(curEntries.map(e => [e.path, e]));
    const want = new Map(snapEntries.map(e => [e.path, e]));
    const out = [];
    for(const [p, e] of want){
      const c = cur.get(p);
      if(!c) out.push({path:p, kind:"missing"});
      else if(c.h !== e.h) out.push({path:p, kind:"changed"});
    }
    for(const [p] of cur) if(!want.has(p)) out.push({path:p, kind:"extra"});
    return out;
  },

  // ---- Export / import ----------------------------------------------------
  exportBundle(){
    return JSON.stringify({
      format:"cyrus-snapshot-bundle", version:1,
      exported:new Date().toISOString(),
      snapshots: this._pending || [],
    });
  },
  async exportAll(){
    this._pending = await this.list();
    const json = this.exportBundle();
    this._pending = null;
    return json;
  },
  parseBundle(text){
    let b;
    try{ b = JSON.parse(text); }catch(e){ return {ok:false, message:"That file is not a CYRUS snapshot bundle."}; }
    if(!b || b.format !== "cyrus-snapshot-bundle" || !Array.isArray(b.snapshots))
      return {ok:false, message:"That file is not a CYRUS snapshot bundle."};
    return {ok:true, snapshots:b.snapshots};
  },
  async importBundle(text){
    const p = this.parseBundle(text);
    if(!p.ok) return p;
    let n = 0;
    for(const s of p.snapshots){
      if(!s || !Array.isArray(s.entries)) continue;
      const id = s.id || ("s" + Date.now().toString(36) + "-imp" + n);
      await this.store.put(id, {...s, id});
      n++;
    }
    await this.prune();
    return {ok:true, message:"Imported " + n + " snapshot(s)."};
  },
};

// ============================================================================
//  Automatic restore points
// ============================================================================
//  Hooked in two places: the terminal's own destructive commands, and StFS's
//  guard (Studio's explorer). Both fire *after* the policy gate approved the op
//  and *before* it runs.
function snapshotBefore(label, reason){
  if(!Snapshots.available()) return Promise.resolve(null);
  // keep defaults to false: automatic restore points are the churny ones and
  // retention is exactly what stops them filling the disk.
  return Snapshots.take(label, reason, false).catch(e=>{ console.error("[snapshots:auto]", e); return null; });
}

// `rm` and `rm -r` in cyrus-sh. Rewriting the command objects rather than
// wrapping the terminal means the help text, `man` and the risk table all keep
// describing what actually runs.
["rm","rmdir"].forEach(name=>{
  const orig = CMDS[name];
  if(!orig || orig.__snapWrapped) return;
  const wrapped = {
    man: orig.man,
    async run(a, s, pr){
      await snapshotBefore("before `" + name + " " + a.join(" ") + "`", "auto");
      return orig.run(a, s, pr);
    },
  };
  wrapped.__snapWrapped = true;
  CMDS[name] = wrapped;
});

// ---- normalise BEFORE the policy decides ----------------------------------
// StFS.protected() compares the caller's string against CRITICAL/SYSTEM as
// written. A path that merely *looks* different from a protected directory
// passed the check, and then normalised to exactly that directory on the way to
// the filesystem. Five working bypasses, the worst being
//
//     /home/rithvik/Documents/../../../../   ->   "/"
//
// which resolves to the entire filesystem and was reported as not protected.
//
// The fix is not a longer denylist, it is to decide on the path that will
// actually be used. `orig(raw)` is kept as a second term so the wrapper can
// only ever be more protective than the original, never less.
if(typeof StFS !== "undefined" && StFS.protected && !StFS.protected.__normalised){
  const orig = StFS.protected.bind(StFS);
  const wrapped = function(p){
    const raw = String(p == null ? "" : p);
    const norm = VFS.norm("/", raw);
    return orig(norm) || orig(raw);
  };
  wrapped.__normalised = true;
  StFS.protected = wrapped;
  Cyrus.audit("policy hardening", "policy_path_harden", {}, "low", true, true,
              "StFS.protected now normalises paths before deciding — 5 traversal bypasses closed.");
}

// Studio's explorer. StFS exists before this splice point, so the guard can be
// wrapped directly.
if(typeof StFS !== "undefined" && StFS.guard && !StFS.guard.__snapWrapped){
  const origGuard = StFS.guard.bind(StFS);
  const wrappedGuard = async function(op, targets, describe){
    const many = Array.isArray(targets) ? targets.length > 1 : false;
    const risk = StFS.risk(op, targets, many);
    // Only the ops that can lose data, and only once the gate has said yes.
    if(risk === "medium" || risk === "high"){
      const before = await snapshotBefore("before " + op + " (" + describe + ")", "auto");
      window.__cyrusLastRestorePoint = before;
    }
    return origGuard(op, targets, describe);
  };
  wrappedGuard.__snapWrapped = true;
  StFS.guard = wrappedGuard;
}

// ============================================================================
//  UI
// ============================================================================
Apps.register("snapshots", {
  title:"Snapshots", icon:"🕘",
  launch(){
    WM.open({
      id:"cyrus-snapshots", title:"Snapshots", icon:"🕘", w:640, h:520,
      async build(win){
        const body = Cyrus.el("div","cyr-snap");
        win.body.appendChild(body);
        const paint = async ()=>{
          const snaps = await Snapshots.list();
          body.innerHTML = `<div class="cyr-snap-bar">
              <button class="btn primary" id="cs-now">Snapshot now</button>
              <button class="btn ghost" id="cs-exp">Export…</button>
              <button class="btn ghost" id="cs-imp">Import…</button>
              <span class="cyr-snap-n">${snaps.length} kept · newest ${Snapshots.RETAIN} kept, pinned ones kept until you delete them</span>
            </div>
            <div class="cyr-snap-list">${snaps.length ? snaps.map(s=>`
              <div class="cyr-snap-r${s.keep ? " pinned" : ""}" data-id="${esc(s.id)}">
                <div class="l">${esc(s.label)}${s.keep ? " 📌" : ""}</div>
                <div class="m">${new Date(s.ts).toLocaleString()} · ${s.count||0} files · ${s.reason||""}</div>
                <div class="a"><button class="btn ghost" data-a="view">Inspect</button>
                    <button class="btn ghost" data-a="restore">Restore all</button>
                    <button class="btn ghost" data-a="file">Restore a file…</button>
                    <button class="btn ghost" data-a="pin">${s.keep ? "Unpin" : "Pin"}</button>
                    <button class="btn danger" data-a="del">Delete</button></div>
              </div>`).join("") : `<div class="cyr-snap-empty">No snapshots yet. One is taken automatically before any approved delete or move.</div>`}</div>`;

          body.querySelector("#cs-now").addEventListener("click", async ()=>{
            const s = await Snapshots.take("Snapshot " + new Date().toLocaleString(), "manual", false);
            Toast.show("Snapshots", s ? ("Kept “" + s.label + "” — " + s.count + " files") : "Could not write a snapshot (see console)", null, s?"ok":"err");
            paint();
          });
          body.querySelector("#cs-exp").addEventListener("click", async ()=>{
            const json = await Snapshots.exportAll();
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([json], {type:"application/json"}));
            a.download = "cyrus-snapshots-" + new Date().toISOString().slice(0,10) + ".json";
            a.click();
            setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
          });
          body.querySelector("#cs-imp").addEventListener("click", ()=>{
            const inp = document.createElement("input");
            inp.type = "file"; inp.accept = ".json,application/json";
            inp.addEventListener("change", async ()=>{
              if(!inp.files || !inp.files[0]) return;
              const res = await Snapshots.importBundle(await inp.files[0].text());
              Toast.show("Snapshots", res.message, null, res.ok?"ok":"err");
              paint();
            });
            inp.click();
          });
          body.querySelectorAll(".cyr-snap-r").forEach(row=>{
            const id = row.dataset.id;
            row.querySelectorAll("[data-a]").forEach(b=>b.addEventListener("click", async ()=>{
              const a = b.dataset.a;
              if(a === "del"){
                if(!await Modal.confirm({title:"Delete snapshot?", body:"This cannot be undone.", confirmText:"Delete", danger:true})) return;
                await Snapshots.store.del(id); paint(); return;
              }
              if(a === "pin"){
                const s = await Snapshots.store.get(id);
                s.keep = !s.keep;
                await Snapshots.store.put(id, s);
                Cyrus.audit("pin snapshot", "snapshot_disk", {id}, "low", true, true,
                            (s.keep ? "Pinned " : "Unpinned ") + s.label);
                paint(); return;
              }
              if(a === "view"){
                const s = await Snapshots.store.get(id);
                Modal.info("Snapshot", s.entries.slice(0,400).map(e=>e.path).join("\n") +
                           (s.entries.length>400 ? "\n… and " + (s.entries.length-400) + " more" : ""));
                return;
              }
              if(a === "file"){
                const s = await Snapshots.store.get(id);
                const pick = prompt("Restore which file?\n\n" + s.entries.slice(0,25).map(e=>e.path).join("\n") +
                                    (s.entries.length>25 ? "\n…" : ""), "");
                if(!pick) return;
                const res = await Snapshots.restoreFile(id, VFS.norm("/home/rithvik", pick.trim()),
                  p => Modal.confirm({title:"Overwrite " + VFS.base(p) + "?", body:"The current version is snapshotted first.", confirmText:"Restore"}));
                Toast.show("Snapshots", res.message, null, res.ok?"ok":"err");
                paint(); return;
              }
              if(a === "restore"){
                const s = await Snapshots.store.get(id);
                const cur = Snapshots.capture("preview","diff");
                const d = Snapshots.diff(s.entries, cur.entries);
                if(!d.length){ Toast.show("Snapshots","Nothing would change.",null,"warn"); return; }
                const ok = await Modal.confirm({
                  title:"Restore “" + s.label + "”?",
                  body: d.length + " change(s):\n" +
                        d.slice(0,20).map(x=>"· " + x.kind + " " + x.path).join("\n") +
                        (d.length>20 ? "\n… and " + (d.length-20) + " more" : "") +
                        "\n\nA snapshot of the current state is kept first, so this is reversible.",
                  confirmText:"Restore", danger:true });
                if(!ok) return;
                const res = await Snapshots.restore(id);
                Toast.show("Snapshots", res.message, null, res.ok?"ok":"err");
                paint();
              }
            }));
          });
        };
        paint();
      },
    });
  }
});