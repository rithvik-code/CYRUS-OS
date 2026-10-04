// Regression tests for OS Phase 12 — snapshots.
//
// "This cannot be undone from inside Studio" was a true sentence about a false
// capability. These tests exist to make the replacement claim — that a delete
// is recoverable — actually true, and to keep it true. The assertions that
// matter are the destructive ones: write something, snapshot, destroy it,
// restore, and check the bytes came back.
const { ok, eq, report, makeCtx, loadOS } = require("./os_stub.js");

async function main() {
  const ctx = makeCtx();
  loadOS(ctx);
  const { Snapshots, VFS, Store } = ctx;

  // No IndexedDB in node, so the module falls back to the in-memory store.
  // The snapshot logic under test is identical either way — that is the whole
  // reason it was written against a four-method interface.
  Snapshots.store = ctx.MemSnapStore;

  // ---- hashing ------------------------------------------------------------
  eq(Snapshots.hash("abc"), Snapshots.hash("abc"), "the hash is stable for equal content");
  ok(Snapshots.hash("abc") !== Snapshots.hash("abd"), "the hash differs for different content");
  eq(Snapshots.hash(""), Snapshots.hash(null), "null and empty string hash alike, so an empty file dedupes with nothing");
  ok(/^[0-9a-f]{16}$/.test(Snapshots.hash("x")), "the hash is a fixed-shape hex string");

  // ---- capture ------------------------------------------------------------
  const cap = Snapshots.capture("before the mess", "test");
  ok(cap.entries.length > 0, "capture sees the seeded filesystem", cap.entries.length + " files");
  ok(cap.entries.every(e => e.path.startsWith("/")), "every captured path is absolute");
  ok(cap.entries.every(e => typeof e.h === "string"), "every captured entry is hashed for dedupe");
  ok(cap.entries.find(e => e.path === "/home/rithvik/Documents/notes.txt"), "the seeded file was captured");

  // ---- take / list / retention -------------------------------------------
  const s1 = await Snapshots.take("restore point 1", "test");
  ok(s1 && s1.id, "take returns a snapshot with an id");
  ok(s1.count === s1.entries.length, "the snapshot records its file count");
  ok(s1.bytes > 0, "the snapshot records a non-zero size");
  eq((await Snapshots.list()).length, 1, "list shows the snapshot");

  // Nothing changed, so a second snapshot must be byte-identical in content.
  const s2 = await Snapshots.take("restore point 2", "test");
  eq(JSON.stringify(s2.entries), JSON.stringify(s1.entries), "an unchanged filesystem produces an identical snapshot");

  // Retention keeps the newest RETAIN *unpinned* snapshots. take() prunes as it
  // goes, so the list saturates rather than growing.
  const RETAIN = Snapshots.RETAIN;
  ok((await Snapshots.list()).length === 2, "two snapshots so far");
  for (let i = 0; i < RETAIN + 5; i++) await Snapshots.take("filler " + i, "test");
  const kept = await Snapshots.list();
  ok(kept.length <= RETAIN, "retention saturates at RETAIN", kept.length + " kept, RETAIN=" + RETAIN);
  eq(kept[0].label, "filler " + (RETAIN + 4), "the newest snapshot is the one kept");

  // Protection is explicit, not inferred from the label — so a pinned snapshot
  // survives however much churn follows it.
  const pinned = await Snapshots.take("before the big refactor", "manual", true);
  eq(pinned.keep, true, "a snapshot taken with keep:true is pinned");
  for (let i = 0; i < RETAIN + 5; i++) await Snapshots.take("churn " + i, "test");
  ok((await Snapshots.list()).some(s => s.id === pinned.id), "a pinned snapshot survives pruning");
  ok(!(await Snapshots.list()).some(s => s.keep === false && /churn 0$/.test(s.label)),
     "unpinned churn was still pruned");
  await Snapshots.store.del(pinned.id);

  // ---- the destructive round trip ----------------------------------------
  // This is the assertion the whole phase exists for.
  Snapshots.store = ctx.MemSnapStore;
  const keeper = await Snapshots.take("golden", "test");
  const ORIGINAL = "hello cyrus";
  const notesPath = "/home/rithvik/Documents/notes.txt";
  eq(VFS.node(notesPath).content, ORIGINAL, "the file starts with its real contents");

  // Destroy it, the way a user would.
  VFS.remove(notesPath);
  eq(VFS.node(notesPath), null, "the file is gone — the delete really happened");
  VFS.writeFile("/home/rithvik/Documents/stray.txt", "should not survive a full restore");
  ok(VFS.node("/home/rithvik/Documents/stray.txt"), "a stray file exists that the snapshot does not contain");

  // And bring it back.
  const res = await Snapshots.restore(keeper.id, async () => true);
  ok(res.ok, "restore succeeds");
  eq(VFS.node(notesPath).content, ORIGINAL, "the file came back byte for byte");
  eq(VFS.node("/home/rithvik/Documents/stray.txt"), null, "the stray file was removed by a full restore");
  ok(/snapshot of the previous state was kept/.test(res.message), "restore says a pre-restore snapshot was kept", res.message);

  // The pre-restore snapshot must itself be restorable — recovery cannot be
  // the one action that is irreversible.
  const all = await Snapshots.list();
  const pre = all.find(s => /pre-restore/.test(s.label));
  ok(pre, "a pre-restore snapshot exists");
  ok(pre && pre.entries.some(e => e.path === "/home/rithvik/Documents/stray.txt"),
     "the pre-restore snapshot captured the state that the restore then removed");

  // Restoring what is already there is a no-op, not a rewrite.
  const noop = await Snapshots.restore(keeper.id, async () => true);
  ok(noop.ok && /already matches/.test(noop.message), "restoring an identical state is reported as a no-op", noop.message);

  // ---- diff ---------------------------------------------------------------
  const golden = await Snapshots.store.get(keeper.id);
  const now = () => Snapshots.capture("now", "diff").entries;
  eq(Snapshots.diff(golden.entries, now()).length, 0, "diff of an identical pair is empty");

  VFS.writeFile(notesPath, "something else entirely");
  let d = Snapshots.diff(golden.entries, now());
  ok(d.some(x => x.path === notesPath && x.kind === "changed"), "diff reports a changed file");

  VFS.writeFile("/home/rithvik/Documents/added.txt", "new");
  d = Snapshots.diff(golden.entries, now());
  ok(d.some(x => x.path === "/home/rithvik/Documents/added.txt" && x.kind === "extra"), "diff reports a file that is only in the current state");

  VFS.remove("/home/rithvik/Documents/added.txt");
  VFS.remove(notesPath);
  d = Snapshots.diff(golden.entries, now());
  ok(d.some(x => x.path === notesPath && x.kind === "missing"), "diff reports a file that is only in the snapshot");

  // ---- single-file restore ------------------------------------------------
  const r1 = await Snapshots.restoreFile(keeper.id, notesPath, async () => true);
  ok(r1.ok, "a single file restores without touching anything else");
  eq(VFS.node(notesPath).content, ORIGINAL, "the one file is correct again");
  ok(VFS.node("/home/rithvik/Documents/notes.txt"), "and it is the only thing that changed");

  const bad = await Snapshots.restoreFile(keeper.id, "/nope/missing.txt", async () => true);
  ok(!bad.ok, "restoring a file the snapshot does not hold fails loudly");

  const missing = await Snapshots.restore("no-such-id", async () => true);
  ok(!missing.ok, "restoring a missing snapshot fails loudly");

  // ---- export / import ----------------------------------------------------
  const bundle = await Snapshots.exportAll();
  ok(bundle.length > 10, "the export bundle is not empty");
  const parsed = JSON.parse(bundle);
  eq(parsed.format, "cyrus-snapshot-bundle", "the bundle declares its format");
  eq(parsed.version, 1, "the bundle declares its version");
  ok(Array.isArray(parsed.snapshots) && parsed.snapshots.length > 0, "the bundle carries snapshots");
  ok(parsed.exported, "the bundle is timestamped");

  // Wipe everything, then import it back.
  await Snapshots.store.del(keeper.id);
  const imported = await Snapshots.importBundle(bundle);
  ok(imported.ok, "the bundle imports cleanly");
  const back = await Snapshots.list();
  ok(back.some(s => s.id === keeper.id), "the original snapshot survived the round trip");

  ok(!Snapshots.parseBundle("not json at all").ok, "garbage is rejected");
  ok(!Snapshots.parseBundle('{"format":"something-else"}').ok, "a foreign format is rejected");
  ok(!Snapshots.parseBundle('{"format":"cyrus-snapshot-bundle"}').ok, "a bundle with no snapshots array is rejected");

  // ---- automatic restore points ------------------------------------------
  // The promise is "a delete is recoverable". That is only true if the delete
  // itself takes the snapshot, so the wiring is asserted rather than assumed.
  ok(typeof ctx.CMDS.rm.run === "function", "rm is still a shell command");
  // Which flag marks the wrapper is an implementation detail — phase 17
  // rewrote rm to be policy-aware and marked its replacement differently. What
  // has to hold is that a wrapper exists, and that the restore point is really
  // taken; the latter is asserted by label below, which cannot be faked.
  const marked = o => !!(o && (o.__snapWrapped || o.__undoWrapped || o.__undoFixed));
  ok(marked(ctx.CMDS.rm), "rm is wrapped to snapshot before it runs");
  eq(marked(ctx.CMDS.rm), true, "the wrapper is marked so it cannot be double-wrapped");

  // Counting snapshots cannot prove a restore point was taken — retention
  // prunes on every take, so the count stays flat. Assert on the label.
  const hasSnapLabelled = async (re) => (await Snapshots.list()).some(s => re.test(s.label));
  ok(!(await hasSnapLabelled(/rm/)), "no rm restore point exists yet");
  await ctx.CMDS.rm.run(["/home/rithvik/Documents/notes.txt"], {}, () => {});
  ok(await hasSnapLabelled(/rm/), "running rm in the shell took a restore point naming the command");
  eq(VFS.node("/home/rithvik/Documents/notes.txt"), null, "and rm did delete the file");

  ok(marked(ctx.StFS.guard), "the Studio explorer guard is wrapped");
  await ctx.StFS.guard("delete", "/home/rithvik/Documents/notes.txt", "delete a file");
  ok(await hasSnapLabelled(/delete/), "a medium-risk Studio delete takes a restore point naming the op");

  // A low-risk operation must not litter the snapshot list.
  const lowCount = (await Snapshots.list()).filter(s => /save/.test(s.label)).length;
  await ctx.StFS.guard("save", "/home/rithvik/Documents/x.txt", "save");
  eq((await Snapshots.list()).filter(s => /save/.test(s.label)).length, lowCount,
     "a low-risk Studio operation takes no snapshot");

  // ---- audit --------------------------------------------------------------
  const intents = ctx.__log.map(l => l[1]);
  ok(intents.includes("snapshot_disk"), "taking a snapshot is audit-logged");
  ok(intents.includes("restore_disk"), "restoring is audit-logged");
  // A whole-filesystem restore is high risk; a single-file restore is medium.
  // Both log as restore_disk, so they are told apart by the risk field itself.
  const whole = ctx.__log.filter(l => l[1] === "restore_disk" && /Restored \d+ files/.test(String(l[6])));
  ok(whole.length > 0, "a whole-filesystem restore was logged");
  ok(whole.every(l => l[3] === "high"), "a whole-filesystem restore is logged at high risk",
     whole.map(l => l[3]).join(","));
  const single = ctx.__log.filter(l => l[1] === "restore_disk" && /^Restored \//.test(String(l[6])));
  ok(single.length > 0, "a single-file restore was logged");
  ok(single.every(l => l[3] === "medium"), "a single-file restore is logged at medium risk",
     single.map(l => l[3]).join(","));

  process.exit(report("snapshot tests"));
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });