// OS-state inspector + action result envelope tests (phase 18).
//
// Two claims are under test:
//
//   * anything can ask what the user is doing, and
//   * every action reports the same thing when it finishes.
//
// The second one is not cosmetic. Before this, an action returned whatever
// shape it liked, so "did that actually change anything?" could only be answered
// by guessing from a message string.
const { ok, eq, report, makeCtx, loadOS } = require("./os_stub.js");

const F = "/home/rithvik/Documents/notes.txt";

function loadCtx(opts) {
  const c = makeCtx(opts);
  loadOS(c);
  return c;
}

async function main() {
  // ---- the snapshot must never throw, whatever is missing ------------------
  {
    const ctx = loadCtx();
    const s = ctx.OSState.snapshot();
    ok(s && typeof s === "object", "a snapshot comes back");
    eq(typeof s.ts, "number", "with a timestamp");
    ok("focus" in s && "editor" in s && "system" in s, "and the documented keys");
    eq(s.focus, null, "no window is focused in a headless harness — null, not a crash");
    eq(s.editor, null, "no Studio instance exists — null, not a crash");
  }

  // A broken collaborator must not take the inspector down with it. This is the
  // whole reason the snapshot is defensive: it runs while the OS is mid-busy.
  {
    const ctx = loadCtx();
    ctx.StApp = { instance: { buildContext(){ throw new Error("editor exploded"); } } };
    let snap = null, threw = false;
    try { snap = ctx.OSState.snapshot(); } catch (e) { threw = true; }
    eq(threw, false, "a throwing buildContext does not propagate");
    eq(snap && snap.editor, null, "it degrades to null instead of taking the caller down");
  }

  // ---- focus is tracked, not scraped --------------------------------------
  {
    const ctx = loadCtx();
    // The chunk installs this at load time; calling again must decline rather
    // than double-wrap WM.focus.
    eq(ctx.WM.focus.__osstate, true, "focus tracking is installed by the chunk");
    eq(ctx.OSState.trackFocus(), false, "and refuses to install twice");
    const win = { id:"w1", title:"Files", el:{ classList:{ add(){}, remove(){}, contains(){ return false; } } } };
    ctx.WM.wins.set("w1", win);
    ctx.WM.focus(win);
    const f = ctx.OSState.focused();
    eq(f && f.id, "w1", "focus is reported without reading CSS classes");
  }

  // A window closed behind our back must not be reported as focused.
  {
    const ctx = loadCtx();
    const win = { id:"w2", title:"Gone", el:{ classList:{ add(){}, remove(){}, contains(){ return false; } } } };
    ctx.WM.wins.set("w2", win);
    ctx.WM.focus(win);
    ctx.WM.wins.delete("w2");
    eq(ctx.OSState.focused(), null, "a closed window is not reported as focused");
  }

  // ---- the editor state is read from the editor's own context --------------
  {
    const ctx = loadCtx();
    const instance = {
      root:"/home/rithvik/Projects",
      active:F,
      group:{ editor:{
        primary:{ s:5, e:9 },
        lineOf(){ return 2; },
        lineStart(){ return 0; },
      } },
      buildContext(){
        return {
          file:{ path:F, lang:"js", body:"const a = 1;", truncated:false },
          selection:{ from:3, to:7, text:"const a" },
          // Studio joins these with newlines; the inspector must accept the real
          // shape, and survive a different one.
          symbols:"function foo :1",
          errors:"line 42: TypeError: x is not a function",
          enclosing:"The cursor is inside function foo (line 1).",
          openFiles:[{ path:F, note:"unsaved · foo" }, { path:"/home/rithvik/Projects/app.js", note:"bar" }],
        };
      },
    };
    ctx.StApp = { instance };
    const e = ctx.OSState.editor();
    eq(e.activeFile, F, "the active file comes through");
    eq(e.language, "js", "with its language");
    eq(e.cursor.line, 3, "the cursor line is resolved (0-based + 1)");
    eq(e.cursor.column, 10, "and the column");
    eq(e.selection.from, 3, "the selection starts at the reported line");
    eq(e.selection.text, "const a", "and carries its text");
    eq(e.unsaved, 1, "an unsaved tab is counted");
    ok(/TypeError/.test(e.diagnostics.join(" ")), "diagnostics survive", e.diagnostics);
    ok(/inside function foo/.test(e.enclosing), "the enclosing symbol survives");
    eq(e.root, "/home/rithvik/Projects", "and the project root");
  }

  // A single field of an unexpected type must cost only that field.
  {
    const ctx = loadCtx();
    ctx.StApp = { instance:{ active:F, buildContext(){
      return { file:{ path:F, lang:"js" }, symbols:["function foo :1"], errors:{ oops:true }, openFiles:"not-an-array" };
    } } };
    let e = null, threw = false;
    try { e = ctx.OSState.editor(); } catch (err) { threw = true; }
    eq(threw, false, "wrong-typed context fields do not throw");
    ok(e, "and the snapshot survives them");
    eq(e.activeFile, F, "still reporting the file");
    eq(e.symbols[0], "function foo :1", "an array of symbols is accepted too");
  }

  // ---- contents do not leave unless asked for -----------------------------
  // "The assistant can see the open file" must not quietly mean "the assistant
  // now has a copy of the file".
  {
    const ctx = loadCtx();
    ctx.VFS.writeFile(F, "SECRET-CONTENT-42");
    ctx.StApp = { instance:{ active:F, buildContext(){ return { file:{ path:F, lang:"txt", body:"SECRET-CONTENT-42" } }; } } };
    const snap = ctx.OSState.snapshot();
    eq(snap.editor.body, undefined, "a default snapshot carries no file contents");
    eq(JSON.stringify(snap).includes("SECRET-CONTENT-42"), false,
       "and the whole serialised snapshot does not contain the text either");
    eq(ctx.OSState.describe().includes("SECRET-CONTENT-42"), false,
       "nor does the prose form used for prompts");

    const withBody = ctx.OSState.snapshot({ body:true });
    ok(withBody.editor.body && withBody.editor.body.includes("SECRET-CONTENT-42"),
       "contents are available when explicitly requested");
    ok(ctx.OSState.describe({ body:true }).includes("SECRET-CONTENT-42"),
       "and in the prompt form as well");
  }

  // Excerpts are bounded, whatever the file size.
  {
    const ctx = loadCtx();
    const huge = "z".repeat(ctx.OSState.MAX_BODY + 5000);
    ctx.VFS.writeFile(F, huge);
    ctx.StApp = { instance:{ active:F, buildContext(){ return { file:{ path:F } }; } } };
    const snap = ctx.OSState.snapshot({ body:true });
    eq(snap.editor.body.length, ctx.OSState.MAX_BODY, "the body is capped");
    eq(snap.editor.bodyTruncated, true, "and the truncation is stated, not hidden");
  }

  // ---- system figures are never invented ------------------------------------
  {
    const ctx = loadCtx();
    ctx.SysProbe.rows = [];
    const s = ctx.OSState.system();
    eq(s.probed, false, "with no probe run, CYRUS says so");
    eq(s.metrics && Object.keys(s.metrics).length, 0, "and invents no numbers");

    ctx.SysProbe.rows = [
      { group:"Memory", label:"RAM used", value:"13.3 / 15.7 GB", provenance:"measured" },
      { group:"Storage", label:"Disk C:", value:"317.3 / 474.7 GB", provenance:"measured" },
    ];
    const s2 = ctx.OSState.system();
    eq(s2.probed, true, "after a real probe, figures are reported");
    eq(s2.metrics["RAM used"].provenance, "measured", "each figure carries its provenance");
    const text = ctx.OSState.describe();
    ok(/13\.3/.test(text), "and reach the prompt form", text);
    ok(/measured/.test(text), "with provenance attached");
  }

  // ---- every action gets the same envelope ---------------------------------
  {
    const ctx = loadCtx();
    ctx.Actions.search_files = function(){
      ctx.VFS.writeFile("/home/rithvik/Documents/found.txt", "x");
      return { ok:true, message:"Found 1 file" };
    };
    eq(ctx.ActionResult.install(), 1, "one action was decorated");

    const r = ctx.Actions.search_files({});
    ok(r.result, "the result carries an envelope");
    eq(r.result.action, "search_files", "naming the action");
    eq(r.result.status, "success", "with a status");
    eq(r.result.summary, "Found 1 file", "a summary");
    ok(r.result.changed_files.includes("/home/rithvik/Documents/found.txt"),
       "and the file it actually changed, observed rather than reported", r.result.changed_files);
    eq(r.result.undoable, true, "a change means it is undoable");
    eq(typeof r.result.ms, "number", "and it reports how long it took");
  }

  // An action that changes nothing says so, instead of implying it did.
  {
    const ctx = loadCtx();
    ctx.Actions = { noop(){ return { ok:true, message:"Nothing to do" }; } };
    ctx.ActionResult.install();
    const r = ctx.Actions.noop();
    eq(r.result.changed_files.length, 0, "no files changed");
    eq(r.result.undoable, false, "so there is nothing to undo");
    ok(r.result.warnings.length > 0, "and it warns rather than claiming success quietly", r.result.warnings);
  }

  // Failures, throws and refusals are all reported, not swallowed.
  {
    const ctx = loadCtx();
    ctx.Actions = {
      boom(){ throw new Error("kaboom"); },
      nope(){ return { ok:false, message:"Could not find it" }; },
      barred(){ return { ok:false, blocked:true, message:"Blocked by policy" }; },
    };
    ctx.ActionResult.install();
    const b = ctx.Actions.boom();
    eq(b.result.status, "error", "a thrown action is an error, not a success");
    ok(/kaboom/.test(b.result.summary), "and keeps the reason", b.result.summary);
    const n = ctx.Actions.nope();
    eq(n.result.status, "failed", "an ok:false result is 'failed'");
    const r = ctx.Actions.barred();
    eq(r.result.status, "refused", "a blocked result is 'refused'");
    ok(r.result.warnings.includes("blocked by policy"), "and says the policy blocked it", r.result.warnings);
  }

  // Deletions and creations are both detected.
  {
    const ctx = loadCtx();
    ctx.Actions = {
      del(){ ctx.VFS.remove(F); return { ok:true, message:"Deleted" }; },
      create(){ ctx.VFS.mkdirp("/home/rithvik/Documents/made"); return { ok:true, message:"Created" }; },
    };
    ctx.ActionResult.install();
    const d = ctx.Actions.del();
    ok(d.result.removed.includes(F), "a deletion is detected", d.result.removed);
    ok(d.result.changed_files.includes(F), "and is a change");
    const c = ctx.Actions.create();
    ok(c.result.added.includes("/home/rithvik/Documents/made"),
       "a *folder* creation is detected too — a files-only fingerprint would miss it", c.result.added);
  }

  // Most real actions are async. Spreading a Promise yields an empty object, so
  // an async action must still get a real envelope — with its own resolved
  // message and the files it actually changed while it was pending.
  {
    const ctx = loadCtx();
    ctx.Actions = {
      async asyncWrite(f){
        ctx.VFS.writeFile("/home/rithvik/Documents/async.txt", "done");
        return { ok:true, message:"Wrote async.txt" };
      },
      async asyncFails(){ throw new Error("async boom"); },
    };
    ctx.ActionResult.install();
    const r = await ctx.Actions.asyncWrite({});
    ok(r.result, "an async action carries an envelope");
    eq(r.message, "Wrote async.txt", "and keeps its own resolved message");
    eq(r.result.status, "success", "with the right status");
    eq(r.result.summary, "Wrote async.txt", "and a real summary");
    ok(r.result.changed_files.includes("/home/rithvik/Documents/async.txt"),
       "including changes made while it was pending", r.result.changed_files);
    eq(r.result.undoable, true, "so it is undoable");

    const bad = await ctx.Actions.asyncFails();
    eq(bad.result.status, "error", "an async throw is an error");
    ok(/async boom/.test(bad.result.summary), "with the reason preserved", bad.result.summary);
  }

  // An action that is replaced *after* ready must still end up enveloped.
  // fireReady() now awaits each callback in registration order, so a phase that
  // restores from IndexedDB and only then swaps in an async implementation has
  // finished before the next phase's installer runs. This asserts the
  // reinstall path still works for anything replaced outside that ordering.
  {
    const ctx = loadCtx();
    ctx.Actions = { early(){ return { ok:true, message:"early" }; } };
    ctx.ActionResult.install();
    eq(!!(ctx.Actions.early && ctx.Actions.early.__enveloped), true, "the early action is enveloped");

    // Simulate a late async replacement.
    ctx.Actions.late = async function(){ return { ok:true, message:"late" }; };
    eq(ctx.Actions.late.__enveloped, undefined, "a newly swapped-in action starts bare");
    ctx.ActionResult.install();
    eq(!!ctx.Actions.late.__enveloped, true, "a second pass catches it");
    const r = await ctx.Actions.late();
    eq(r.result.action, "late", "and it reports properly");
    eq(r.result.status, "success", "with the right status");
  }

  // Wrapping twice must not double-wrap.
  {
    const ctx = loadCtx();
    ctx.Actions = { x(){ return { ok:true, message:"m" }; } };
    ctx.ActionResult.install();
    const first = ctx.Actions.x;
    ctx.ActionResult.install();
    eq(ctx.Actions.x, first, "install() is idempotent");
    const r = ctx.Actions.x();
    eq(r.result.action, "x", "and the envelope is still correct");
  }

  // Outcomes that never reached an action get the same shape.
  {
    const ctx = loadCtx();
    const refused = ctx.ActionResult.normalize("delete_file", { ok:false, blocked:true, message:"Blocked" });
    eq(refused.result.status, "refused", "a blocked intent normalises to the same envelope");
    eq(refused.result.changed_files.length, 0, "with nothing changed");
    const done = ctx.ActionResult.normalize("open_app", { ok:true, message:"Opened" });
    eq(done.result.status, "success", "and so does a plain success");
    eq(done.result.action, "open_app", "naming what ran");
  }

  // ---- the prompt block a consumer can actually send -----------------------
  {
    const ctx = loadCtx();
    const t = ctx.OSState.describe();
    ok(/FOCUS:/.test(t), "the prompt form always states what has focus");
    ok(/SYSTEM:/.test(t), "and is honest about missing system figures");
  }

  process.exit(report("os state + action result tests"));
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });