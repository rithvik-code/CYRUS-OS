// Mutation check for phase 16. Each mutant must break the suite; a mutant that
// survives means the test it targets is not actually asserting anything.
const fs = require("fs");
const path = ".freebuff/os_p16_store.js";
const orig = fs.readFileSync(path, "utf8");

const mutants = [
  ["adopt whenever the database has any record",
   "const mirrorHoldsNothing = this.mirrorRev === 0;",
   "const mirrorHoldsNothing = true;"],
  ["ignore whether memory is ahead",
   "const databaseAhead = idbRev > (Store.rev || 0);",
   "const databaseAhead = true;"],
  ["always adopt",
   "if(!(mirrorHoldsNothing || databaseAhead)){",
   "if(false){"],
  ["never adopt",
   "if(!(mirrorHoldsNothing || databaseAhead)){",
   "if(true){"],
  ["mirror advances the marker even when the write failed",
   '      this.lastError = "mirror quota: " + String(e && e.name || e);\n      return false;',
   '      this.lastError = "mirror quota: " + String(e && e.name || e);\n      try{ localStorage.setItem(this.MIRROR_KEY, String(Store.rev || 0)); this.mirrorRev = Store.rev || 0; }catch(e2){}\n      return false;'],
  ["mirroring is never held back",
   "if(!this.bootDone){ this._mirrorPending = true; return false; }",
   "if(false){ this._mirrorPending = true; return false; }"],
  ["reset forgets to clear the database",
   "tx.objectStore(Persist.STORE).delete(Persist.KEY);",
   "void 0;"],
];

let survived = 0;
for (const [name, from, to] of mutants) {
  if (orig.indexOf(from) < 0) { console.log("TARGET NOT FOUND: " + name); survived++; continue; }
  fs.writeFileSync(path, orig.split(from).join(to));
  const { execSync } = require("child_process");
  let out = "";
  try { out = execSync("node .freebuff/test_store.js", { encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const failed = m ? Number(m[2]) : -1;
  const status = failed > 0 ? "caught (" + failed + " failures)" : "SURVIVED";
  if (failed <= 0) survived++;
  console.log("  " + status.padEnd(22) + name);
}
fs.writeFileSync(path, orig);
console.log(survived === 0 ? "\nall mutants caught" : "\n" + survived + " mutant(s) survived");