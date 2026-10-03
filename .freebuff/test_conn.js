// Node harness for StConn — the Phase 9 authority logic.
// Loads studio_p9.js in a vm with stubbed OS globals and proves the claims the
// Connections panel makes are the claims the code actually earns.
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

// ---- the stubs ------------------------------------------------------------
// `settings` holds the live authority + provider keys. `store` counts saves so a
// test can prove we only persist when something actually changed.
function makeCtx(opts) {
  opts = opts || {};
  const saved = { keys:{}, endpoints:{} };
  const store = {
    data: { settings:{ apiKeys:{}, endpoints:{} }, log:[] },
    save(){ store.saves++; },
    saves: 0,
  };
  const ctx = {
    console,
    Promise, JSON, Date, String, Math, Object, Array, Number, Boolean, RegExp, Error,
    setTimeout, clearTimeout,
    localStorage: {
      _d: Object.assign({}, opts.ls || {}),
      getItem(k){ return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v){ this._d[k] = String(v); },
      removeItem(k){ delete this._d[k]; },
    },
    Store: store,
    Bus: { on(){}, emit(){} },
    Toast: { show(){ ctx.toasts.push(Array.prototype.slice.call(arguments)); } },
    Log: { record(){ ctx.logs.push(Array.prototype.slice.call(arguments)); } },
    esc: s => String(s),
    stModal(){ return {}; },
    PROVIDERS: opts.providers || {},
    Router: {
      keys(){ return store.data.settings.apiKeys; },
      endpoints(){ return store.data.settings.endpoints; },
      pickModel(id){ return opts.models && opts.models[id] ? opts.models[id] : "default-model"; },
      async puterReady(){ ctx.puterReadyCalls++; if(ctx.puterLoadError) throw ctx.puterLoadError; },
      async probe(id){ ctx.probes.push(id); return !!(opts.probe && opts.probe[id]); },
    },
  };
  ctx.puterReadyCalls = 0;
  ctx.toasts = [];
  ctx.logs = [];
  ctx.probes = [];
  ctx.puterLoadError = null;
  ctx.window = ctx;
  ctx.puter = opts.puter === null ? undefined : (opts.puter || {});
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(".freebuff/studio_p9.js", "utf8"), ctx, { filename: "studio_p9.js" });
  // top-level `const` is not a context property — pull the binding out explicitly
  ctx.StConn = vm.runInContext("StConn", ctx);
  ctx.StConn.paint = function(){ ctx.painted = (ctx.painted || 0) + 1; };  // no DOM in node
  return ctx;
}

// ---- 1. normalize must never let junk become an authority -----------------
{
  const { StConn } = makeCtx({});
  const good = "abc123TOKENVALUE-long-enough-here";
  eq(StConn.normalize(good), good, "normalize — a real token survives");
  eq(StConn.normalize('  "' + good + '"  '), good, "normalize — quotes and space are stripped");
  eq(StConn.normalize("undefined"), "", "normalize — rejects the string 'undefined'");
  eq(StConn.normalize("null"), "", "normalize — rejects 'null'");
  eq(StConn.normalize("[object Object]"), "", "normalize — rejects a stringified object");
  eq(StConn.normalize("true"), "", "normalize — rejects 'true'");
  eq(StConn.normalize("short"), "", "normalize — rejects anything too short to be a token");
  eq(StConn.normalize(null), "", "normalize — rejects null");
  eq(StConn.normalize(undefined), "", "normalize — rejects undefined");
  eq(StConn.normalize(12345), "", "normalize — rejects a non-string");
}

// ---- 2. capture reads every source and stores a real one ------------------
{
  const tok = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
  const { StConn, Router, Store } = makeCtx({ puter:{ authToken: tok } });
  const changed = StConn.capture("test");
  eq(changed, true, "capture — reports that the stored authority changed");
  eq(Router.keys().puterToken, tok, "capture — stores the token from puter.authToken");
  ok(Store.saves === 1, "capture — persists exactly once", "saves=" + Store.saves);
  eq(StConn.capture("again"), false, "capture — a second run is a no-op (idempotent)");
  eq(Store.saves, 1, "capture — the no-op did not rewrite storage");
}
{
  const tok = "ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS";
  const { StConn, Router } = makeCtx({ puter:{ authToken: "undefined" }, ls:{ "puter.auth.token.v2": tok } });
  eq(StConn.capture("ls"), true, "capture — falls back to localStorage when authToken is junk");
  eq(Router.keys().puterToken, tok, "capture — stored the localStorage token");
}
{
  const tok = "QQQQWWWWEEEERRRRTTTTYYYYUUUUVVVV";
  const { StConn, Router } = makeCtx({ puter:{}, ls:{ "puter.auth.token": tok } });
  StConn.capture("ls1");
  eq(Router.keys().puterToken, tok, "capture — falls back to the v1 localStorage key");
}
{
  const { StConn, Router, Store } = makeCtx({ puter:{} });
  eq(StConn.capture("empty"), false, "capture — nothing to capture is reported as nothing");
  eq(Router.keys().puterToken, undefined, "capture — no junk was written to storage");
  eq(Store.saves, 0, "capture — an empty capture never rewrites storage");
}

// ---- 3. the token must never be rendered ----------------------------------
{
  const tok = "SECRETSECRETSECRETSECRET1234";
  const { StConn } = makeCtx({ puter:{ authToken: tok } });
  StConn.capture("t");
  const html = StConn.detailHtml("puter");
  ok(html.indexOf(tok) < 0, "sheet — the full token is never rendered", html.slice(0, 200));
  ok(html.indexOf("1234") >= 0, "sheet — the last four digits are shown so you can tell them apart");
  ok(html.indexOf("••••") >= 0, "sheet — the rest of the token is masked");
  const cell = StConn.statusCell();
  ok(cell.indexOf(tok) < 0, "status cell — never carries the token");
}

// ---- 4. a 401 must never render as connected ------------------------------
{
  const tok = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
  const ctx = makeCtx({
    puter:{ authToken: tok, whoami: async ()=>{ const e = new Error("Unauthorized"); e.status = 401; throw e; } },
  });
  ctx.Router.keys().puterToken = tok;
  ctx.StConn.verify("puter").then(()=>{
    const r = ctx.StConn.rows.puter;
    ok(r && r.state !== "connected",
       "verify — a 401 is never reported as connected",
       "state=" + (r && r.state));
    ok(r && r.state === "needs",
       "verify — a 401 lands in 'needs' so the panel offers one click",
       "state=" + (r && r.state) + " detail=" + (r && r.detail));
    finish();
  }).catch(e=>{ fail++; failures.push("verify — 401 path threw: " + e.message); finish(); });
}

let pending = 0;

function finish(){
  // ---- 4b. no stored authority must always read "off", never "needs" -------
{
  const c = makeCtx({ puter:{} });
  c.StConn.verify("puter").then(()=>{
    eq(c.StConn.rows.puter.state, "off",
       "verify — with no authority stored the row is off, never needs");
    return c.StConn.restore();
  }).then(()=>{
    eq(c.StConn.rows.puter.state, "off",
       "restore — the no-authority path agrees with verify");
    eq(c.Router.keys().puterToken, undefined,
       "restore — an empty start never invents an authority");
  }).then(finish).catch(e=>{ fail++; failures.push("no-authority path threw: " + e.message); finish(); });
}

// ---- 5. a working whoami is the only thing that earns green -------------
  const tok = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
  const c5 = makeCtx({ puter:{ authToken: tok, whoami: async ()=>({ username:"rithvik" }) } });
  c5.Router.keys().puterToken = tok;
  c5.StConn.verify("puter").then(()=>{
    const r = c5.StConn.rows.puter;
    ok(r.state === "connected", "verify — a resolving whoami turns the row green", JSON.stringify(r));
    ok(/rithvik/.test(r.detail), "verify — the row says who the authority belongs to", r.detail);
    ok(r.weak === false, "verify — a real whoami is not flagged weak");

    // ---- 6b. getUser is a real verification surface, not a weak claim -----
{
  const tok = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
  const c = makeCtx({ puter:{ authToken: tok, getUser: async ()=>({ username:"rithvik" }) } });
  c.Router.keys().puterToken = tok;
  c.StConn.verify("puter").then(()=>{
    const r = c.StConn.rows.puter;
    ok(r.state === "connected", "getUser — a resolving getUser turns the row green", JSON.stringify(r));
    ok(r.weak === false, "getUser — verification via getUser is not flagged weak");
    ok(/rithvik/.test(r.detail), "getUser — the row names the signed-in identity", r.detail);
    return c.StConn.restore();
  }).then(finish).catch(e=>{ fail++; failures.push("getUser path threw: " + e.message); finish(); });
}

// ---- 6. token presence alone must not be dressed up as proof ---------
    const c6 = makeCtx({ puter:{ authToken: tok } });     // no whoami at all
    c6.Router.keys().puterToken = tok;
    return c6.StConn.verify("puter").then(()=>{
      const r6 = c6.StConn.rows.puter;
      ok(r6.weak === true, "verify — with no whoami surface the claim is marked weak",
         JSON.stringify(r6));
      ok(/unverified/.test(r6.detail), "verify — the detail text says 'unverified'", r6.detail);
      step7();
    });
  }).catch(e=>{ fail++; failures.push("verify — success path threw: " + e.message); step7(); });
}

function step7(){
  // ---- 7. forget really forgets ------------------------------------------
  const tok = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
  const c7 = makeCtx({ puter:{ authToken: tok } });
  c7.StConn.capture("t");
  ok(c7.Router.keys().puterToken === tok, "forget — pre: the authority is stored");
  c7.StConn.forget("puter");
  eq(c7.Router.keys().puterToken, undefined, "forget — the authority is deleted");
  eq(c7.StConn.rows.puter.state, "off", "forget — the row returns to off");

  // ---- 8. key providers are honest too ------------------------------------
  const c8 = makeCtx({ probe:{ groq:true, pollinations:false } });
  (c8.StConn.verify("groq"), c8.StConn.rows.groq.state, "off",
     "key provider — no key means off, never green");
  c8.Router.keys().groq = "gsk_testkey_0123456789";
  return c8.StConn.verify("groq").then(()=>{
    ok(c8.StConn.rows.groq.state === "connected", "key provider — a valid key turns it green",
       JSON.stringify(c8.StConn.rows.groq));
    return c8.StConn.verify("pollinations");
  }).then(()=>{
    eq(c8.StConn.rows.pollinations.state, "error",
       "keyless — a failing probe shows red, not green (Pollinations 403s today)");
    ok(c8.probes.indexOf("pollinations") >= 0, "keyless — the probe really ran");
    return c8.StConn.verify("local");
  }).then(()=>{
    eq(c8.StConn.rows.local.state, "connected", "local rule engine — always connected");
    step9();
  }).catch(e=>{ fail++; failures.push("key provider path threw: " + e.message); step9(); });
}

function step9(){
  // ---- 9. the audit trail never carries the secret -----------------------
  const tok = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
  const c9 = makeCtx({ puter:{ authToken: tok } });
  c9.StConn.capture("audit");
  c9.StConn.forget("puter");
  const blob = JSON.stringify(c9.logs);
  ok(c9.logs.length >= 2, "audit — capture and forget are both recorded", "n=" + c9.logs.length);
  ok(blob.indexOf(tok) < 0, "audit — no log entry contains the token", blob.slice(0, 300));
  ok(/"studio_conn"/.test(blob), "audit — entries use the studio_conn intent");
  ok(blob.indexOf("autocapture") >= 0 && blob.indexOf("forget") >= 0,
     "audit — capture and forget are distinguishable in the trail");

  // ---- 10. summary counts only what can actually be connected ------------
  const c10 = makeCtx({});
  const s = c10.StConn.summary();
  eq(s.total, c10.StConn.SCORED.length, "summary — total excludes the offline local engine");
  ok(c10.StConn.SCORED.indexOf("local") < 0, "summary — 'local' is not scored");
  ok(c10.StConn.summary().live === 0, "summary — nothing is claimed live before any check");
  report();
}

function report(){
  console.log(NL + "connection tests: " + pass + " passed, " + fail + " failed");
  if(failures.length){
    console.log(NL + "FAILURES:");
    for(const f of failures) console.log("  - " + f);
  }
  process.exit(fail ? 1 : 0);
}