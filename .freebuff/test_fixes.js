// ---------------------------------------------------------------------------
//  Regression tests for the language layer and the Quick Fix engine.
//
//  `_p0.js` (LANG / SYMBOLS / DIAG / HL) is pure data and pure functions — it
//  touches no DOM at load — so it can be evaluated straight into a vm context
//  and exercised here. That turns "I clicked it in the browser once" into
//  something the build refuses to ship without.
//
//  Two things are asserted for every fixture:
//    1. the fixer produces exactly the expected text, and
//    2. running the diagnostic again on the result reports nothing new,
//  plus a guard that clean code is left completely alone.
// ---------------------------------------------------------------------------
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const NL = "\n";
const src = fs.readFileSync(path.join(__dirname, "_p0.js"), "utf8").replace(/\r\n/g, "\n");
const ctx = vm.createContext({ console, performance, JSON, Math, RegExp, Set, Map, Array, Object, String, Number, Boolean, Error });
vm.runInContext(src, ctx, { filename: "_p0.js" });

// top-level `const` in a vm script lands in the context's global *lexical*
// scope, not on the context object — so pull them out with a second script
const { LANG, DIAG, SYMBOLS } = vm.runInContext("({ LANG, DIAG, SYMBOLS })", ctx);

// ---- tiny assertion helpers ------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name + (detail ? "\n      " + String(detail).split("\n").join("\n      ") : ""));
  return false;
}
function eq(got, want, name) {
  return ok(got === want, name, got === want ? "" : "expected: " + JSON.stringify(want) + "\ngot:      " + JSON.stringify(got));
}

// apply every mechanical fix for a source and report what happened
function fixAll(source, path) {
  const spec = LANG.forPath(path, source);
  const diags = DIAG.analyze(source, spec);
  const fixes = diags.map(d => DIAG.quickFix(source, spec, d)).flat().filter(f => f.kind === "mechanical");
  const after = DIAG.applyFixes(source, fixes);
  const remaining = DIAG.analyze(after, LANG.forPath(path, after)).map(d => d.sev + " " + d.msg);
  return { ids: fixes.map(f => f.id), after, remaining, diags };
}

// ---- 1. every mechanical fixer, one fixture each -----------------------------
const FIXERS = [
  {
    name: "bracket.close — one unclosed brace",
    path: "a.js", ids: ["bracket.close"],
    before: ["function a() {", "  return 1;"].join(NL),
    after:  ["export function a() {", "  return 1;}"].join(NL),
  },
  {
    name: "bracket.close — nested openers close in the right order",
    path: "a.js", ids: ["bracket.close", "bracket.close"],
    before: ["function a() {", "  const b = (1 + 2;"].join(NL),
    // `)` then `}`: the inner paren must land before the outer brace
    after:  ["export function a() {", "  const b = (1 + 2;)}"].join(NL),
  },
  {
    name: "bracket.open — unexpected closer gets its opener",
    path: "a.js", ids: ["bracket.open"],
    before: ["const a = 1;", "}"].join(NL),
    after:  ["const a = 1;", "{}"].join(NL),
  },
  {
    name: "string.close — unterminated string",
    path: "a.js", ids: ["string.close"],
    before: ["const s = 'hello", "const t = 1;"].join(NL),
    after:  ["const s = 'hello'", "const t = 1;"].join(NL),
  },
  {
    name: "eq.strict — loose equality",
    path: "a.js", ids: ["eq.strict"],
    before: "function f(x){ if(x == 2) return 1; }",
    after:  "export function f(x){ if(x === 2) return 1; }",
  },
  {
    name: "var.let — var to let",
    path: "a.js", ids: ["var.let"],
    before: "function f(){ var x = 1; return x; }",
    after:  "export function f(){ let x = 1; return x; }",
  },
  {
    name: "except.ex — bare except",
    path: "a.py", ids: ["except.ex"],
    before: ["def f():", "    try:", "        pass", "    except:", "        pass"].join(NL),
    after:  ["def f():", "    try:", "        pass", "    except Exception:", "        pass"].join(NL),
  },
  {
    name: "guard.add — missing include guard",
    path: "a.c", ids: ["guard.add"],
    before: ["#include <stdio.h>", "int main(){ return 0; }"].join(NL),
    after:  ["#ifndef STDIOH", "#define STDIOH", "#include <stdio.h>", "int main(){ return 0; }", "#endif // STDIOH"].join(NL),
  },
  {
    name: "unused.import — drop the unused import",
    path: "a.py", ids: ["unused.import"],
    before: ["import os", "import sys", "print(os.getcwd())"].join(NL),
    after:  ["import os", "", "print(os.getcwd())"].join(NL),
  },
  {
    name: "unused.export — mark the unused function as used",
    path: "a.js", ids: ["unused.export"],
    before: ["function area(r){ return r }", "export const k = 1;"].join(NL),
    after:  ["export function area(r){ return r }", "export const k = 1;"].join(NL),
  },
];

for (const f of FIXERS) {
  const r = fixAll(f.before, f.path);
  ok(r.ids.includes(f.ids[0]), f.name + " — offered the fix", "got ids: " + JSON.stringify(r.ids));
  eq(r.after, f.after, f.name + " — produced the right text");
  ok(!r.remaining.some(m => m.startsWith("err ") || m.startsWith("warn ")),
     f.name + " — no errors or warnings left", r.remaining.join(" | "));
}

// ---- 2. CYRUS must refuse to guess when the bracket stack desyncs ----------
{
  const src = ["function a() {", "  const b = [1,2;", "}"].join(NL);
  const r = fixAll(src, "a.js");
  ok(!r.ids.includes("bracket.close") && !r.ids.includes("bracket.open"),
     "desync — no bracket fix offered for a stack CYRUS cannot trust",
     "ids offered: " + JSON.stringify(r.ids));
  // unused.export legitimately fires here and is safe. What must NOT happen is a
  // bracket edit: appending ] to a desynced stack would be CYRUS guessing.
  ok(r.after === ["export function a() {", "  const b = [1,2;", "}"].join(NL),
     "desync — only the safe unused.export edit lands", JSON.stringify(r.after));
  // the desynced line must come back byte-identical: appending ] would be a guess
  ok(r.after.split(NL).includes("  const b = [1,2;"),
     "desync — the desynced line is byte-identical, no ] invented",
     JSON.stringify(r.after));
}

// ---- 3. clean code must be left completely alone --------------------------
const CLEAN = [
  ["ternary and comparisons", "a.js", "function f(a,b){ if(a > 1 && a < 9 && b != 3) return a<b?1:2; return 0; }"],
  ["object literals",       "a.js", "const o = { a: 1, b: { c: 2 } }; const p = { x: o.a ? 1 : 0 }; console.log(o,p);"],
  ["generics in ts",        "a.ts", "function id<T>(v: T): T { return v; } const r = id<string>(\"q\"); export default r;"],
  ["python idioms",         "a.py", "def f(xs):\n    return {k: v for k, v in zip('ab', xs)}"],
  ["c preprocessor",        "a.c", "#ifndef GUARD_H\n#define GUARD_H\nint f(void){ return 0; }\n#endif"],
];
for (const [label, p, code] of CLEAN) {
  const spec = LANG.forPath(p, code);
  const diags = DIAG.analyze(code, spec).filter(d => d.sev !== "info");
  ok(diags.length === 0, "clean/" + label + " — no errors or warnings", diags.map(d => d.sev + " " + d.msg).join(" | "));
  ok(DIAG.applyFixes(code, []) === code, "clean/" + label + " — applyFixes is a no-op with no fixes");
}

// ---- 4. diagnostics carry a usable pos ------------------------------------
{
  const code = ["function a() {", "  var x = 1;","  if(x == 2) {","    return x","  }","}"].join(NL);
  const spec = LANG.forPath("a.js", code);
  const bad = DIAG.analyze(code, spec).filter(d => d.pos == null || typeof d.pos !== "number");
  ok(bad.length === 0, "pos — every diagnostic carries a character offset",
     bad.map(d => d.msg).join(" | "));
  const d = DIAG.analyze(code, spec).find(x => x.msg.indexOf("Loose equality") === 0);
  eq(code.substr(d.pos, 2), "==", "pos — loose-equality offset points at the operator, not the space before it");
}

// ---- 5. language routing must not leak across families --------------------
{
  // spec.fam is "c" for JavaScript too, so branch on identity not on flags
  const js = ["import fs from 'fs';", "export const a = 1;"].join(NL);
  const c  = ["#include <stdio.h>", "int main(){ return 0; }"].join(NL);
  ok(DIAG.quickFix(js, LANG.forPath("a.js", js),
       DIAG.analyze(js, LANG.forPath("a.js", js)).find(d => /imported but never used/.test(d.msg)) || { src:"" })
       .some(f => f.id === "unused.import"),
     "routing — a JS import is matched by the JS rule, not the #include rule");
  ok(DIAG.quickFix(c, LANG.forPath("a.c", c),
       DIAG.analyze(c, LANG.forPath("a.c", c)).find(d => /include guard/.test(d.msg)) || { src:"" })
       .some(f => f.id === "guard.add"),
     "routing — a C #include is matched by the include rule");
}

// ---- 6. every symbol family must actually extract something ---------------
// A wrong capture-group index or a `+` where the modifiers should be `*` makes
// a whole language vanish from the outline, quick open and workspace symbols
// without any error anywhere. This is the guard against that whole class.
const FAMILIES = [
  ["jvm",   "A.java",   ["public class Thing {", "  public async Task Run(){ }", "}"].join(NL),       ["Thing", "Run"]],
  ["cs",    "A.cs",     ["public class Thing {", "  public async Task Run(){ }", "}"].join(NL),       ["Thing", "Run"]],
  ["go",    "a.go",     ["func Run() int { return 1 }", "type T struct{}"].join(NL),                  ["Run", "T"]],
  ["rs",    "a.rs",     ["fn run() -> i32 { 1 }", "struct P;"].join(NL),                              ["run", "P"]],
  ["py",    "a.py",     ["def run(x):", "    return x"].join(NL),                                    ["run"]],
  ["js",    "a.js",     ["function run(x){ return x }", "class C {}"].join(NL),                        ["run", "C"]],
  ["ts",    "a.ts",     ["function run(x: number){ return x }", "interface I {}"].join(NL),             ["run", "I"]],
  ["rb",    "a.rb",     ["class D", "  def bark(x)", "  end", "end"].join(NL),                         ["D", "bark"]],
  ["php",   "a.php",    ["class A { public function b($x){ return $x; } }"].join(NL),                   ["A", "b"]],
  ["kt",    "a.kt",     ["class Person {", "  fun greet(): String = \"hi\"", "}"].join(NL),             ["Person", "greet"]],
  ["swift", "a.swift",  ["class Thing {", "  func run() -> Int { return 1 }", "}"].join(NL),            ["Thing", "run"]],
  ["scala", "a.scala",  ["class Thing {", "  def run(): Int = 1", "}"].join(NL),                       ["Thing", "run"]],
  ["lua",   "a.lua",    ["function run(x)", "  return x", "end"].join(NL),                             ["run"]],
  ["dart",  "a.dart",   ["class Thing {", "  int run(){ return 1; }", "}"].join(NL),                   ["Thing", "run"]],
  ["c",     "a.c",      ["int run(int a){ return a; }", "struct P { int x; };"].join(NL),              ["run", "P"]],
];
for (const [fam, path, code, want] of FAMILIES) {
  const got = SYMBOLS.extract(code, LANG.forPath(path, code)).map(s => s.name);
  for (const w of want) {
    ok(got.includes(w), "symbols/" + fam + " — finds " + w, "found: " + JSON.stringify(got));
  }
  const junk = got.filter(n => !n || /[\s{}]/.test(n));
  ok(junk.length === 0, "symbols/" + fam + " — no junk names", JSON.stringify(junk));
}

console.log(`\nfix + language tests: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFAILURES:\n  - " + failures.join("\n  - "));
}
process.exit(fail ? 1 : 0);