// splice a studio chunk file into cyrus-os.html at the /*STUDIO_INSERT*/ marker
// NOTE: the replacement MUST be a function — the inserted code contains regex
// replacement strings like "$&" and "$'" which String.replace would expand.
const fs = require("fs");
const { execSync } = require("child_process");
const [, , chunkPath] = process.argv;
const FILE = ".freebuff/cyrus-os.html";
const html = fs.readFileSync(FILE, "utf8");
const MARK = "/*STUDIO_INSERT*/";
if (!html.includes(MARK)) { console.error("MARKER MISSING"); process.exit(1); }
if (html.indexOf(MARK) !== html.lastIndexOf(MARK)) { console.error("MARKER DUPLICATED"); process.exit(1); }
const chunk = fs.readFileSync(chunkPath, "utf8");
fs.writeFileSync(FILE, html.replace(MARK, () => chunk + "\n" + MARK));
console.log("spliced " + chunkPath + " (" + chunk.split("\n").length + " lines)");

const out = fs.readFileSync(FILE, "utf8");
const blocks = [...out.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let bad = 0;
blocks.forEach((b, i) => {
  const tmp = ".freebuff/_chk" + i + ".js";
  fs.writeFileSync(tmp, b);
  try { execSync("node --check " + tmp, { stdio: "pipe" }); fs.unlinkSync(tmp); }
  catch (e) { bad++; console.log("SYNTAX ERROR in block " + i + ":\n" + (e.stderr || e.message).toString().slice(0, 900)); }
});
console.log(bad ? "FAILED" : "ALL SCRIPT BLOCKS OK (" + blocks.length + ")");
process.exit(bad ? 1 : 0);