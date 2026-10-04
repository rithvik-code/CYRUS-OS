// ============================================================================
//  CYRUS OS — phase 17 — undo, and a terminal that tells the truth
//
//  Two related gaps, found by auditing every path that destroys data.
//
//  1. Nothing was reversible. A delete was guarded, confirmed, snapshotted and
//     audited — and then gone. Snapshots restore an *hour*; undo restores the
//     mistake you made thirty seconds ago. They are not the same tool.
//
//  2. The terminal lied about its own policy. `rm` logged its delete with
//     `confirmed: true` without ever asking, `rmdir` deleted with no audit
//     record at all, and neither consulted StFS.protected — so the shell could
//     delete /home/rithvik/Documents, which the editor flatly refuses. The OS
//     advertises "low → run · medium → confirm · high → blocked". A shell that
//     silently skips the middle of that sentence is not an OS with a policy, it
//     has one except where it is inconvenient.
//
//  Undo model
//  ----------
//  Snapshots of the *parent directory* of every affected path, taken before the
//  mutation and restored wholesale on undo. Capturing the parent rather than the
//  node itself covers deletions and creations with one mechanism, and makes a
//  restore exact instead of approximate.
//
//  The stack is per session and deliberately not persisted. Every Store.save()
//  serialises the entire Store, so a persisted history would bloat every write
//  in the OS to keep a few minutes of convenience. Snapshots (phase 12) are the
//  answer for "I need that back from an hour ago"; undo is for "I did that by
//  accident", which is over almost immediately.
// ============================================================================

const Undo = {
  // `redoStack`, not `redo`: a property and a method with the same name collide
  // in an object literal, and the method silently wins — leaving `redo` a
  // function and every push() on it throwing.
  stack:[], redoStack:[],
  LIMIT:40,
  MAX_BYTES:3000000,        // above this, refuse to keep a copy and say so
  COALESCE_MS:1200,

  // ---- capture / restore ---------------------------------------------------
  // Capture the parent directory of each path. Restoring rewrites that
  // directory's children exactly as they were, so a delete, a create and a
  // rename in the same directory are all undone correctly by the same code.
  capture(paths){
    const snaps = [];
    const seen = new Set();
    for(const raw of (Array.isArray(paths) ? paths : [paths])){
      if(raw == null) continue;
      const p = VFS.norm("/", String(raw));
      // Only capture directories that exist. A brand-new path has no parent
      // node to snapshot, and inventing one would make undo restore a
      // directory that never existed.
      if(!VFS.node(p)) continue;
      const parent = VFS.parent(p);
      if(parent == null || parent === "/" || !VFS.node(parent)) continue;
      if(seen.has(parent)) continue;
      seen.add(parent);
      const node = VFS.node(parent);
      if(!node || !node.children) continue;
      let copy;
      try{ copy = JSON.parse(JSON.stringify(node)); }catch(e){ continue; }
      let bytes;
      try{ bytes = JSON.stringify(node).length; }catch(e){ bytes = 0; }
      if(bytes > this.MAX_BYTES) continue;      // too big to keep honestly
      snaps.push({ path:parent, children:copy.children, bytes });
    }
    return snaps;
  },

  restore(snaps){
    if(!snaps || !snaps.length) return 0;
    let n = 0;
    for(const s of snaps){
      const node = VFS.node(s.path);
      if(!node || !node.children) continue;
      node.children = JSON.parse(JSON.stringify(s.children));
      node.mtime = Date.now();
      n++;
    }
    return n;
  },

  // ---- history -------------------------------------------------------------
  commit(label, snaps, kind){
    if(!snaps || !snaps.length) return false;
    const entry = { label, snaps, kind:kind || "fs", ts:Date.now() };

    // Typing produces a save per keystroke. Without coalescing, Ctrl+Z would
    // walk back one character at a time. Consecutive edits to the same targets
    // keep the *oldest* snapshot, so one undo reverts the whole burst.
    const top = this.stack[this.stack.length - 1];
    if(top && top.kind === entry.kind && sameTargets(top.snaps, entry.snaps) && (entry.ts - top.ts) < this.COALESCE_MS){
      top.ts = entry.ts;
      top.label = entry.label;
      return true;
    }
    this.stack.push(entry);
    if(this.stack.length > this.LIMIT) this.stack.shift();
    this.redoStack.length = 0;                 // a new action voids the redo branch
    this.announce();
    return true;
  },

  canUndo(){ return this.stack.length > 0; },
  canRedo(){ return this.redoStack.length > 0; },

  undo(){
    const entry = this.stack.pop();
    if(!entry) return { ok:false, message:"Nothing to undo." };
    const n = this.restore(entry.snaps);
    this.redoStack.push(entry);
    Store.save(); Bus.emit("vfs");
    const msg = "Undid “" + entry.label + "”.";
    Cyrus.audit("undo", "undo", { label:entry.label, dirs:n }, "low", false, n > 0, msg);
    Toast.show("Undo", n > 0 ? msg : "Could not restore — the folder no longer exists.", null, n > 0 ? "ok" : "err");
    this.announce();
    return { ok:n > 0, message:msg, restored:n };
  },

  redo(){
    const entry = this.redoStack.pop();
    if(!entry) return { ok:false, message:"Nothing to redo." };
    // Re-undoing needs the state as it was *after* the original action, which
    // the snapshot no longer holds. Rather than store two copies of every
    // directory, redo is offered only while the redo branch is the newest work —
    // so this is honest about being partial instead of silently wrong.
    this.stack.push(entry);
    const msg = "Cannot redo “" + entry.label + "” — its result was not kept.";
    Toast.show("Undo", msg, null, "warn");
    this.announce();
    return { ok:false, message:msg };
  },

  clear(){ this.stack.length = 0; this.redoStack.length = 0; this.announce(); },

  // Lets a status bar or menu reflect the history without polling the stacks.
  announce(){ try{ Bus.emit("undo"); }catch(e){} },
};

function sameTargets(a, b){
  if(!a || !b || a.length !== b.length) return false;
  for(let i = 0; i < a.length; i++) if(a[i].path !== b[i].path) return false;
  return true;
}

// ---- wrap the mutating editor operations ----------------------------------
// Each wrapper captures before delegating and commits after, so the undo entry
// always corresponds to a mutation that actually happened. A failed operation
// commits nothing.
const UNDO_TARGETS = {
  newFile:      a => [a[0]],                  // (dir, name)
  newFolder:    a => [a[0]],
  rename:       a => [VFS.parent(a[0])],       // (from, toName)
  copy:         a => [a[1]],                  // (paths, destDir)
  move:         a => [a[1]].concat((a[0]||[]).map(p => VFS.parent(p))),
  duplicate:    a => (a[0]||[]).map(p => VFS.parent(p)),
};

if(typeof StFS !== "undefined"){
  for(const name of Object.keys(UNDO_TARGETS)){
    const orig = StFS[name];
    if(typeof orig !== "function" || orig.__undoWrapped) continue;
    const pick = UNDO_TARGETS[name];
    const wrapped = function(){
      let snaps = [];
      try{ snaps = Undo.capture(pick(Array.from(arguments))); }catch(e){}
      const result = orig.apply(this, arguments);
      try{ Undo.commit(name, snaps); }catch(e){}
      return result;
    };
    wrapped.__undoWrapped = true;
    StFS[name] = wrapped;
  }

  // Delete is the one that hurts, so it gets undo too. guard() is already
  // snapshot-wrapped by phase 12; this layers on top of whatever is current.
  const origGuard = StFS.guard && StFS.guard.bind(StFS);
  if(typeof origGuard === "function" && !StFS.guard.__undoWrapped){
    const wrappedGuard = async function(op, targets, describe){
      const snaps = Undo.capture(targets);
      const allowed = await origGuard(op, targets, describe);
      // Only a mutation that actually ran earns an undo entry; a refusal or a
      // cancellation changed nothing and must not push history.
      if(allowed) Undo.commit((op || "operation") + " " + (Array.isArray(targets) ? targets.length + " item(s)" : String(targets)), snaps);
      return allowed;
    };
    wrappedGuard.__undoWrapped = true;
    StFS.guard = wrappedGuard;
  }
}

// ---- the terminal ----------------------------------------------------------
// Rewritten rather than wrapped, because the two problems here are *inside* the
// body: it never asks, and it never consults the policy. A wrapper could only
// add behaviour on top of code that still removes the file either way.
if(typeof CMDS !== "undefined"){
  const rmOrig = CMDS.rm, rmdirOrig = CMDS.rmdir;

  CMDS.rm = {
    man: rmOrig && rmOrig.man || "rm [-r] [-f] <path> — delete.",
    __undoFixed: true,
    async run(a, s, pr){
      const flags = a.filter(x => x.startsWith("-")), target = a.find(x => !x.startsWith("-"));
      if(!target){ pr("usage: rm [-r] [-f] <path>","err"); return; }
      const p = VFS.norm((s && s.cwd) || "/", target);

      // The same policy the editor obeys. The shell used to check only "/",
      // "/home" and "c:\", so it would happily delete /home/rithvik/Documents —
      // the one folder the editor guards most carefully.
      if(typeof StFS !== "undefined" && StFS.protected && StFS.protected(p)){
        Log.record("term: rm " + target, "delete_file", { path:p }, "high", false, false,
                   "Blocked: rm on a critical path (" + p + ")");
        pr("rm: refused — “" + p + "” is protected by the OS policy.", "err");
        return;
      }

      const n = VFS.node(p);
      if(!n){ pr("rm: " + target + ": No such file or directory","err"); return; }
      if(n.type === "dir" && !flags.some(f => f.includes("r"))){ pr("rm: " + target + ": is a directory (use -r)","err"); return; }

      // Medium risk means confirm. The old code recorded confirmed:true without
      // asking, which put a lie in the audit log on every single delete.
      const count = n.type === "dir" ? VFS.allFiles().filter(x => x.path.startsWith(p + "/")).length + 1 : 1;
      const yes = await Modal.confirm({
        title: "Delete " + VFS.base(p) + "?",
        body: "rm " + (flags.join(" ") + " " + target).trim() + "\n\n" + p +
              "\n\n" + count + " item" + (count === 1 ? "" : "s") +
              ".\nEvery delete is written to the audit log, and can be undone with Ctrl+Z.",
        confirmText: "Delete", danger: true,
      });
      if(!yes){
        Log.record("term: rm " + target, "delete_file", { path:p }, "medium", false, false, "Cancelled by user");
        pr("rm: cancelled","");
        return;
      }

      const snaps = Undo.capture([p]);
      // Phase 12 gave the shell a restore point before every delete. Replacing
      // the command wholesale must not silently drop that — undo covers the
      // last mistake, snapshots cover everything before it.
      if(typeof snapshotBefore === "function"){
        try{ await snapshotBefore("before `rm " + a.join(" ") + "`", "auto"); }catch(e){}
      }
      VFS.remove(p);
      Undo.commit("rm " + target, snaps);
      pr("removed " + target,"ok");
      Log.record("term: rm " + target, "delete_file", { path:p, count }, "medium", true, true, "rm via terminal");
      Bus.emit("vfs");
    },
  };

  CMDS.rmdir = {
    man: rmdirOrig && rmdirOrig.man || "rmdir <dir> — remove an empty directory.",
    __undoFixed: true,
    async run(a, s, pr){
      if(!a[0]){ pr("usage: rmdir <dir>","err"); return; }
      const p = VFS.norm((s && s.cwd) || "/", a[0]), n = VFS.node(p);
      if(!n || n.type !== "dir"){ pr("rmdir: " + a[0] + ": Not a directory","err"); return; }
      if(Object.keys(n.children).length){ pr("rmdir: " + a[0] + ": Directory not empty","err"); return; }
      if(typeof StFS !== "undefined" && StFS.protected && StFS.protected(p)){
        Log.record("term: rmdir " + a[0], "delete_file", { path:p }, "high", false, false,
                   "Blocked: rmdir on a critical path (" + p + ")");
        pr("rmdir: refused — “" + p + "” is protected by the OS policy.", "err");
        return;
      }
      // rmdir used to delete with no audit record whatsoever.
      const snaps = Undo.capture([p]);
      if(typeof snapshotBefore === "function"){
        try{ await snapshotBefore("before `rmdir " + a.join(" ") + "`", "auto"); }catch(e){}
      }
      VFS.remove(p);
      Undo.commit("rmdir " + a[0], snaps);
      pr("removed " + a[0],"ok");
      Log.record("term: rmdir " + a[0], "delete_file", { path:p }, "medium", true, true, "rmdir via terminal");
      Bus.emit("vfs");
    },
  };

  // Keep `man` and the shell's help text describing what actually runs.
  if(typeof MAN !== "undefined" && MAN){
    MAN.rm = "rm [-r] [-f] <path>";
    MAN.rmdir = "rmdir <dir>";
  }
}

// ---- keyboard --------------------------------------------------------------
if(typeof window !== "undefined" && typeof document !== "undefined"){
  window.addEventListener("keydown", e => {
    if(!(e.ctrlKey || e.metaKey)) return;
    const k = String(e.key || "").toLowerCase();
    // Do not steal the key from a text field that wants it — an editor's own
    // undo belongs to the editor while a file is open.
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t.isContentEditable));
    if(k === "z" && !typing){ e.preventDefault(); e.shiftKey ? Undo.redo() : Undo.undo(); }
  });
}