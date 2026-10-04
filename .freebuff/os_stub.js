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

// ---------------------------------------------------------------------------
// A minimal but faithful IndexedDB.
//
// Faithful in the ways the Store chunk can actually observe a difference:
// genuinely asynchronous (never a sync callback, so a missing await is a real
// bug rather than an accident), a real upgrade → success lifecycle, real
// transaction commit semantics (reads inside a write transaction see its own
// writes; `oncomplete` fires last), and a structured clone on `put` so a caller
// cannot mutate the stored object after the fact.
//
// It is deliberately able to *fail* — `fake.failWrites` — because the entire
// reason phase 16 exists is that persistence can fail quietly, and a fake that
// always succeeds would hide the exact bug it was written to find.
function makeIDB() {
  // name -> { version, stores:Map(storeName -> Map(key -> value)) }
  const dbs = new Map();
  const api = {
    failWrites: false,
    // data survives across contexts, so a test can simulate a reload by
    // building a second context over the same fake.
    _dbs: dbs,
  };
  const tick = fn => Promise.resolve().then(fn);

  api.open = function (name, version) {
    const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: null };
    tick(() => {
      let rec = dbs.get(name);
      let upgraded = false;
      if (!rec) { rec = { version: 0, stores: new Map() }; dbs.set(name, rec); upgraded = true; }
      // The real database only runs an upgrade when the version actually goes
      // up. Firing onupgradeneeded on every open would silently destroy the
      // stored data each time — a fake that is more destructive than reality
      // hides the very bug it exists to find.
      else if (version && version > rec.version) upgraded = true;
      if (upgraded) rec.version = version || 1;

      const db = {
        objectStoreNames: { contains: s => rec.stores.has(s) },
        createObjectStore(s) { rec.stores.set(s, new Map()); return api._handle(s, rec, null); },
        transaction(names) {
          const list = Array.isArray(names) ? names : [names];
          const tx = { oncomplete: null, onerror: null, onabort: null, error: null, _failed: false };
          tx.objectStore = n => api._handle(n, rec, tx);
          // A failing request aborts its transaction, so the commit callback
          // must NOT report success. Callers that trust oncomplete to mean
          // "durable" would otherwise believe a lost write was saved.
          tick(() => {
            if (tx._failed) { if (tx.onerror) tx.onerror(); else if (tx.onabort) tx.onabort(); }
            else if (tx.oncomplete) tx.oncomplete();
          });
          return tx;
        },
        close() {},
      };
      req.result = db;
      if (upgraded && req.onupgradeneeded) req.onupgradeneeded();
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  };

  api._handle = function (storeName, rec, tx) {
    const data = rec.stores.get(storeName) || new Map();
    const settle = (req, value, err) => tick(() => {
      if (err) { req.error = err; if (req.onerror) req.onerror(); }
      else { req.result = value; if (req.onsuccess) req.onsuccess(); }
    });
    // A failing request aborts its transaction. The flag is set *synchronously*
    // at call time, not inside the async callback: the transaction's commit
    // check was queued first, so a late flag would be read as success.
    const fail = (req, msg) => { if (tx) tx._failed = true; settle(req, undefined, new Error(msg)); return req; };
    return {
      // keyPath is "k" throughout this OS.
      put(v) {
        const req = {};
        if (api.failWrites) return fail(req, "write failed");
        data.set(v.k, JSON.parse(JSON.stringify(v)));   // structured clone
        settle(req, v.k);
        return req;
      },
      get(k) {
        const req = {};
        settle(req, data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : undefined);
        return req;
      },
      delete(k) {
        const req = {};
        if (api.failWrites) return fail(req, "delete failed");
        data.delete(k);
        settle(req, undefined);
        return req;
      },
      clear() { data.clear(); },
    };
  };
  return api;
}

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
      // The real VFS announces every mutation on the bus. Without this the stub
      // skipped every Bus.on("vfs") hook, which is how the search index could
      // look broken while its wiring was in fact fine.
      if (this && this.host && this.host.Bus) this.host.Bus.emit("vfs");
      return true;
    },
    remove(path) {
      const n = this.node(path);
      const dir = this.node(this.parent(path));
      if (!n || !dir || dir.type !== "dir") return false;
      delete dir.children[this.base(path)];
      if (this && this.host && this.host.Bus) this.host.Bus.emit("vfs");
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
    // The real Store persists under this key; phase 16 mirrors to it.
    KEY: "cyrus_os_v2",
    data: { vfs: VFS.root, log: [], settings: { accent: "#d4a53f" }, notes: {} },
    saves: 0,
    save() { Store.saves++; },
    // Faithful to the real load(): the state comes from localStorage, and a
    // missing or unparseable payload seeds a fresh one. Without this a test
    // could not simulate a reload at all — a new context would just start from
    // the default state and hydration would have nothing to restore.
    load() {
      try { Store.data = JSON.parse(ctx.localStorage.getItem(Store.KEY)); } catch (e) { Store.data = null; }
      if (!Store.data || !Store.data.vfs) {
        Store.data = { vfs: VFS.root, log: [], settings: { accent: "#d4a53f" }, notes: {} };
      }
      if (!Store.data.settings) Store.data.settings = { accent: "#d4a53f" };
      if (!Store.data.notes) Store.data.notes = {};
    },
    // Faithful: the real reset() removes the persisted key before reloading. A stub
    // that only reloaded left the old state in storage, so a "wiped" OS came
    // back with everything intact — a reset test that passed for the wrong reason.
    reset() { delete local[Store.KEY]; ctx.location.reload(); },
  };
  const store = {};
  // `opts.local` lets a test hand the *same* backing map to a second context,
  // which is how a reload is simulated: new Store, same durable storage.
  const local = opts.local || {};
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
    // A real emitter. The no-op version this replaces silently skipped every
    // Bus.on("vfs") invalidation hook, so a test could pass while the real
    // wiring was broken — and could fail for reasons that had nothing to do
    // with the code under test.
    Bus: {
      _m: {},
      on(e, f){ (this._m[e] = this._m[e] || []).push(f); },
      emit(e, d){ (this._m[e] || []).forEach(f => { try { f(d); } catch (err) { ctx.__busErr = err; } }); },
    },
    // Faithful to the real Log.record, which JSON-stringifies `fields` before
    // storing it. Keeping them raw here made assertions disagree with the
    // shape the audit log actually has.
    Log: {
      // Faithful to the real Log.record, which JSON-stringifies `fields`, writes
      // through Store.data.log, trims to 300, persists and re-emits.
      //
      // It also throws when Store.data is null — because the real one does. The
      // previous stub pushed straight into ctx.__log, which quietly made every
      // pre-Store callback succeed, hiding the boot race in which Cyrus fires
      // ready before Store.load() and silently drops audit records. ctx.__log
      // stays as a chronological mirror for assertions.
      record(user_text, intent, fields, risk, confirmed, ok, message){
        const row = [user_text, intent, JSON.stringify(fields), risk, !!confirmed, !!ok, message];
        Store.data.log.unshift(row);              // TypeError if Store.data is null — as in the real OS
        if (Store.data.log.length > 300) Store.data.log.length = 300;
        Store.save();
        ctx.__log.push(row);
        ctx.Bus.emit("log");
      },
      recent(n = 100) { return Store.data.log.slice(0, n); },
      all() { return Store.data.log; },
      clear() { Store.data.log.length = 0; },
    },
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
    // The REAL CRITICAL/SYSTEM lists and the REAL protected() implementation,
    // copied verbatim from cyrus-os.html. An empty list here made every
    // path-safety assertion vacuously true — the stub was agreeing with
    // whatever the code did, which is the opposite of a test.
    StFS: {
      risk(op) { return op === "delete" ? "medium" : "low"; },
      CRITICAL: ["/", "/home", "/home/rithvik", "/home/rithvik/Documents", "/home/rithvik/Projects"],
      SYSTEM: ["/etc","/bin","/sbin","/lib","/usr","/var","/boot","/dev","/proc","/sys","/opt"],
      protected(p) {
        return this.CRITICAL.includes(p) || this.SYSTEM.some(s => p === s || p.startsWith(s + "/"));
      },
      // The real guard() enforces the policy: it screens targets with
      // protected(), logs a refusal, and returns false *without* touching the
      // filesystem. A permissive stub made every "does the gate hold?" test
      // vacuous — it answered yes to anything, including "/" .
      // The sandbox still auto-confirms the medium/high branch and records the
      // dispatch in __guards so tests can assert the op actually ran.
      guard: async function (op, targets, describe) {
        targets = Array.isArray(targets) ? targets : [targets];
        const critical = targets.filter(t => this.protected(t));
        if (critical.length) {
          ctx.Log.record("studio: " + op, "studio_file_op", { op, targets }, "high", false, false,
                     "Blocked: " + describe + " on a critical path (" + critical.join(", ") + ")");
          return false;
        }
        const risk = this.risk(op, targets.length > 1);
        if (risk === "medium" || risk === "high") {
          ctx.__guards.push({ op, targets, describe });
          ctx.Log.record("studio: " + op, "studio_file_op", { op, targets }, risk, true, true, describe);
        }
        return true;
      },
    },
    Router: { endpoints: () => ({}), probe: async () => false },
    defaultSettings: () => ({ accent: "#d4a53f" }),
    // ---- browser globals ----
    location: opts.location || { protocol: "http:", host: "localhost:8791", port: "8791", origin: "http://localhost:8791", href: "http://localhost:8791/.freebuff/cyrus-os.html" },
    localStorage: {
      getItem: k => (k in local ? local[k] : null),
      // `opts.lsQuota` reproduces the real ceiling. The base Store.save()
      // swallows this error, which is precisely the failure phase 16 must
      // detect — so the fake has to be able to raise it.
      setItem(k, v) {
        if (opts.lsQuota && String(v).length > opts.lsQuota) {
          const e = new Error("QuotaExceededError");
          e.name = "QuotaExceededError";
          throw e;
        }
        local[k] = String(v);
      },
      removeItem: k => { delete local[k]; },
    },
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
    // `opts.idb` — pass a makeIDB() instance to share one database across
    // contexts (a reload), or `false` to model a runtime without IndexedDB.
    indexedDB: opts.idb === false ? undefined : (opts.idb || makeIDB()),
    crypto: opts.crypto,
    URL, Blob: class {}, fetch: opts.fetch || (async () => { throw new Error("no network in tests"); }),
    __log: [], __apps: {}, __guards: [], __timers: timers,
    // The raw backing map behind localStorage/sessionStorage, so a test can
    // assert what was actually persisted. `localStorage.foo` is undefined by
    // design — it is a real Storage-like object, not a bag of properties.
    __local: local,
    __fireTimers() { const t = timers.splice(0, timers.length); t.forEach(f => { try { f(); } catch (e) { ctx.__timerErr = e; } }); },
  };
  VFS.host = ctx;            // so mutations emit on the real bus
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
  "Vaults", "Profiles", "Offline", "OllamaDiag", "SearchIndex", "Persist",
  "mkFileNode", "mkDirNode", "nodeAt", "ensureDir", "pad",
];
function loadOS(ctx) {
  load(ctx, "os_p10_disk.js");
  load(ctx, "os_p11_system.js");
  load(ctx, "os_p12_snapshots.js");
  load(ctx, "os_p13_profiles.js");
  load(ctx, "os_p14_offline.js");
  load(ctx, "os_p15_search.js");
  load(ctx, "os_p16_store.js");
  for (const name of OS_BINDINGS) {
    const v = vm.runInContext(name, ctx);
    if (v !== undefined) ctx[name] = v;
  }
  return ctx;
}

module.exports = { ok, eq, report, makeCtx, makeIDB, load, loadOS, mkFile, mkDir, seedTree, pass: () => pass, fail: () => fail, NL };