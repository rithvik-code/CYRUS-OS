// Regression tests for OS Phase 10 — real disk.
//
// The claim the UI makes is specific: a `/mnt/...` path is a real folder, and
// every other path is untouched. Both halves are asserted here, because the
// dangerous failure is the second one going quietly wrong — a router that
// misfires would send the user's Documents folder somewhere unexpected.
//
// os_p10 has to be loaded twice: once with no mounts (the regression case) and
// once with a mount registered (the feature case), because VFS is patched at
// load time and the patch is what is under test.
const { ok, eq, report, makeCtx, load, loadOS } = require("./os_stub.js");

async function main() {

  // ---- with nothing mounted, CYRUS must behave exactly as it did ----------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const { VFS, Mnt } = ctx;

    eq(Mnt.list().length, 0, "no mounts at start");
    eq(VFS.node("/home/rithvik/Documents/notes.txt").content, "hello cyrus", "original VFS reads still work");
    ok(VFS.writeFile("/home/rithvik/Documents/new.txt", "x"), "writes to the original tree still work");
    eq(VFS.node("/home/rithvik/Documents/new.txt").content, "x", "and the write landed where it was asked to");

    ok(!Mnt.isMounted("/home/rithvik"), "a normal path is not a mount path");
    ok(!Mnt.isMounted("/mnt/nope/x"), "an unmounted /mnt name is not a mount path");
    ok(!Mnt.isMounted("/mnt"), "/mnt itself is not a mounted path");

    // The four shell verbs the phase claims to add.
    for (const c of ["mount", "umount", "mounts", "sync", "df"]) {
      ok(typeof ctx.CMDS[c] === "object", "shell verb `" + c + "` is registered");
      ok(typeof ctx.MAN[c] === "string", "`man " + c + "` exists");
    }
    eq(ctx.MAN.df.includes("quota") || ctx.MAN.df.includes("real"), true, "man df talks about real storage");
  }

  // ---- with a mount registered --------------------------------------------
  const ctx = makeCtx();
  loadOS(ctx);
  const { VFS, Mnt, BACKENDS, DiskUsage, Bridge } = ctx;

  // A fake backend: no picker, no permission prompt, deterministic tree.
  const fakeRoot = {
    kind: "fake",
    files: {
      "readme.md": "real file contents",
      "nested/deep.txt": "deeper",
    },
  };
  const writes = [];
  BACKENDS.fake = {
    label: "Fake",
    available: () => true,
    hint: "",
    async acquire() { return fakeRoot; },
    async scan() {
      const out = ctx.mkDirNode("/", {});
      const docs = ctx.mkDirNode("docs", {});
      out.children["docs"] = docs;
      const readme = ctx.mkFileNode("readme.md", "real file contents");
      docs.children["readme.md"] = readme;
      const nested = ctx.mkDirNode("nested", {});
      docs.children["nested"] = nested;
      nested.children["deep.txt"] = ctx.mkFileNode("deep.txt", "deeper");
      return out;
    },
    async write(dir, rel, content) { writes.push([rel, content]); },
    async remove(dir, rel) { writes.push(["!" + rel]); },
    async mkdir() {}, async move() {},
  };

  eq(Mnt.parse("/home/rithvik"), null, "parse() returns null for a normal path");
  eq(Mnt.parse("/mnt"), null, "parse() returns null for /mnt itself");

  const m = await Mnt.mount("fake", { kind: "fake", label: "Fake" });
  ok(m.ready, "mount reports ready after a successful scan");

  ok(Mnt.isMounted("/mnt/fake"), "a registered mount is recognised");
  const p = Mnt.parse("/mnt/fake/docs/readme.md");
  eq(p.name, "fake", "parse extracts the mount name");
  eq(p.sub, "/docs/readme.md", "parse extracts the sub-path");
  eq(Mnt.parse("/mnt/fake").sub, "/", "the mount root parses to /");

  ok(Mnt.parse("/mnt/fake").mount === m, "parse returns the mount object");

  // Reads route to the mirror.
  eq(VFS.node("/mnt/fake/docs/readme.md").content, "real file contents", "VFS.node reads through the mount");
  eq(VFS.node("/mnt/fake/docs/nested/deep.txt").content, "deeper", "nested reads route too");
  ok(VFS.node("/mnt/fake/docs/missing.txt") === null, "a missing file under a mount is still null");

  // The original tree is still reachable and unaffected by the mount.
  eq(VFS.node("/home/rithvik/Documents/notes.txt").content, "hello cyrus", "the original tree is untouched by the mount");

  // Writes are mirrored synchronously and pushed asynchronously.
  const before = writes.length;
  ok(VFS.writeFile("/mnt/fake/docs/new.txt", "written"), "writeFile under a mount returns true");
  eq(VFS.node("/mnt/fake/docs/new.txt").content, "written", "the write is visible immediately");
  eq(writes.length, before, "the write has not been pushed yet — that happens on flush");
  const n = await Mnt.flush();
  ok(n >= 1, "flush reports the pending write");
  ok(writes.some(w => w[0] === "/docs/new.txt" && w[1] === "written"), "flush pushed the right path and body to the backend");

  // Removal is tracked as a removal, not as an empty write.
  ok(VFS.remove("/mnt/fake/docs/readme.md"), "remove under a mount returns true");
  ok(VFS.node("/mnt/fake/docs/readme.md") === null, "the file is gone from the mirror");
  await Mnt.flush();
  ok(writes.some(w => w[0] === "!/docs/readme.md"), "flush told the backend to delete, not to blank the file");

  // A write that would destroy a directory is refused, as before.
  ok(VFS.writeFile("/mnt/fake/docs/nested", "clobber") === false, "writing over a directory is refused");

  // Read-only mounts refuse writes instead of silently dropping them.
  await Mnt.mount("ro", { kind: "fake", label: "RO", write: false });
  let threw = null;
  try { VFS.writeFile("/mnt/ro/docs/x.txt", "nope"); } catch (e) { threw = e; }
  ok(threw && /read-only/.test(threw.message), "a read-only mount refuses a write instead of pretending", threw && threw.message);
  ok(VFS.node("/mnt/ro/docs/x.txt") === null, "and the refused write left nothing behind");

  // unmount removes the namespace entirely.
  ok(Mnt.unmount("fake"), "unmount returns true for a live mount");
  ok(!Mnt.isMounted("/mnt/fake"), "the namespace is gone after unmount");
  ok(!Mnt.unmount("fake"), "unmounting twice returns false rather than throwing");
  eq(VFS.node("/mnt/fake/docs/new.txt"), null, "old mount paths no longer resolve");

  // The audit log recorded the mount and unmount, as medium-risk changes.
  const intents = ctx.__log.map(l => l[1]);
  ok(intents.includes("mount_disk"), "mounting is audit-logged");
  ok(intents.includes("unmount_disk"), "unmounting is audit-logged");

  // `df` must not invent a disk size.
  const df = await DiskUsage.report();
  ok(/browser storage\.estimate/.test(df), "df attributes its number to storage.estimate()", df);
  ok(!/512 GB/.test(df), "df contains no invented capacity");

  // The bridge client refuses to guess.
  Bridge.url = "";
  let bridgeErr = null;
  try { await Bridge.probe(); } catch (e) { bridgeErr = e; }
  eq(Bridge.online, false, "a bridge with no URL is not 'online'");
  ok(bridgeErr === null, "probe reports false rather than throwing when unconfigured");

  process.exit(report("disk tests"));
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });