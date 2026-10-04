// ============================================================================
//  CYRUS OS — phase 18 — one place that knows what the user is doing
//
//  The problem this solves
//  ---------------------
//  Studio's buildContext() already reported the active file, the selection with
//  line numbers, symbols, diagnostics, the enclosing symbol and unsaved tabs.
//  None of it was reachable. The only caller was Studio's own copilot, from
//  inside Studio's own closures. So the OS had a detailed picture of what the
//  user was doing and no way to answer "what am I looking at?" from anywhere
//  else — CYRUS Chat, the palette and the native bridge all saw a blank room.
//
//  That is the difference between an AI living inside an OS and an OS that
//  understands its user. It is not a new feature list; it is one shared surface.
//
//  Design rules, in priority order
//  ------------------------------
//  1. Read-only and total. A snapshot must never throw, never mutate, and never
//     block. An inspector that can crash the thing it inspects is useless
//     exactly when it matters.
//  2. Metadata by default, contents on request. snapshot() returns paths, line
//     numbers and flags. File bodies leave the machine only through
//     describe({body:...}) or the context block, which the caller must ask for.
//     "The assistant can see the open file" should never quietly mean "the
//     assistant now has a copy of the file".
//  3. Never invent a measurement. System figures are reported only from rows a
//     real probe produced, carrying their provenance. If nothing has been
//     probed, the field is null and says so — the rule phase 11 already follows.
//  4. Bounded. Every field is capped. A snapshot is context, and context that
//     grows without limit becomes a way to accidentally ship a whole disk to a
//     model.
// ============================================================================

const OSState = {
  MAX_BODY:8000,
  MAX_SELECTION:4000,
  MAX_TABS:12,
  MAX_DIAGNOSTICS:20,

  // Focused window. WM.focus() already marks the DOM but kept no reference, so
  // "what has focus" was only answerable by scraping CSS classes.
  _win:null,

  trackFocus(){
    if(typeof WM === "undefined" || !WM.focus || WM.focus.__osstate) return false;
    const orig = WM.focus.bind(WM);
    const wrapped = function(win){
      OSState._win = win || null;
      return orig(win);
    };
    wrapped.__osstate = true;
    WM.focus = wrapped;
    return true;
  },

  // Recompute from the DOM rather than trusting _win alone: a window can be
  // closed without focus() being called, and a stale id is worse than null.
  focused(){
    try{
      if(typeof WM === "undefined" || !WM.wins) return null;
      const wins = [...WM.wins.values()];
      const marked = wins.filter(w => w && w.el && w.el.classList.contains("focused"));
      const win = marked[marked.length - 1] || OSState._win || null;
      if(win && WM.wins.has(win.id)) return win;
      return null;
    }catch(e){ return null; }
  },

  // One field with an unexpected type must not cost the whole snapshot.
  // Studio joins these with newlines, but if that ever becomes an array (or vice
  // versa) the honest result is that field being missing — not every other field
  // disappearing behind a single TypeError caught two frames up.
  _lines(v){
    if(v == null) return [];
    if(Array.isArray(v)) return v.map(x => String(x)).filter(Boolean);
    return String(v).split("\n").map(s => s.trim()).filter(Boolean);
  },

  // ---- editor ---------------------------------------------------------------
  // Reads the *live* editor through its own buildContext(), so there is one
  // implementation of "what is open" rather than two that drift apart.
  editor(){
    try{
      const inst = (typeof StApp !== "undefined" && StApp && StApp.instance) || null;
      if(!inst || typeof inst.buildContext !== "function") return null;
      const c = inst.buildContext() || {};
      const tabs = Array.isArray(c.openFiles) ? c.openFiles : [];
      const out = {
        root: inst.root || null,
        activeFile: c.file ? c.file.path : (inst.active || null),
        language: c.file ? c.file.lang : null,
        cursor: null,
        selection: null,
        enclosing: c.enclosing || null,
        symbols: this._lines(c.symbols).slice(0, 40),
        diagnostics: this._lines(c.errors).slice(0, this.MAX_DIAGNOSTICS),
        tabs: tabs.slice(0, this.MAX_TABS),
        unsaved: tabs.filter(t => /^unsaved/.test(String((t && t.note) || ""))).length,
      };
      // Cursor position. Studio reports selection lines; when there is no
      // selection the caret still matters ("what's on line 42").
      try{
        const ed = inst.group && inst.group.editor;
        const prim = ed && ed.primary;
        if(prim){
          const line = ed.lineOf(prim.e);
          out.cursor = {
            line: line + 1,
            column: prim.e - ed.lineStart(line) + 1,
            offset: prim.e,
          };
        }
      }catch(e){}
      if(c.selection){
        out.selection = {
          from: c.selection.from,
          to: c.selection.to,
          lines: Math.max(0, (c.selection.to || 0) - (c.selection.from || 0)),
          text: String(c.selection.text || "").slice(0, this.MAX_SELECTION),
        };
      }
      return out;
    }catch(e){ return null; }
  },

  // ---- system ---------------------------------------------------------------
  // Cached rows only. SysProbe.all() reaches for the network, the battery and
  // the device list; doing that to answer "is this machine busy" would be
  // absurd. If the System app has not run, there is nothing to report and the
  // answer is null.
  system(){
    try{
      const rows = (typeof SysProbe !== "undefined" && SysProbe && SysProbe.rows) || [];
      if(!rows.length) return { probed:false, note:"No probe has run yet — open the System app for real figures.", metrics:{} };
      const metrics = {};
      for(const r of rows.slice(0, 40)){
        if(!r || !r.label) continue;
        // provenance travels with every number, exactly as phase 11 promised
        metrics[String(r.label)] = { value:r.value, provenance:r.provenance || "unknown", group:r.group || "" };
      }
      return { probed:true, metrics };
    }catch(e){ return { probed:false, note:"System probe unavailable.", metrics:{} }; }
  },

  // ---- the snapshot ---------------------------------------------------------
  snapshot(opts){
    opts = opts || {};
    const win = this.focused();
    const snap = {
      ts: Date.now(),
      focus: null,
      windows: [],
      editor: null,
      system: opts.system === false ? null : this.system(),
      notes: (Store.data && Store.data.notes && Object.keys(Store.data.notes).length) || 0,
      mounts: (typeof Mnt !== "undefined" && Mnt.list) ? Mnt.list().length : 0,
    };
    try{
      if(typeof WM !== "undefined" && WM.wins){
        snap.windows = [...WM.wins.values()].slice(0, this.MAX_TABS).map(w => ({
          id:w.id, title:w.title || "", focused: !!(w.el && w.el.classList.contains("focused")),
        }));
      }
    }catch(e){}
    if(win) snap.focus = { id:win.id, title:win.title || "" };
    snap.editor = this.editor();
    // Contents only when explicitly requested, and always truncated.
    if(opts.body && snap.editor && snap.editor.activeFile){
      try{
        const text = VFS.readFile(snap.editor.activeFile);
        snap.editor.body = String(text == null ? "" : text).slice(0, this.MAX_BODY);
        snap.editor.bodyTruncated = !!(text && String(text).length > this.MAX_BODY);
      }catch(e){ snap.editor.body = null; }
    }
    return snap;
  },

  // ---- prose, for a model or a tooltip --------------------------------------
  describe(opts){
    opts = opts || {};
    const s = this.snapshot(opts);
    const L = [];
    L.push("FOCUS: " + (s.focus ? s.focus.title + " (" + s.focus.id + ")" : "nothing focused"));
    if(s.editor && s.editor.activeFile){
      const e = s.editor;
      L.push("OPEN FILE: " + e.activeFile + (e.language ? " [" + e.language + "]" : ""));
      if(e.cursor) L.push("CURSOR: line " + e.cursor.line + ", column " + e.cursor.column);
      if(e.selection) L.push("SELECTION: lines " + e.selection.from + "-" + e.selection.to +
        " (" + e.selection.lines + " line(s))\n" + e.selection.text);
      if(e.unsaved) L.push("UNSAVED: " + e.unsaved + " tab(s)");
      if(e.enclosing) L.push(e.enclosing);
      if(e.diagnostics.length) L.push("DIAGNOSTICS:\n" + e.diagnostics.join("\n"));
    } else if(s.editor){
      L.push("EDITOR OPEN: no file active");
    }
    if(s.mounts) L.push("MOUNTS: " + s.mounts);
    if(s.system && s.system.probed){
      const top = Object.entries(s.system.metrics).slice(0, 10)
        .map(([k, v]) => k + "=" + v.value + " (" + v.provenance + ")");
      L.push("SYSTEM (last probe): " + top.join(", "));
    } else if(s.system){
      L.push("SYSTEM: " + s.system.note);
    }
    if(opts.body && s.editor && s.editor.body != null){
      L.push("FILE CONTENTS" + (s.editor.bodyTruncated ? " (truncated)" : "") + ":\n" + s.editor.body);
    }
    return L.join("\n");
  },
};

// ============================================================================
//  ActionResult — one shape for every action's outcome
//
//  Today an action returns whatever it feels like: {ok,message}, sometimes
//  extra keys, sometimes a refusal marker. Consumers then guess. This wraps the
//  Actions table so *every* intent reports the same envelope, and so the files
//  it touched are known by observation rather than by each action remembering
//  to say so.
// ============================================================================
const ActionResult = {
  _wrap:null,

  // A cheap fingerprint of the filesystem: path -> type+size+mtime. Diffing it
  // before and after is how "changed_files" is populated for every action at
  // once, instead of each action having to volunteer the information.
  //
  // Directories are included. An action that creates a folder changes nothing
  // measurable about any *file*, so a files-only fingerprint would report
  // "no files changed" for "created a new folder" — which is exactly the kind of
  // false negative this exists to prevent.
  //
  // The traversal is written out rather than using VFS.walk(), because walk()
  // visits files only. That was found by reading it, after a test caught the
  // resulting false negative.
  fingerprint(){
    const m = new Map();
    const seen = new Set();
    const rec = p => {
      const n = VFS.node(p);
      if(!n || seen.has(p)) return;
      seen.add(p);
      m.set(p, n.type + ":" + (n.size || 0) + ":" + (n.mtime || 0));
      if(n.type === "dir" && n.children){
        for(const name of Object.keys(n.children)) rec((p === "/" ? "" : p) + "/" + name);
      }
    };
    try{ rec("/"); }catch(e){}
    return m;
  },

  diff(before, after){
    const added = [], removed = [], modified = [];
    try{
      for(const [p, sig] of after){
        if(!before.has(p)) added.push(p);
        else if(before.get(p) !== sig) modified.push(p);
      }
      for(const p of before.keys()) if(!after.has(p)) removed.push(p);
    }catch(e){}
    return { added, removed, modified };
  },

  // Decorate one action. Idempotent, so wrapping twice is a no-op.
  //
  // Actions may be synchronous or async, and most of them are async. Spreading
  // a Promise yields an empty object, so an async action would silently return
  // an envelope with no message and no status — the wrapper has to await first
  // and only then measure and describe. (Found by a regression in test_system,
  // whose system_report is async.)
  decorate(name, fn){
    const wrapped = function(){
      const t0 = Date.now();
      const before = ActionResult.fingerprint();

      const finish = (r, error) => {
        const d = ActionResult.diff(before, ActionResult.fingerprint());
        const changed = [...d.added, ...d.modified, ...d.removed];
        const ok = !error && !!(r && r.ok !== false);
        const status = error ? "error" : (r && r.blocked) ? "refused" : ok ? "success" : "failed";
        const out = (r && typeof r === "object") ? { ...r } : { ok, message:String(r == null ? "" : r) };
        out.result = {
          action: name,
          status,
          ok,
          summary: String(out.message || "").slice(0, 300),
          changed_files: changed.slice(0, 50),
          added: d.added.slice(0, 50),
          removed: d.removed.slice(0, 50),
          warnings: out.blocked ? ["blocked by policy"] : changed.length ? [] : ["no files changed"],
          undoable: changed.length > 0,
          ms: Date.now() - t0,
        };
        return out;
      };

      const fail = e => finish({ ok:false, message:"Action failed: " + (e && e.message || e) }, e);

      let r;
      try{ r = fn.apply(this, arguments); }
      catch(e){ return fail(e); }
      if(r && typeof r.then === "function"){
        return r.then(v => finish(v, null), e => fail(e));
      }
      return finish(r, null);
    };
    wrapped.__enveloped = true;
    return wrapped;
  },

  install(){
    if(typeof Actions === "undefined" || !Actions) return false;
    let n = 0;
    for(const k of Object.keys(Actions)){
      if(typeof Actions[k] === "function" && !Actions[k].__enveloped){
        Actions[k] = this.decorate(k, Actions[k]);
        n++;
      }
    }
    return n;
  },

  // For outcomes that never reached an action — a blocked intent, a declined
  // confirmation. Same envelope, so a consumer never has to branch on shape.
  normalize(action, r){
    const out = (r && typeof r === "object") ? { ...r } : { ok:false, message:String(r == null ? "" : r) };
    if(out.result) return out;
    out.result = {
      action,
      status: r && r.blocked ? "refused" : out.ok ? "success" : "failed",
      ok: !!out.ok,
      summary: String(out.message || "").slice(0, 300),
      changed_files: [], added: [], removed: [],
      warnings: r && r.blocked ? ["blocked by policy"] : [],
      undoable: false,
      ms: 0,
    };
    return out;
  },
};

// ---- wire in ----------------------------------------------------------------
if(typeof WM !== "undefined") OSState.trackFocus();

// Actions is declared below the splice point, so the wrapper waits for ready.
if(typeof Cyrus !== "undefined" && Cyrus.onReady){
  Cyrus.onReady(()=>{
    const n = ActionResult.install();
    // Recorded, not announced: knowing the envelope is installed is a property
    // of the build, and belongs in the audit trail rather than in a toast.
    Cyrus.audit("action results", "result_envelope_installed", { actions:n },
                "low", true, true,
                n ? ("Actions now return a uniform result envelope (" + n + " actions).")
                  : "Result envelope already installed.");
  });
}