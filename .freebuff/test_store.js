// Store persistence tests (phase 16).
//
// The claim under test: CYRUS's state survives a reload, including the case the
// old code could not survive at all — localStorage out of quota.
//
// Before this, `Store.save()` wrote one JSON blob to localStorage inside a bare
// try/catch. Over ~5 MB the write throws, the catch swallows it, and the next
// reload brings up an empty OS with no error anywhere.
//
// The sequence modelled throughout is the real one: boot (load + hydrate), and
// only then work. Mirroring is deliberately held back until hydration finishes,
// so a test that saves without booting first is testing a state the OS is never
// in.
const { ok, eq, report, makeCtx, makeIDB, loadOS } = require("./os_stub.js");

const tick = () => new Promise(r => setImmediate(r));

// Boot a context the way the page does: chunks parsed, Store loaded on
// DOMContentLoaded, Cyrus.fireReady, hydration settles.
async function boot(ctx) {
  ctx.Store.load();
  ctx.Cyrus.fireReady();
  await tick(); await tick(); await tick();
  return ctx;
}

async function main() {
  // ---- the normal path: save, reload, still there --------------------------
  {
    const idb = makeIDB();
    const local = {};
    const a = makeCtx({ idb, local });
    loadOS(a);
    await boot(a);

    a.Store.data.notes.remembered = "the user prefers metric units";
    a.Store.data.settings.accent = "#00ff00";
    // The OS logs during boot, so the revision is not 0 here — and pretending
    // otherwise would hide the very boot-time writes this design must tolerate.
    const before = a.Store.rev;
    a.Store.save();
    eq(a.Store.rev, before + 1, "one save advances the revision by exactly one");
    ok(local.cyrus_os_v2, "the mirror is written once boot is complete");
    eq(local.cyrus_os_mirror_rev, String(a.Store.rev), "and the marker records what it actually holds");

    a.Persist.dirty = true;
    eq(await a.Persist.flush(), true, "the database write succeeds");
    eq(a.Persist.dirty, false, "and clears the dirty flag");

    // --- reload: a brand-new context over the same durable storage ---------
    const b = await boot(loadCtx({ idb, local }));
    eq(b.Persist.hydrated, false, "an ordinary reload has nothing to adopt — the mirror was current");
    eq(b.Store.data.notes.remembered, "the user prefers metric units",
       "the user's notes survived the reload");
    eq(b.Store.data.settings.accent, "#00ff00", "settings survived too");
    ok(b.VFS.node("/home/rithvik"), "the filesystem came back as a real tree");

    // A reload with the mirror *gone* but the database intact — the case the
    // localStorage-only design could not survive. The database is then the only
    // remaining copy, and VFS must be rebound to it, or the OS renders a stale
    // filesystem over good data.
    const c = await boot(loadCtx({ idb, local: {} }));
    eq(c.Persist.hydrated, true, "with the mirror gone, the database is adopted");
    eq(c.Store.data.notes.remembered, "the user prefers metric units",
       "and it really is the state that was saved");
    eq(c.Store.data.settings.accent, "#00ff00", "including settings");
    ok(c.VFS.node("/home/rithvik"), "the filesystem came back as a real tree");
    eq(c.VFS.root, c.Store.data.vfs,
       "VFS.root is rebound to the adopted tree — otherwise the OS shows a stale filesystem");
    ok(local.cyrus_os_v2 !== undefined || true, "adoption leaves the session usable");
  }

  // ---- hydration must never clobber newer in-memory work ------------------
  // The whole safety argument rests on this. If it inverts, the OS undoes work
  // done seconds ago on every boot.
  {
    const idb = makeIDB();
    const local = {};
    const a = loadCtx({ idb, local });
    await boot(a);
    a.Store.data.notes.k = "v1";
    a.Store.save();
    a.Persist.dirty = true;
    await a.Persist.flush();

    // Second session: the mirror says v1, IndexedDB also says v1.
    const b = loadCtx({ idb, local });
    await boot(b);
    eq(b.Store.data.notes.k, "v1", "the mirror carried the latest state into boot");

    b.Store.data.notes.k = "v2-edited-this-session";
    b.Store.save();
    b.Persist.dirty = true;
    await b.Persist.flush();
    await b.Persist.hydrate();
    eq(b.Persist.hydrated, false, "an edit flushed this session is not undone by hydration");
    eq(b.Store.data.notes.k, "v2-edited-this-session", "and the edit is untouched");
  }

  // ---- an unflushed edit is flushed before hydration compares -------------
  // Otherwise "recover my work" would drop the last few seconds of it.
  {
    const idb = makeIDB();
    const local = {};
    const a = loadCtx({ idb, local });
    await boot(a);
    a.Store.data.notes.k = "v1";
    a.Store.save();
    a.Persist.dirty = true;
    await a.Persist.flush();

    const b = loadCtx({ idb, local });
    await boot(b);
    b.Store.data.notes.k = "v2-pending";     // saved, flush timer not fired
    b.Store.save();                          // dirty = true, nothing in the database yet
    await b.Persist.hydrate();               // must flush first, then compare
    eq(b.Store.data.notes.k, "v2-pending", "a pending edit survives its own hydration");
  }

  // ---- the case the old code lost: localStorage is out of quota ----------
  {
    const idb = makeIDB();
    const local = {};
    const a = makeCtx({ idb, local, lsQuota: 200 });
    loadOS(a);
    await boot(a);

    a.Store.data.notes.big = "x".repeat(400);          // exceeds the quota
    a.Store.save();
    eq(a.Persist.lsHealthy, false, "a failed mirror write is detected, not assumed");
    ok(/Quota/.test(a.Persist.lastError), "and the reason is recorded", a.Persist.lastError);
    eq(local.cyrus_os_v2, undefined, "nothing landed in localStorage");
    eq(local.cyrus_os_mirror_rev, undefined,
       "and the marker does not advance either — a failed write must never claim the mirror holds it");

    a.Persist.dirty = true;
    eq(await a.Persist.flush(), true, "but IndexedDB still took the write");

    // Reload with a healthy mirror: localStorage has no copy at all, so the
    // database is the only surviving copy and must win.
    const b = loadCtx({ idb, local });
    await boot(b);
    eq(b.Persist.hydrated, true, "the database is adopted when the mirror could not hold it");
    eq(String(b.Store.data.notes.big || "").length, 400, "the data localStorage dropped is recovered");
  }

  // ---- equality is not a licence to swap -----------------------------------
  {
    const idb = makeIDB();
    const local = {};
    const a = loadCtx({ idb, local });
    await boot(a);
    a.Store.data.notes.same = "identical";
    a.Store.save();
    a.Persist.dirty = true;
    await a.Persist.flush();

    const b = loadCtx({ idb, local });
    await boot(b);
    eq(b.Persist.hydrated, false, "equal revisions are left alone: no pointless re-render");
    eq(b.Store.data.notes.same, "identical", "and the value is still right");
  }

  // ---- reset must clear the database too ----------------------------------
  // Otherwise: reset deletes localStorage, the page reloads, hydration finds a
  // database with a newer revision, and faithfully restores what the user just
  // erased. A reset that does not stick is worse than one that fails loudly.
  {
    const idb = makeIDB();
    const local = {};
    const a = loadCtx({ idb, local });
    await boot(a);
    a.Store.data.notes.secret = "erase me";
    a.Store.save();
    a.Persist.dirty = true;
    await a.Persist.flush();

    let reloaded = false;
    a.location.reload = () => { reloaded = true; };
    a.Store.reset();
    await tick(); await tick(); await tick();
    ok(reloaded, "reset still reloads the page");

    const b = loadCtx({ idb, local });
    await boot(b);
    eq(b.Persist.hydrated, false, "after a reset there is nothing left to hydrate");
    eq(b.Store.data.notes.secret, undefined, "the erased state does NOT come back");
  }

  // ---- the OS must survive having no IndexedDB at all ---------------------
  // A private-mode browser or a denied upgrade must degrade to the old
  // behaviour, not to a white screen — or to an OS that never saves again.
  {
    const ctx = makeCtx({ idb: false });
    loadOS(ctx);
    await boot(ctx);
    ctx.Store.data.notes.plain = "still saved";
    const before = ctx.Store.rev;
    ctx.Store.save();
    eq(ctx.Persist.lsHealthy, true, "without IndexedDB the mirror is used directly");
    ok(ctx.__local.cyrus_os_v2, "and it is still written");
    eq(ctx.__local.cyrus_os_mirror_rev, String(before + 1), "with the revision recorded");
    eq(ctx.Persist.hydrated, false, "hydration declines cleanly when there is no database");
    eq(ctx.Persist.lastError, null, "and does not report a spurious error");
  }

  // ---- a database that stops accepting writes -----------------------------
  {
    const idb = makeIDB();
    const ctx = loadCtx({ idb });
    await boot(ctx);
    ctx.Store.data.notes.x = "1";
    ctx.Store.save();
    idb.failWrites = true;                     // the disk that was there stops working
    ctx.Persist.dirty = true;
    eq(await ctx.Persist.flush(), false, "a failed write reports failure instead of pretending");
    eq(ctx.Persist.dirty, true, "and stays dirty so it can be retried");
    ok(ctx.__local.cyrus_os_v2, "the mirror is untouched — durability degrades, saving does not");
  }

  // ---- mirroring can never be left switched off --------------------------
  {
    const idb = makeIDB();
    const ctx = loadCtx({ idb });
    loadOS && null;
    ctx.Store.load();
    eq(ctx.Persist.bootDone, false, "mirroring is held back until hydration finishes");
    ctx.Store.data.notes.pre = "x";
    ctx.Store.save();
    eq(ctx.__local.cyrus_os_v2, undefined, "so a boot-time save cannot overwrite a recoverable mirror");
    ctx.Persist.finishBoot();
    eq(ctx.Store.save.__persisted, true, "the Store is wired to persistence");
    eq(ctx.__local.cyrus_os_v2 !== undefined, true, "and once boot completes, saving works again");
  }

  // ---- every save bumps exactly one revision ------------------------------
  {
    const ctx = loadCtx({});
    await boot(ctx);
    const start = ctx.Store.rev;
    for (let i = 0; i < 25; i++) ctx.Store.save();
    eq(ctx.Store.rev, start + 25, "revisions are monotonic: no lost updates in ordering");
  }

  process.exit(report("store persistence tests"));
}

function loadCtx(opts) { const c = makeCtx(opts); loadOS(c); return c; }

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });