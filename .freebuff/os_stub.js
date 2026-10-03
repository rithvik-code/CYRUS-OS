// Shared stubs for the OS-phase chunk tests.
//
// The Studio tests (test_conn.js, test_fixes.js) already established the
// pattern this file follows: load a chunk into a `vm` context with faked OS
// globals and prove the claims the UI makes are the claims the code earns.
//
// Two deliberate choices:
//
//  * setTimeout is captured, not run. os_p10 fires `Cyrus.fireReady()` from a
//    timer, and several phases patch objects that only exist after the whole
//    script has parsed. Letting the timer fire for real would make the tests
//    depend on event-loop timing. Tests call `Cyrus.fireReady()` explicitly.
//
//  * The stubs are the *minimum real* shapes — VFS.node returns a genuine tree
//    node, VFS.walk actually walks, CMDS is a plain object the chunk writes
//    into. A test that passes against a fake VFS but not a real one would be
//    worthless, so nothing is stubbed more loosely than the OS actually uses it.
const fs = require("fs");
const vm = require("vm");
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name + (detail ? NL + "      " + String(detail).split(NL).join(NL + "      ") : ""));
  return false;
}
function eq(got, want, name) {
  return ok(got === want, name,
    got === want ? "" : "expected: " + JSON.stringify(want) + NL + "got:      " + JSON.stringify(got));
}
function report(name) {
  console.log(NL + name + ": " + pass + " passed, " + fail + " failed");
  if (failures.length) {
    console.log(NL + "FAILURES:");
    for (const f of failures) console.log("  - " + f);
  }
  return fail ? 1 : 0;
}

// ---- a real-shaped virtual filesystem, small enough to reason about ----------
function mkFile(name, content) {
  return { type: "file", name, ext: (name.split(".").pop() || "").toLowerCase(),
           content: content || "", size: (content || "").length, mtime: 1700000000000 };
}
function mkDir(name, children) { return { type: "dir", name, children: children || {}, mtime: 1700000000000 }; }

function seedTree() {
  return mkDir("/", { home: mkDir("home", { rithvik: mkDir("rithvik", {
    Documents: mkDir("Documents", { "notes.txt": mkFile("notes.txt", "hello cyrus") }),
    Projects: mkDir("Projects", { "app.js": mkFile("app.js", "console.log(1)") }),
  }) }) });
}

// A faithful-enough VFS: same method names, same signatures, same return shapes.
function makeVFS() {
  const VFS = {
    root: null,
    norm(base, p) {
      if (p == null || p === "") return base;
      if (p === "~") p = "/home/rithvik";
      if (p.startsWith("~/")) p = "/home/rithvik/" + p.slice(2);
      const parts = p.startsWith("/") ? p.split("/") : (base + "/" + p).split("/");
      const st = [];
      for (const seg of parts) { if (!seg || seg === ".") continue; if (seg === "..") st.pop(); else st.push(seg); }
      return "/" + st.join("/");
    },
    node(path) {
      if (path === "/" || path === "") return this.root;
      let cur = this.root;
      for (const seg of String(path).split("/").filter(Boolean)) {
        if (!cur || cur.type !== "dir") return null;
        cur = cur.children[seg];
      }
      return cur || null;
    },
    parent(path) { const i = String(path).lastIndexOf("/"); return i <= 0 ? "/" : String(path).slice(0, i); },
    base(path) { return String(path).split("/").filter(Boolean).pop() || "/"; },
    mkdirp(path) {
      let cur = this.root;
      for (const seg of String(path).split("/").filter(Boolean)) {
        if (!cur.children[seg]) cur.children[seg] = mkDir(seg, {});
        cur = cur.children[seg];
        if (cur.type !== "dir") return null;
      }
      return cur;
    },
    writeFile(path, content) {
      const dir = this.node(this.parent(path));
      if (!dir || dir.type !== "dir") return false;
      const name = this.base(path);
      if (dir.children[name] && dir.children[name].type === "dir") return false;
      dir.children[name] = mkFile(name, content);
      return true;
    },
    remove(path) {
      const n = this.node(path);
      const dir = this.node(this.parent(path));
      if (!n || !dir || dir.type !== "dir") return false;
      delete dir.children[this.base(path)];
      return true;
    },
    move(src, dstDirPath) {
      const n = this.node(src);
      const d = this.node(dstDirPath);
      if (!n || !d || d.type !== "dir") return false;
      d.children[this.base(src)] = n;
      return this.remove(src);
    },
    detach(path) { return this.node(path); },
    attach() { return true; },
    walk(path, fn) {
      const start = this.node(path);
      if (!start) return;
      if (start.type === "file") { fn(path, start); return; }
      const rec = (p, node) => {
        if (node.type === "file") { fn(p, node); return; }
        for (const c of Object.values(node.children || {})) rec(p === "/" ? "/" + c.name : p + "/" + c.name, c);
      };
      rec(path, start);
    },
    allFiles() { const out = []; this.walk("/", (p, n) => { if (n.type === "file") out.push({ path: p, node: n }); }); return out; },
    sizeOf(path) {
      const n = this.node(path);
      if (!n) return 0;
      if (n.type === "file") return n.size || 0;
      let t = 0; this.walk(path, (p, f) => t += f.size || 0); return t;
    },
  };
  VFS.root = seedTree();
  return VFS;
}

function makeCtx(opts) {
  opts = opts || {};
  const timers = [];
  const VFS = makeVFS();
  const Store = {
    data: { vfs: VFS.root, log: [], settings: { accent: "#d4a53f" }, notes: {} },
    saves: 0,
    save() { Store.saves++; },
    reset() {},
  };
  const store = {};
  const local = {};
  const session = {};

  const ctx = {
    console,
    JSON, Math, Date, Object, Array, String, Number, Boolean, Error, Promise, Set, Map,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    btoa: s => Buffer.from(s, "binary").toString("base64"),
    atob: s => Buffer.from(s, "base64").toString("binary"),
    TextEncoder, TextDecoder,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    // ---- OS globals ----
    esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    sleep: () => Promise.resolve(),
    fmtSize: kb => kb >= 1048576 ? (kb / 1048576).toFixed(1) + " GB"
              : kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB",
    VFS, Store,
    Bus: { m: {}, on() {}, emit() {} },
    Log: { record() { ctx.__log.push(Array.prototype.slice.call(arguments)); }, recent: () => [], all: () => [], clear() {} },
    Toast: { show() {}, error() {} },
    Modal: { confirm: () => Promise.resolve(true), info() {} },
    Apps: { reg: new Map(), register(id, d) { ctx.__apps[id] = d; }, open() {} },
    WM: { open: () => ({}), close() {} },
    CMDS: {
      // The real cyrus-sh defines these in cyrus-os.html, which is not loaded
      // here. The snapshot phase wraps `rm`/`rmdir`, so the stub needs genuine
      // commands of the right shape or the wrapping is never exercised.
      rm: {
        man: "rm [-r] [-f] <path> — delete.",
        run(a, s, pr) { VFS.remove(VFS.norm((s && s.cwd) || "/", a[0] || "")); },
      },
      rmdir: {
        man: "rmdir <dir> — remove an empty directory.",
        run(a, s, pr) { VFS.remove(VFS.norm((s && s.cwd) || "/", a[0] || "")); },
      },
    },
    MAN: { rm: "rm <path>", rmdir: "rmdir <dir>" },
    StFS: {
      risk(op) { return op === "delete" ? "medium" : "low"; },
      CRITICAL: [], SYSTEM: [],
      protected() { return false; },
      guard: async function (op, targets, describe) { ctx.__guards.push({ op, targets, describe }); return true; },
    },
    Router: { endpoints: () => ({}), probe: async () => false },
    defaultSettings: () => ({ accent: "#d4a53f" }),
    // ---- browser globals ----
    location: opts.location || { protocol: "http:", host: "localhost:8791", port: "8791", origin: "http://localhost:8791", href: "http://localhost:8791/.freebuff/cyrus-os.html" },
    localStorage: { getItem: k => (k in local ? local[k] : null), setItem: (k, v) => { local[k] = String(v); }, removeItem: k => { delete local[k]; } },
    sessionStorage: { getItem: k => (k in session ? session[k] : null), setItem: (k, v) => { session[k] = String(v); }, removeItem: k => { delete session[k]; } },
    document: opts.document || {
      createElement: () => ({ style: {}, setAttribute() {}, removeAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, head: { appendChild() {} },
      getElementById: () => null,
      body: { appendChild() {}, classList: { contains: () => false } }, visibilityState: "visible",
    },
    navigator: Object.assign({
      hardwareConcurrency: 8,
      connection: { effectiveType: "4g", downlink: 10 },
      serviceWorker: undefined,
      storage: { estimate: async () => ({ usage: 1048576, quota: 10485760 }) },
    }, opts.navigator || {}),
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 2,
    performance: opts.performance || {},
    indexedDB: undefined,
    crypto: opts.crypto,
    URL, Blob: class {}, fetch: opts.fetch || (async () => { throw new Error("no network in tests"); }),
    __log: [], __apps: {}, __guards: [], __timers: timers,
    __fireTimers() { const t = timers.splice(0, timers.length); t.forEach(f => { try { f(); } catch (e) { ctx.__timerErr = e; } }); },
  };
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

function load(ctx, file) {
  const src = fs.readFileSync(".freebuff/" + file, "utf8").replace(/\r\n/g, "\n");
  vm.runInContext(src, ctx, { filename: file });
}

// Load the OS phases in build order. Order is not cosmetic: p10 defines the
// shared `Cyrus` namespace and `pad`, which p11 and p12 both call.
//
// Top-level `const` in a vm script lands in the global *lexical* scope, not on
// the context object, so the bindings the tests need are read back out with
// runInContext and re-attached — the same trick test_conn.js uses for StConn.
const OS_BINDINGS = [
  "Cyrus", "Mnt", "BACKENDS", "Bridge", "DiskUsage", "MntPicker",
  "SysProbe", "Snapshots", "MemSnapStore", "snapshotBefore",
  "Vaults", "Profiles", "Offline", "OllamaDiag",
  "mkFileNode", "mkDirNode", "nodeAt", "ensureDir", "pad",
];
function loadOS(ctx) {
  load(ctx, "os_p10_disk.js");
  load(ctx, "os_p11_system.js");
  load(ctx, "os_p12_snapshots.js");
  load(ctx, "os_p13_profiles.js");
  load(ctx, "os_p14_offline.js");
  for (const name of OS_BINDINGS) {
    const v = vm.runInContext(name, ctx);
    if (v !== undefined) ctx[name] = v;
  }
  return ctx;
}

module.exports = { ok, eq, report, makeCtx, load, loadOS, mkFile, mkDir, seedTree, pass: () => pass, fail: () => fail, NL };