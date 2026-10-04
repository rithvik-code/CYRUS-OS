// Mutation check for phase 17 (undo + terminal policy).
const fs = require("fs");
const { execSync } = require("child_process");
const path = ".freebuff/os_p17_undo.js";
const orig = fs.readFileSync(path, "utf8");

const mutants = [
  ["the shell stops consulting the protection policy",
   "if(typeof StFS !== \"undefined\" && StFS.protected && StFS.protected(p)){\n        Log.record(\"term: rm \" + target",
   "if(false){\n        Log.record(\"term: rm \" + target"],
  ["the shell stops asking before deleting",
   "if(!yes){",
   "if(false){"],
  ["the shell reports confirmation it never got",
   "\"medium\", true, true, \"rm via terminal\"",
   "\"medium\", false, true, \"rm via terminal\""],
  ["rmdir goes unlogged again",
   "Log.record(\"term: rmdir \" + a[0], \"delete_file\", { path:p }, \"medium\", true, true, \"rmdir via terminal\");",
   "void 0;"],
  ["undo captures nothing",
   "if(!VFS.node(p)) continue;",
   "if(true) continue;"],
  ["undo restores only part of the directory",
   "node.children = JSON.parse(JSON.stringify(s.children));",
   "{ const c = JSON.parse(JSON.stringify(s.children)); const ks = Object.keys(c); node.children = {}; for (const k of ks.slice(0, 1)) node.children[k] = c[k]; }"],
  ["a refused operation still creates undo history",
   "if(allowed) Undo.commit",
   "Undo.commit"],
  ["the history is never bounded",
   "if(this.stack.length > this.LIMIT) this.stack.shift();",
   ""],
];

let survived = 0;
for (const [name, from, to] of mutants) {
  if (orig.indexOf(from) < 0) { console.log("  TARGET NOT FOUND      " + name); survived++; continue; }
  fs.writeFileSync(path, orig.split(from).join(to));
  let out = "";
  try { out = execSync("node .freebuff/test_undo.js", { encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const m = out.match(/(\d+) passed, (\d+) failed/);
  // A crash counts as caught: the suite did not pass. Treating an absent
  // summary as a survival is how a mutation check reports false confidence.
  const failed = m ? Number(m[2]) : 999;
  if (failed <= 0) survived++;
  const label = m ? ("caught (" + failed + ")") : "caught (crashed)";
  console.log("  " + label.padEnd(16) + name);
}
fs.writeFileSync(path, orig);
console.log(survived === 0 ? "\nall mutants caught" : "\n" + survived + " mutant(s) survived");