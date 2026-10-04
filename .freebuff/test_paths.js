// Path-safety tests.
//
// These exist because of a real finding, not a hypothetical. StFS.protected()
// compared the caller's string against CRITICAL/SYSTEM as written, so five
// paths that resolve to a protected directory passed the check and were then
// normalised onto it on the way to the filesystem. The worst was
//
//     /home/rithvik/Documents/../../../../   ->   "/"
//
// which addresses the entire filesystem and was reported as *not* protected.
//
// The lesson encoded here: a policy decision must be made on the path that will
// actually be used, never on the string the caller happened to type.
const { ok, eq, report, makeCtx, loadOS } = require("./os_stub.js");

async function main() {
  const ctx = makeCtx();
  loadOS(ctx);
  const { VFS, StFS } = ctx;

  // ---- VFS.norm: the examples from the review, and the nastier ones -------
  eq(VFS.norm("/", "/home/rithvik/Docs/../Downloads/file.txt"),
     "/home/rithvik/Downloads/file.txt", "a mid-path .. is collapsed");
  eq(VFS.norm("/", "/home/rithvik/Downloads/../../"), "/home",
     "walking past the user's home lands at /home, not somewhere invented");
  eq(VFS.norm("/", "/home/rithvik/Documents/../../../../"), "/",
     "walking past the root clamps to / rather than escaping it");
  eq(VFS.norm("/", "//home//rithvik//Documents"), "/home/rithvik/Documents",
     "duplicate separators collapse");
  eq(VFS.norm("/", "/home/rithvik/./Documents"), "/home/rithvik/Documents",
     "a lone dot is dropped");
  eq(VFS.norm("/", "~"), "/home/rithvik", "~ is home");
  eq(VFS.norm("/", "~/Documents"), "/home/rithvik/Documents", "~/ is home-relative");
  eq(VFS.norm("/home/rithvik", "Documents/a.txt"), "/home/rithvik/Documents/a.txt",
     "a relative path resolves against the base");
  eq(VFS.norm("/", ""), "/", "an empty path is the base, not undefined");
  eq(VFS.norm("/", null), "/", "null is the base, not a crash");
  eq(VFS.norm("/", "/"), "/", "the root normalises to itself");

  // Every normalised path must be absolute, ..-free and free of empty segments.
  for (const p of ["/home/rithvik/Documents/../../../../", "//x//y/../z", "/a/./b/./c",
                   "/home/rithvik/../../etc/passwd", "~/../..", "/....//", "/a/../../.."]) {
    const n = VFS.norm("/", p);
    ok(n.startsWith("/"), "normalised path is absolute: " + JSON.stringify(p) + " -> " + JSON.stringify(n));
    ok(!n.split("/").includes(".."), "no .. survives normalisation: " + JSON.stringify(n));
    ok(!n.includes("//"), "no empty segment survives: " + JSON.stringify(n));
  }

  // ---- the policy must decide on the normalised path ---------------------
  // These five are the bypasses. If any of them ever passes again, a protected
  // directory is one ".." away from being deletable.
  const bypasses = [
    "/home/rithvik/Documents/../Documents",
    "/home/rithvik/./Documents",
    "//home//rithvik//Documents",
    "/home/rithvik/Documents/sub/..",
    "/home/rithvik/Documents/../../../../",
  ];
  for (const p of bypasses) {
    ok(StFS.protected(p), "bypass closed: " + JSON.stringify(p) + " -> " + JSON.stringify(VFS.norm("/", p)));
  }

  const mustBlock = bypasses.concat([
    "/home/rithvik/Documents", "/home/rithvik", "/home", "/",
    "/home/rithvik/Documents/..", "/etc", "/etc/passwd", "/usr/bin", "/proc/self",
  ]);
  for (const p of mustBlock) ok(StFS.protected(p), "protected() blocks " + JSON.stringify(p));

  // ---- and must NOT over-block ordinary work -----------------------------
  const mustAllow = [
    "/home/rithvik/Downloads",
    "/home/rithvik/Downloads/notes.txt",
    "/home/rithvik/Documents/sub/notes.txt",   // a CHILD of a protected dir is fair game
    "/home/rithvik/Desktop",
    "/etcetera",                               // a prefix lookalike is not /etc
    "/system",
    "/home/rithvik/Projects/app.js",
    "/home/rithvik/Memory/cyrus-memory.json",
  ];
  for (const p of mustAllow) ok(!StFS.protected(p), "protected() allows ordinary path " + JSON.stringify(p));

  // SYSTEM matching is prefix-based on a segment boundary, not a raw string
  // prefix — "/etcetera" must not be treated as "/etc".
  ok(StFS.protected("/etc/passwd"), "/etc/passwd is a system path");
  ok(!StFS.protected("/etcetera"), "/etcetera is not /etc");

  // The wrapper is idempotent: loading the chunks twice must not stack.
  eq(typeof StFS.protected.__normalised, "boolean", "the hardening is marked so it cannot be applied twice");
  loadOS(ctx);
  eq(StFS.protected("/home/rithvik/Documents/../../../../"), true,
     "still blocked after a second load — no double-wrapping regression");

  // ---- the guard refuses a traversal without touching the filesystem ------
  const allowed = await StFS.guard("delete", "/home/rithvik/Documents/../../../../", "delete everything");
  eq(allowed, false, "guard() refuses a traversal path");
  eq(ctx.__guards.length, 0, "and never dispatched the operation");
  const logged = ctx.__log.filter(l => l[1] === "studio_file_op");
  ok(logged.length > 0 && /critical path/i.test(String(logged[logged.length-1][6])),
     "the refusal is written to the audit log with a reason", logged.length ? logged[logged.length-1][6] : "none");

  // A legitimate delete still gets through, so the hardening did not turn the
  // policy into a blanket "deny everything".
  const okDelete = await StFS.guard("delete", "/home/rithvik/Downloads/junk.txt", "delete a file");
  eq(okDelete, true, "an ordinary delete is still permitted");
  eq(ctx.__guards.length, 1, "and it reached the operation");

  process.exit(report("path tests"));
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });
