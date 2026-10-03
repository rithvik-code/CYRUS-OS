// one-shot: re-apply the --st-mono variable + the studio v2 CSS block + the marker
const fs = require("fs");
const FILE = ".freebuff/cyrus-os.html";
let h = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(".freebuff/_css.txt", "utf8").replace(/\r\n/g, "\n");

function once(needle, insert) {
  const i = h.indexOf(needle);
  if (i < 0) { console.error("ANCHOR MISSING: " + needle.slice(0, 60)); process.exit(1); }
  const at = i + needle.length;
  h = h.slice(0, at) + insert + h.slice(at);
}

if (!h.includes("--st-mono"))
  once("  --radius:12px;\n}", "\n  --st-mono:\"JetBrains Mono\",\"Cascadia Code\",Consolas,\"SF Mono\",Menlo,monospace;\n}");

if (!h.includes("CYRUS STUDIO v2")) {
  const anchor = '.st-status .tb-btn{font-size:11px;padding:3px 10px}\n';
  once(anchor, "\n" + css + "\n");
}

const MARK = "/*STUDIO_INSERT*/";
if (!h.includes(MARK)) {
  const anchor2 = "// --- CYRUS Studio (VS Code + Cursor style IDE: explorer, tabs, runner, AI copilot)\n";
  once(anchor2,
    "// ============================================================================\n" +
    "//  CYRUS STUDIO v2 — the IDE\n" +
    "//  Phase 0  LANG     universal language layer (80+ specs, tokenizer, symbols)\n" +
    "//  Phase 1  EDIT     overlay editor, multi-cursor, find/replace, fold, minimap\n" +
    "//  Phase 2  XPL      explorer with the full file-operation set\n" +
    "//  Phase 3  PROJ     cyrus.project.json — the defined workspace\n" +
    "//  Phase 4  RUN      runner + problems / output / debug panels\n" +
    "//  Phase 5  AI       inline autocomplete + agentic edits with a diff to accept\n" +
    "//  Phase 6  NAV      quick open, goto symbol, references, command palette\n" +
    "//  Phase 7  EXT      extension API with declared capabilities\n" +
    "//  Phase 8  POLISH   settings, status bar, welcome, persistence\n" +
    "// ============================================================================\n" + MARK + "\n\n" + anchor2);
}

fs.writeFileSync(FILE, h);
console.log("prepared:", h.split("\n").length, "lines; css rules:", (h.match(/st2-/g) || []).length);