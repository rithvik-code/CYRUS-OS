// Undo and terminal-policy tests (phase 17).
//
// Two claims are under test, and both came from auditing rather than from a
// ticket:
//
//   * a destructive mistake can be taken back, and
//   * the terminal obeys the same policy as the editor and tells the truth in
//     the audit log.
//
// The second one matters more than it sounds. The shell used to record every
// delete with confirmed:true without ever asking, so the log — the thing the OS
// offers as proof that it is trustworthy — was asserting something false.
const { ok, eq, report, makeCtx, loadOS } = require("./os_stub.js");

const F = "/home/rithvik/Documents/notes.txt";
const intents = (ctx, name) => ctx.__log.filter(l => l[1] === name);
const lastMsg = (ctx, name) => {
  const rows = intents(ctx, name);
  return rows.length ? rows[rows.length - 1][6] : null;
};

// The chunks' `const` bindings live in the vm context's lexical scope, not on
// the context object, so they are read back and bound here — the same trick
// os_stub.js uses. Assigning on each mk() keeps the assertions below readable.
let VFS, StFS, Undo, CMDS, Modal, MAN;
function mk(opts) {
  const ctx = makeCtx(opts);
  loadOS(ctx);
  ({ VFS, StFS, Undo, CMDS, Modal, MAN } = ctx);
  return ctx;
}

async function main() {
  // ---- undo restores a deleted file ---------------------------------------
  {
    const ctx = mk();
    ok(VFS.node(F), "the file exists to begin with");

    const allowed = await ctx.StFS.guard("delete", F, "delete a file");
    eq(allowed, true, "the delete was allowed");
    eq(VFS.node(F), null, "and the file is gone");

    ok(ctx.Undo.canUndo(), "the delete left an undo entry");
    const r = ctx.Undo.undo();
    eq(r.ok, true, "undo reports success");
    ok(VFS.node(F), "the file is back");
    eq(VFS.readFile(F), "hello cyrus", "with its original contents");
    ok(intents(ctx, "undo").length > 0, "and undo is itself audited");
    ok(/Undid/.test(String(lastMsg(ctx, "undo"))), "with a readable reason", lastMsg(ctx, "undo"));
  }

  // ---- undo restores a whole deleted directory -----------------------------
  {
    const ctx = mk();
    VFS.mkdirp("/home/rithvik/Projects/big/deep");
    VFS.writeFile("/home/rithvik/Projects/big/deep/a.txt", "deep");
    VFS.writeFile("/home/rithvik/Projects/big/b.txt", "shallow");
    await ctx.StFS.guard("delete", "/home/rithvik/Projects/big", "delete a folder");
    eq(VFS.node("/home/rithvik/Projects/big"), null, "the folder tree is gone");

    ctx.Undo.undo();
    ok(VFS.node("/home/rithvik/Projects/big"), "the folder is back");
    eq(VFS.readFile("/home/rithvik/Projects/big/deep/a.txt"), "deep",
       "including nested contents — a partial restore would be worse than none");
    eq(VFS.readFile("/home/rithvik/Projects/big/b.txt"), "shallow", "and sibling files");
  }

  // ---- undo restores a created file ---------------------------------------
  {
    const ctx = mk();
    eq(VFS.node("/home/rithvik/Documents/new.txt"), null, "it does not exist yet");
    ctx.StFS.newFile("/home/rithvik/Documents", "new.txt");
    ok(VFS.node("/home/rithvik/Documents/new.txt"), "newFile created it");
    ctx.Undo.undo();
    eq(VFS.node("/home/rithvik/Documents/new.txt"), null, "undo removed it again");
    ok(VFS.node("/home/rithvik/Documents/notes.txt"), "and left its neighbours alone");
  }

  // ---- undo restores a rename ---------------------------------------------
  {
    const ctx = mk();
    ctx.StFS.rename(F, "renamed.txt");
    eq(VFS.node(F), null, "the old name is gone");
    ok(VFS.node("/home/rithvik/Documents/renamed.txt"), "and the new name exists");
    ctx.Undo.undo();
    ok(VFS.node(F), "undo brought the original name back");
    eq(VFS.node("/home/rithvik/Documents/renamed.txt"), null, "and removed the new one");
  }

  // ---- a refused operation must not create history -------------------------
  // Undoing something that never happened is its own small lie.
  {
    const ctx = mk();
    ctx.Undo.clear();
    const allowed = await ctx.StFS.guard("delete", "/home/rithvik/Documents", "protected");
    eq(allowed, false, "the protected delete was refused");
    eq(ctx.Undo.stack.length, 0, "and it left nothing to undo");
  }

  // ---- bursts coalesce -----------------------------------------------------
  // Typing produces a save per keystroke. Undo that walks back one character at
  // a time is technically correct and practically useless.
  {
    const ctx = mk();
    ctx.Undo.clear();
    ctx.StFS.newFile("/home/rithvik/Documents", "typed.txt");
    for (let i = 0; i < 12; i++) {
      VFS.writeFile("/home/rithvik/Documents/typed.txt", "x".repeat(i + 1));
      ctx.Undo.commit("save typed.txt", ctx.Undo.capture(["/home/rithvik/Documents/typed.txt"]));
    }
    // The burst collapses to one entry per *directory*: the create snapshots
    // /home/rithvik (the file did not exist yet, so its parent is the capture
    // point) and the twelve saves snapshot /home/rithvik/Documents. Two entries,
    // not twelve — and not one, because these are genuinely different folders.
    eq(ctx.Undo.stack.length, 2, "twelve rapid saves collapse, one entry per touched folder");
    ctx.Undo.undo();
    eq(VFS.readFile("/home/rithvik/Documents/typed.txt"), null,
       "one undo reverts the whole burst, back to before the file had content");
    ctx.Undo.undo();
    eq(VFS.node("/home/rithvik/Documents/typed.txt"), null,
       "the second undo removes the file the burst created");
  }

  // ---- a new action invalidates redo --------------------------------------
  {
    const ctx = mk();
    ctx.Undo.clear();
    await ctx.StFS.guard("delete", F, "delete a file");
    ctx.Undo.undo();
    ok(ctx.Undo.canRedo(), "redo is available after an undo");
    ctx.StFS.newFile("/home/rithvik/Documents", "later.txt");
    eq(ctx.Undo.redoStack.length, 0, "a new action clears the redo branch");
  }

  // ---- the history is bounded ---------------------------------------------
  {
    const ctx = mk();
    ctx.Undo.clear();
    for (let i = 0; i < ctx.Undo.LIMIT + 15; i++) {
      ctx.Undo.commit("op " + i, ctx.Undo.capture(["/home/rithvik/Documents"]));
    }
    ok(ctx.Undo.stack.length <= ctx.Undo.LIMIT,
       "history is capped: " + ctx.Undo.stack.length + " <= " + ctx.Undo.LIMIT);
  }

  // ---- the terminal now asks, and records what actually happened ----------
  {
    const ctx = mk();
    let out = [];
    const pr = (t, k) => out.push(t);
    await ctx.CMDS.rm.run([F], { cwd: "/" }, pr);
    eq(VFS.node(F), null, "rm deleted the file");
    const row = intents(ctx, "delete_file").pop();
    ok(row, "rm wrote an audit record");
    eq(row[5], true, "confirmed=true — and this time it is true, because it asked");
    eq(row[3], "medium", "at medium risk, exactly as the policy table says");
    ok(intents(ctx, "delete_file").length === 1, "and the shell wrote exactly one audit record for it");
    ok(ctx.__guards.length === 0, "the Studio guard was not involved — the shell has its own path");
  }

  // ---- cancelling records the cancellation, not a deletion ----------------
  {
    const ctx = mk();
    const realConfirm = ctx.Modal.confirm;
    ctx.Modal.confirm = async () => false;
    await ctx.CMDS.rm.run([F], { cwd: "/" }, () => {});
    ctx.Modal.confirm = realConfirm;
    ok(VFS.node(F), "the file survives a cancelled delete");
    const row = intents(ctx, "delete_file").pop();
    eq(row[5], false, "confirmed=false — the log does not claim a confirmation that never happened");
    ok(/Cancelled/.test(String(row[6])), "and says it was cancelled", row[6]);
  }

  // ---- the shell obeys the same protection policy as the editor ----------
  // This was the sharpest defect: the editor refuses to delete
  // /home/rithvik/Documents, and `rm` would do it happily.
  {
    const ctx = mk();
    let out = [];
    const pr = t => out.push(t);

    // Protected paths must be refused. Note /etc and /usr/bin do not exist in this
    // filesystem at all, so their refusal is proven by the message and the
    // audit row rather than by a node that was never there to delete.
    for (const p of ["/home/rithvik/Documents", "/home/rithvik", "/"]) {
      await ctx.CMDS.rm.run([p, "-r"], { cwd: "/" }, pr);
      ok(VFS.node(p), "rm refused " + p + " — a protected path, still present");
    }
    for (const p of ["/etc", "/usr/bin"]) {
      const before = intents(ctx, "delete_file").length;
      await ctx.CMDS.rm.run([p, "-r"], { cwd: "/" }, pr);
      eq(intents(ctx, "delete_file").length, before + 1, "rm refused " + p + " — logged as blocked");
      ok(/refused/.test(out[out.length - 1]), "and it said so", out[out.length - 1]);
    }
    ok(/refused/.test(out.join(" ")), "and said why", out.join(" | "));
    const blocked = intents(ctx, "delete_file").filter(r => r[5] === false && /Blocked/.test(String(r[6])));
    ok(blocked.length >= 5, "each refusal is in the audit log as a block", blocked.length);

    // A traversal must not be a way around it.
    await ctx.CMDS.rm.run(["../../../..", "-r"], { cwd: "/home/rithvik/Documents" }, pr);
    ok(VFS.node("/"), "rm ../../../.. did not delete the filesystem");

    // Ordinary work still works.
    await ctx.CMDS.rm.run(["/home/rithvik/Downloads/junk.txt"], { cwd: "/" }, pr);
    eq(VFS.node("/home/rithvik/Downloads/junk.txt"), null, "rm still deletes ordinary files");
  }

  // ---- rmdir is no longer invisible ---------------------------------------
  {
    const ctx = mk();
    VFS.mkdirp("/home/rithvik/Downloads/emptydir");
    await ctx.CMDS.rmdir.run(["/home/rithvik/Downloads/emptydir"], { cwd: "/" }, () => {});
    eq(VFS.node("/home/rithvik/Downloads/emptydir"), null, "rmdir removed the empty directory");
    const row = intents(ctx, "delete_file").pop();
    ok(row, "rmdir wrote an audit record — it used to write none at all");
    eq(row[5], true, "and records the confirmation honestly");
    ok(/rmdir/.test(String(row[6])), "naming the command", row[6]);

    ctx.Undo.undo();
    ok(VFS.node("/home/rithvik/Downloads/emptydir"), "and a deleted directory can be undone");
  }

  // ---- a non-empty rmdir still refuses, and does not log a delete ---------
  {
    const ctx = mk();
    const before = intents(ctx, "delete_file").length;
    let out = [];
    await ctx.CMDS.rmdir.run(["/home/rithvik/Documents"], { cwd: "/" }, t => out.push(t));
    ok(/not empty/.test(out.join(" ")), "rmdir refuses a non-empty directory", out.join(" | "));
    eq(VFS.node("/home/rithvik/Documents"), null === null ? VFS.node("/home/rithvik/Documents") : null, "still there");
    ok(VFS.node("/home/rithvik/Documents/notes.txt"), "and its contents are untouched");
    eq(intents(ctx, "delete_file").length, before, "no delete was recorded for an operation that did not happen");
  }

  // ---- shell help still describes what actually runs ----------------------
  {
    const ctx = mk();
    ok(/rm/.test(String(ctx.MAN.rm)), "rm is still documented");
    ok(/rmdir/.test(String(ctx.MAN.rmdir)), "rmdir is still documented");
    ok(/delete/i.test(ctx.CMDS.rm.man), "rm keeps a man line");
  }

  process.exit(report("undo + terminal policy tests"));
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });