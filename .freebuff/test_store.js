// Store persistence tests (phase 16).
//
// The claim under test: CYRUS's state survives a reload, including the case the
// old code could not survive at all — localStorage out of quota.
//
// Before this, `Store.save()` wrote one JSON blob to localStorage inside a bare
// try/catch. Over ~5 MB the write throws, the catch swallows it, and the next
// reload brings up an empty OS with no error anywhere. That is the bug this
// suite exists to keep fixed.
const { ok, eq, report, makeCtx, makeIDB, loadOS } = require("./os_stub.js");

const tick = () => new Promise(r => setImmediate(r));

async function main() {
  // ---- the normal path: save, reload, still there --------------------------
  {
    const idb = makeIDB();
    const local = {};
    const a = makeCtx({ idb, local });
    loadOS(a);

    a.Store.data.notes.remembered = "the user prefers metric units";
    a.Store.data.settings.accent = "#00ff00";
    a.Store.save();
    eq(typeof a.Store.rev, "number", "save() stamps a revision");
    eq(a.Store.rev, 1, "the first save is revision 1");

    // write-behind: the flush is debounced, so drive the timer explicitly
    a.Persist.dirty = true;
    await a.Persist.flush();
    eq(a.Persist.dirty, false, "flush() clears the dirty flag");

    // --- reload: a brand-new context over the same durable storage ---------
    const b = makeCtx({ idb, local });
    loadOS(b);
    b.Store.load();                       // init() does this on DOMContentLoaded
    b.Cyrus.fireReady();
    await tick(); await tick(); await tick();

    eq(b.Persist.hydrated, false, "an ordinary reload has nothing to adopt — the mirror was already current");
    eq(b.Store.data.notes.remembered, "the user prefers metric units",
       "the user's notes survived the reload");
    eq(b.Store.data.settings.accent, "#00ff00", "settings survived too");
    ok(b.VFS.node("/home/rithvik"), "VFS is still a real tree after hydration");

    // A reload with the mirror *gone* but the database intact — the case the
    // localStorage-only design could not survive. The database is the only
    // remaining copy, so it must be adopted and VFS must be rebound to it,
    // otherwise the OS renders a stale filesystem over good data.
    const c = makeCtx({ idb, local: {} });          // fresh, empty mirror
    loadOS(c);
    c.Store.load();
    c.Cyrus.fireReady();
    await tick(); await tick(); await tick();
    eq(c.Persist.hydrated, true, "with the mirror gone, the database is adopted");
    eq(c.Store.data.notes.remembered, "the user prefers metric units",
       "and it really is the state that was saved");
    ok(c.VFS.node("/home/rithvik"), "VFS is a real tree after adoption");
    eq(c.VFS.root, c.Store.data.vfs,
       "VFS.root is rebound to the adopted tree — otherwise the OS shows a stale filesystem");
  }

  // ---- hydration must never clobber newer in-memory work ------------------
  // The whole safety argument rests on revision ordering. If this inverts, the
  // OS would undo work done seconds ago on every boot.
  {
    const idb = makeIDB();
    const local = {};
    const a = makeCtx({ idb, local });
    loadOS(a);
    a.Store.data.notes.k = "v1";
    a.Store.save();
    a.Persist.dirty = true;
    await a.Persist.flush();

    // Second session: the mirror says v2, but IndexedDB still holds v1.
    const b = makeCtx({ idb, local });
    loadOS(b);
    b.Store.load();                       // boot reads the mirror, as init() does
    eq(b.Store.data.notes.k, "v1", "the mirror carried the latest state into boot");
    b.Store.data.notes.k = "v2-edited-this-session";
    b.Store.save();
    eq(b.Store.rev, 2, "the new edit is a higher revision than the database");
    b.Cyrus.fireReady();
    await tick(); await tick(); await tick();
    eq(b.Persist.hydrated, false, "an older database is NOT adopted over newer work");
    eq(b.Store.data.notes.k, "v2-edited-this-session", "and the edit is untouched");
  }

  // ---- the case the old code lost: localStorage is out of quota ----------
  {
    const idb = makeIDB();
    const local = {};
    const a = makeCtx({ idb, local, lsQuota: 200 });
    loadOS(a);

    a.Store.data.notes.big = "x".repeat(400);          // exceeds the quota
    a.Store.save();
    eq(a.Persist.lsHealthy, false, "a failed mirror write is detected, not assumed");
    ok(/Quota/.test(a.Persist.lastError), "and the reason is recorded", a.Persist.lastError);
    eq(local.cyrus_os_v2, undefined, "nothing landed in localStorage");
    eq(local.cyrus_os_mirror_rev, undefined,
       "the revision marker does not advance either — otherwise the next boot would believe it has data it lost");

    a.Persist.dirty = true;
    await a.Persist.flush();
    eq(a.Persist.dirty, false, "but IndexedDB still took the write");

    // Reload with a healthy mirror. The localStorage copy is stale/absent, so
    // the database is the only surviving copy and must win.
    const b = makeCtx({ idb, local });
    loadOS(b);
    b.Cyrus.fireReady();
    await tick(); await tick(); await tick();
    eq(b.Persist.hydrated, true, "the database is adopted when the mirror could not hold it");
    eq(String(b.Store.data.notes.big || "").length, 400, "the data that localStorage dropped is recovered");
  }

  // ---- equality is not a licence to swap -----------------------------------
  {
    const idb = makeIDB();
    const local = {};
    const a = makeCtx({ idb, local });
    loadOS(a);
    a.Store.data.notes.same = "identical";
    a.Store.save();
    a.Persist.dirty = true;
    await a.Persist.flush();

    const b = makeCtx({ idb, local });
    loadOS(b);
    b.Store.load();
    b.Cyrus.fireReady();
    await tick(); await tick(); await tick();
    eq(b.Persist.hydrated, false, "equal revisions are left alone: no pointless re-render");
    eq(b.Store.data.notes.same, "identical", "and the value is still right");
  }

  // ---- reset must clear the database too ----------------------------------
  // Otherwise: reset deletes localStorage, the page reloads, hydration finds a
  // *newer* IndexedDB revision, and faithfully restores what the user just
  // erased. A reset that does not stick is worse than one that fails loudly.
  {
    const idb = makeIDB();
    const local = {};
    const a = makeCtx({ idb, local });
    loadOS(a);
    a.Store.data.notes.secret = "erase me";
    a.Store.save();
    a.Persist.dirty = true;
    await a.Persist.flush();

    let reloaded = false;
    a.location.reload = () => { reloaded = true; };
    a.Store.reset();
    await tick(); await tick(); await tick();
    ok(reloaded, "reset still reloads the page");

    const b = makeCtx({ idb, local });
    loadOS(b);
    b.Store.load();
    b.Cyrus.fireReady();
    await tick(); await tick(); await tick();
    eq(b.Persist.hydrated, false, "after a reset there is nothing left to hydrate");
    eq(b.Store.data.notes.secret, undefined, "the erased state does NOT come back");
  }

  // ---- the OS must survive having no IndexedDB at all ---------------------
  // A private-mode browser or a denied upgrade must degrade to the old
  // behaviour, not to a white screen.
  {
    const ctx = makeCtx({ idb: false });
    loadOS(ctx);
    ctx.Store.data.notes.plain = "still saved";
    ctx.Store.save();
    eq(ctx.Persist.lsHealthy, true, "without IndexedDB the mirror is used directly");
    ok(ctx.__local.cyrus_os_v2, "and it is still written");
    eq(ctx.__local.cyrus_os_mirror_rev, "1", "with the revision recorded");
    ctx.Cyrus.fireReady();
    await tick(); await tick();
    eq(ctx.Persist.hydrated, false, "hydration declines cleanly when there is no database");
    eq(ctx.Persist.lastError, null, "and does not report a spurious error");
  }

  // ---- a failing database must not break saving ---------------------------
  {
    const idb = makeIDB();
    const ctx = makeCtx({ idb });
    loadOS(ctx);
    ctx.Store.data.notes.x = "1";
    ctx.Store.save();
    idb.failWrites = true;                 // the disk that was there stops working
    ctx.Persist.dirty = true;
    const wrote = await ctx.Persist.flush();
    eq(wrote, false, "a failed write reports failure instead of pretending");
    eq(ctx.Persist.dirty, true, "and stays dirty so it can be retried");
    ok(ctx.__local.cyrus_os_v2, "the mirror is untouched — persistence degrades, saving does not");
  }

  // ---- every save bumps exactly one revision ------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const start = ctx.Store.rev;
    for (let i = 0; i < 25; i++) ctx.Store.save();
    eq(ctx.Store.rev, start + 25, "revisions are monotonic: no lost updates in ordering");
  }

  process.exit(report("store persistence tests"));
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });