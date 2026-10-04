// Mutation check for phase 18 (OS-state inspector + result envelope).
const fs = require("fs");
const { execSync } = require("child_process");
const path = ".freebuff/os_p18_context.js";
const orig = fs.readFileSync(path, "utf8");

const mutants = [
  ["the default snapshot leaks file contents",
   "if(opts.body && snap.editor && snap.editor.activeFile){",
   "if(snap.editor && snap.editor.activeFile){"],
  ["the body cap is removed",
   "snap.editor.body = String(text == null ? \"\" : text).slice(0, this.MAX_BODY);",
   "snap.editor.body = String(text == null ? \"\" : text);"],
  ["truncation is no longer reported",
   "snap.editor.bodyTruncated = !!(text && String(text).length > this.MAX_BODY);",
   "snap.editor.bodyTruncated = false;"],
  ["a throwing editor takes the caller down",
   "}catch(e){ return null; }\n  },\n\n  // ---- system",
   "}\n  },\n\n  // ---- system"],
  ["system figures are invented when nothing was probed",
   "return { probed:false, note:\"No probe has run yet — open the System app for real figures.\", metrics:{} };",
   "return { probed:true, note:\"probed\", metrics:{ RAM:{ value:\"8/16 GB\", provenance:\"measured\" } } };"],
  ["provenance is dropped from measurements",
   "metrics[String(r.label)] = { value:r.value, provenance:r.provenance || \"unknown\", group:r.group || \"\" };",
   "metrics[String(r.label)] = { value:r.value, group:r.group || \"\" };"],
  ["directory changes stop being detected",
   "m.set(p, n.type + \":\" + (n.size || 0) + \":\" + (n.mtime || 0));",
   "if(n.type === \"file\") m.set(p, n.type + \":\" + (n.size || 0) + \":\" + (n.mtime || 0));"],
  ["a thrown action is reported as success",
   "const status = error ? \"error\" : (r && r.blocked) ? \"refused\" : ok ? \"success\" : \"failed\";",
   "const status = \"success\";"],
  ["changed files are always empty",
   "changed_files: changed.slice(0, 50),",
   "changed_files: [],"],
  ["an action that changed nothing claims to be undoable",
   "undoable: changed.length > 0,",
   "undoable: true,"],
  ["focus reports a closed window as focused",
   "if(win && WM.wins.has(win.id)) return win;\n      return null;",
   "return win;"],
];

let survived = 0;
for (const [name, from, to] of mutants) {
  if (orig.indexOf(from) < 0) { console.log("  TARGET NOT FOUND      " + name); survived++; continue; }
  fs.writeFileSync(path, orig.split(from).join(to));
  let out = "";
  try { out = execSync("node .freebuff/test_osstate.js", { encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const failed = m ? Number(m[2]) : 999;
  if (failed <= 0) survived++;
  console.log("  " + (m ? ("caught (" + failed + ")") : "caught (crashed)").padEnd(16) + name);
}
fs.writeFileSync(path, orig);
console.log(survived === 0 ? "\nall mutants caught" : "\n" + survived + " mutant(s) survived");