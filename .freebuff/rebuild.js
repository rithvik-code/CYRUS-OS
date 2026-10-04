// full deterministic rebuild: restore, apply CSS, splice every phase in order
const fs = require("fs");
const { execSync } = require("child_process");
const FILE = ".freebuff/cyrus-os.html";
const MARK = "/*STUDIO_INSERT*/";
const CSS_A = "/*STUDIO_CSS_START*/", CSS_B = "/*STUDIO_CSS_END*/";

// Restore from HEAD, not from the index: `git checkout -- <file>` restores the
// working tree from the staged version, and if a previous build ever got staged
// that base already contains a studio block — which silently produced a second
// STUDIO_INSERT marker and broke every later build.
execSync("git checkout HEAD -- " + FILE, { stdio: "inherit" });
let h = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(".freebuff/_css.txt", "utf8").replace(/\r\n/g, "\n");

function once(needle, insert) {
  const i = h.indexOf(needle);
  if (i < 0) { console.error("ANCHOR MISSING: " + JSON.stringify(needle.slice(0, 70))); process.exit(1); }
  if (h.indexOf(needle, i + 1) >= 0 && needle.indexOf("</") < 0) { /* multiple is fine for CSS anchors */ }
  const at = i + needle.length;
  h = h.slice(0, at) + insert + h.slice(at);
}

// Make the build idempotent. A previous build (or an auto-commit of built
// output) can leave a studio block already spliced into the restored file;
// stripping it first keeps the marker unique no matter what git hands back.
const STAMP = "//  CYRUS STUDIO v2 — the IDE";
let si = h.indexOf(STAMP);
if(si >= 0){
  const mi = h.indexOf(MARK, si);
  if(mi >= 0){
    h = h.slice(0, si) + h.slice(mi + MARK.length);
    console.log("· stripped a previously injected studio block");
  }
}

// The studio CSS is injected into <style>, outside the marker-delimited block
// above, so it needs its own sentinels or every build stacks another copy.
// Builds made before the sentinels existed left a verbatim copy behind, so
// remove those too — otherwise they accumulate on every rebuild.
{
  const body = css.trim();
  let guard = 0;
  while(h.indexOf(body) >= 0 && guard++ < 10){
    const i = h.indexOf(body);
    h = h.slice(0, i) + h.slice(i + body.length);
    console.log("· removed a legacy studio stylesheet copy");
  }
  const cs = h.indexOf(CSS_A), ce = h.indexOf(CSS_B);
  if(cs >= 0 && ce > cs){
    h = h.slice(0, cs) + h.slice(ce + CSS_B.length);
    console.log("· stripped a previously injected studio stylesheet");
  }
}

once("  --radius:12px;\n}",
  "\n  --st-mono:\"JetBrains Mono\",\"Cascadia Code\",Consolas,\"SF Mono\",Menlo,monospace;\n}");
once(".st-status .tb-btn{font-size:11px;padding:3px 10px}\n",
  "\n" + CSS_A + "\n" + css + "\n" + CSS_B + "\n");

once("// --- CYRUS Studio (VS Code + Cursor style IDE: explorer, tabs, runner, AI copilot)\n",
  "// ============================================================================\n" +
  "//  CYRUS STUDIO v2 — the IDE\n" +
  "//  Phase 0 LANG · Phase 1 EDIT · Phase 2 XPL · Phase 3 PROJ · Phase 4 RUN\n" +
  "//  Phase 5 AI · Phase 6 NAV · Phase 7 EXT · Phase 8 POLISH\n" +
  "// ============================================================================\n" + MARK + "\n\n" +
  "// --- CYRUS Studio (VS Code + Cursor style IDE: explorer, tabs, runner, AI copilot)\n");

const chunks = [
  ".freebuff/_p0.js", ".freebuff/_p1.js", ".freebuff/_p234.js", ".freebuff/_p5.js",
  ".freebuff/_p67.js", ".freebuff/studio_p8a.js", ".freebuff/studio_p8b.js",
  ".freebuff/studio_p8c.js", ".freebuff/studio_p8d.js", ".freebuff/studio_p8e.js",
  ".freebuff/studio_p8f.js", ".freebuff/studio_p9.js",
  // OS phases. Order matters: p10 defines the shared `Cyrus` namespace and the
  // `Mnt`/`Bridge`/`DiskUsage` objects the later phases extend, so it must stay
  // first. Each is self-contained otherwise.
  ".freebuff/os_p10_disk.js", ".freebuff/os_p11_system.js", ".freebuff/os_p12_snapshots.js",
  ".freebuff/os_p13_profiles.js", ".freebuff/os_p14_offline.js", ".freebuff/os_p15_search.js",
  ".freebuff/os_p16_store.js", ".freebuff/os_p17_undo.js", ".freebuff/os_p18_context.js"
];
for (const c of chunks) {
  const body = fs.readFileSync(c, "utf8").replace(/\r\n/g, "\n");
  if (h.indexOf(MARK) !== h.lastIndexOf(MARK)) { console.error("marker duplicated before " + c); process.exit(1); }
  h = h.replace(MARK, () => body + "\n" + MARK);
  fs.writeFileSync(FILE, h);
  console.log("+ " + c.replace(".freebuff/", "").padEnd(18) + body.split("\n").length + " lines");
}

// openEditor delegates to the new studio
h = fs.readFileSync(FILE, "utf8");
const a = h.indexOf("function openEditor(path){");
const marker = "\nApps.register(\"editor\",{ title:\"CYRUS Studio\"";
const b = h.indexOf(marker, a);
if (a < 0 || b < 0) { console.error("openEditor anchors missing"); process.exit(1); }
h = h.slice(0, a) + "function openEditor(path){ openStudio(path ? { path } : undefined); }\n" + h.slice(b + 1);
fs.writeFileSync(FILE, h);

// syntax check every inline script
const blocks = [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let bad = 0;
blocks.forEach((blk, i) => {
  const tmp = ".freebuff/_chk" + i + ".js";
  fs.writeFileSync(tmp, blk);
  try { execSync("node --check " + tmp, { stdio: "pipe" }); fs.unlinkSync(tmp); }
  catch (e) { bad++; console.log("SYNTAX ERROR:\n" + (e.stderr || e.message).toString().slice(0, 1000)); }
});
console.log("\nTotal " + h.split("\n").length + " lines, " + blocks.length + " script block(s), " +
            (bad ? "FAILED" : "syntax OK"));

// A malformed symbol regex still parses as JS, so the syntax check above cannot
// see it — SYM just drops the rule with a console.warn at load time. Compile
// every rule explicitly so that failure is a build failure, not a silent gap.
let regexBad = 0;
try { execSync("node .freebuff/validate_regex.js", { stdio: "inherit" }); }
catch (e) { regexBad = 1; }

process.exit(bad || regexBad ? 1 : 0);