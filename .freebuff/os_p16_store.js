// ============================================================================
//  CYRUS OS — phase 16 — Store persistence
//
//  Why this exists
//  ---------------
//  Everything in CYRUS lives in `Store.data`, and `Store.save()` writes the whole
//  object to localStorage as one JSON string. There are 40 call sites and 35
//  direct reads, all synchronous, and `Store.load()` is called from inside
//  init(). That shape has two consequences worth naming:
//
//  1. Quota. localStorage is ~5 MB and shared with the origin. One mounted folder
//     of real files pushes the whole OS over that line, and the base
//     `Store.save()` swallows the QuotaExceededError in a bare try/catch. The
//     write silently stops happening, the user's work is not saved, and the
//     *only* symptom is that it is all gone after a reload.
//
//  2. One bad reload loses everything. There is no second copy.
//
//  IndexedDB gives ~hundreds of MB and is not silently truncating, so the Store
//  is written there as well. localStorage is kept as a *mirror* because
//  `Store.load()` is synchronous and lives in a file this build cannot edit —
//  dropping it would make boot async and the OS would come up empty.
//
//  The rules this chunk obeys
//  -------------------------
//  - No call site changes. `Store.save()` stays synchronous and returns what it
//    always did; the IndexedDB write is debounced behind it. 75 sites, zero edits.
//  - Hydration can never clobber a newer write. Every save bumps `Store.rev`.
//    An IndexedDB record is only adopted when it is strictly newer, or when the
//    localStorage mirror is known to be broken.
//  - A failed mirror is detected, not assumed. The base save() hides quota
//    errors; this one does not, because "did my write actually happen?" is the
//    whole question.
// ============================================================================

const Persist = {
  DB:"cyrus_os_store_v1",
  STORE:"kv",
  KEY:"store",
  // Records the revision the localStorage mirror *actually* holds — written only
  // after a mirror write that succeeded. A plain "last saved rev" counter is not
  // enough: when the mirror is over quota the counter still advances while the
  // data does not, and the next boot would then believe it had the latest state
  // when it holds nothing at all. This key only moves when bytes really moved.
  MIRROR_KEY:"cyrus_os_mirror_rev",
  FLUSH_MS:250,
  _timer:null, _db:null, _dbTried:false,
  dirty:false, lsHealthy:true, hydrated:false, lastError:null, mirrorRev:0,

  // ---- open (cached; one connection, reused) -------------------------------
  open(){
    if(this._db) return Promise.resolve(this._db);
    if(typeof indexedDB === "undefined") return Promise.resolve(null);
    if(this._dbTried) return Promise.resolve(null);
    return new Promise(res=>{
      let req;
      try{ req = indexedDB.open(this.DB, 1); }catch(e){ this._dbTried = true; this.lastError = String(e && e.message || e); return res(null); }
      req.onupgradeneeded = ()=>{
        if(!req.result.objectStoreNames.contains(this.STORE)) req.result.createObjectStore(this.STORE,{keyPath:"k"});
      };
      req.onsuccess = ()=>{ this._db = req.result; res(this._db); };
      // A blocked or unavailable database must never take the OS down with it.
      req.onerror   = ()=>{ this._dbTried = true; this.lastError = "open failed"; res(null); };
      req.onblocked = ()=>{ this.lastError = "open blocked"; };
    });
  },

  // ---- the mirror ----------------------------------------------------------
  // The base save() is a try/catch that cannot report failure, so this replaces
  // it with the same write plus an honest result. localStorage stays the boot
  // path; IndexedDB is what makes the state survive when the mirror cannot.
  writeMirror(){
    try{
      localStorage.setItem(Store.KEY, JSON.stringify(Store.data));
      this.lsHealthy = true;
      // Only now does the mirror genuinely hold this revision.
      localStorage.setItem(this.MIRROR_KEY, String(Store.rev || 0));
      this.mirrorRev = Store.rev || 0;
      return true;
    }catch(e){
      this.lsHealthy = false;
      this.lastError = "mirror quota: " + String(e && e.name || e);
      return false;
    }
  },

  // ---- write-behind --------------------------------------------------------
  schedule(){
    this.dirty = true;
    if(this._timer) return;
    this._timer = setTimeout(()=>{ this._timer = null; this.flush(); }, this.FLUSH_MS);
  },

  async flush(){
    if(!this.dirty) return false;
    this.dirty = false;
    const rev = Store.rev || 0;
    const db = await this.open();
    if(!db){ this.dirty = true; return false; }
    return new Promise(res=>{
      try{
        // A structured clone of a snapshot taken *now*, not a reference to a
        // mutable object that could change mid-transaction.
        const payload = { k:this.KEY, rev, saved:Date.now(), data:JSON.parse(JSON.stringify(Store.data)) };
        const tx = db.transaction(this.STORE, "readwrite");
        tx.objectStore(this.STORE).put(payload);
        tx.oncomplete = ()=>res(true);
        tx.onerror = tx.onabort = ()=>{ this.lastError = "flush failed"; this.dirty = true; res(false); };
      }catch(e){ this.lastError = "flush threw: " + String(e && e.message || e); this.dirty = true; res(false); }
    });
  },

  // ---- hydration -----------------------------------------------------------
  // Runs after Store.load(), so localStorage has already supplied a working
  // state. IndexedDB is consulted only to *improve* on it, never to replace it
  // blindly: an older database must not undo work done this session.
  async hydrate(){
    const db = await this.open();
    if(!db) return { adopted:false, reason:"no IndexedDB" };
    let rec = null;
    try{
      rec = await new Promise((res, rej)=>{
        const g = db.transaction(this.STORE,"readonly").objectStore(this.STORE).get(this.KEY);
        g.onsuccess = ()=>res(g.result || null);
        g.onerror   = ()=>rej(new Error("get failed"));
      });
    }catch(e){ this.lastError = "hydrate read failed"; return { adopted:false, reason:"read failed" }; }
    if(!rec || !rec.data || !rec.data.vfs) return { adopted:false, reason:"empty" };

    const localRev = Store.rev || 0;
    const idbRev = rec.rev || 0;

    // Adopt only when the database is strictly ahead of what the mirror
    // demonstrably holds. That single comparison covers every real case:
    //
    //   mirror missing / cleared   -> mirrorRev 0, database wins
    //   mirror over quota          -> MIRROR_KEY never advanced, database wins
    //   ordinary reload            -> mirrorRev == idbRev, nothing to do
    //   edits made this session    -> localRev > idbRev, database ignored
    //
    // Getting this backwards would undo the user's most recent work on boot,
    // so equality is deliberately treated as "nothing to gain".
    if(idbRev <= localRev) return { adopted:false, reason:idbRev < localRev ? "database older" : "up to date" };

    Store.data = rec.data;
    Store.rev = idbRev;
    VFS.root = Store.data.vfs;
    this.hydrated = true;
    this.writeMirror();                     // bring the boot path back in step
    Bus.emit("vfs");
    return { adopted:true, rev:idbRev, reason:this.lsHealthy ? "database newer" : "mirror was broken" };
  },
};

// ---- wire it in -------------------------------------------------------------
// Store.save() keeps its synchronous contract; the IndexedDB write is debounced
// behind it. The 40 existing call sites need no change and cannot observe the
// difference except that their data is now also durable.
if(typeof Store !== "undefined" && !Store.__persisted){
  Store.rev = (() => { try{ return parseInt(localStorage.getItem(Persist.MIRROR_KEY), 10) || 0; }catch(e){ return 0; } })();
  Persist.mirrorRev = Store.rev;

  const origSave = Store.save.bind(Store);
  Store.save = function(){
    Store.rev = (Store.rev || 0) + 1;
    Persist.writeMirror();                  // advances MIRROR_KEY only on success
    Persist.schedule();
  };
  Store.save.__persisted = true;

  // Reset has to clear the database too. localStorage.removeItem() followed by a
  // reload would otherwise leave IndexedDB holding a *newer* revision, and
  // hydration would faithfully restore the state the user just asked to erase.
  // A reset that does not stick is worse than one that fails loudly.
  const origReset = Store.reset.bind(Store);
  Store.reset = function(){
    Persist.dirty = false;
    if(Persist._timer){ clearTimeout(Persist._timer); Persist._timer = null; }
    (async ()=>{
      const db = await Persist.open();
      if(db){
        try{
          await new Promise(res=>{
            const tx = db.transaction(Persist.STORE,"readwrite");
            tx.objectStore(Persist.STORE).delete(Persist.KEY);
            tx.oncomplete = res; tx.onerror = tx.onabort = res;
          });
        }catch(e){}
      }
      try{ localStorage.removeItem(Persist.MIRROR_KEY); }catch(e){}
      origReset();
    })();
  };
  Store.reset.__persisted = true;
}

// Hydrate only once the Store is loaded — the same ordering rule the phase-10
// boot fix established for onReady. Cyrus.fireReady already waits for it.
if(typeof Cyrus !== "undefined" && Cyrus.onReady){
  Cyrus.onReady(async ()=>{
    const r = await Persist.hydrate();
    Cyrus.audit("store persistence", r.adopted ? "store_hydrated" : "store_hydrate_noop",
                { adopted:r.adopted, reason:r.reason },
                "low", false, r.adopted,
                r.adopted ? "Restored the Store from IndexedDB (" + r.reason + ", rev " + r.rev + ")."
                          : "IndexedDB held nothing newer (" + r.reason + ").");
  });
  // Never lose the last few hundred milliseconds to a closed tab.
  if(typeof window !== "undefined") window.addEventListener("pagehide", ()=>{ Persist.flush(); });
}