// Compile every symbol-regex literal in the Studio chunks and fail the build if
// any of them is invalid. A malformed rule used to fail silently at runtime —
// SYM only logs a console.warn and drops the rule, so a language quietly lost
// its outline and it was easy to miss.
//   node .freebuff/validate_regex.js
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname);
const files = fs.readdirSync(dir).filter(f => /^studio_p.*\.js$/.test(f));

// Symbol rules are the  ["kind","<regex>",<group>]  tuples in the SYM tables.
const RULE = /\[\s*"(?:cls|fn|int|var|const|typ|opn|cbl|mod|tag|attr|key|sec|hook|macro)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;

let checked = 0, bad = 0;
for(const f of files){
  const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
  let m;
  RULE.lastIndex = 0;
  while((m = RULE.exec(src))){
    // the literal in the file still has its escaping intact; re-decode it once
    const literal = m[1].replace(/\\(["'\\])/g, "$1");
    checked++;
    try{ new RegExp(literal, "gm"); }
    catch(e){
      bad++;
      const line = src.slice(0, m.index).split("\n").length;
      console.error(`  ${f}:${line}  ${e.message}\n    ${literal}`);
    }
  }
}
console.log(`symbol regexes: ${checked} checked, ${bad} invalid`);
process.exit(bad ? 1 : 0);