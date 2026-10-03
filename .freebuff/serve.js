// tiny static server so CYRUS OS can be previewed over http://
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = process.cwd();
const TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css",
                ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".json":"application/json" };
const PORT = Number(process.argv[2] || 8791);
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/.freebuff/cyrus-os.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "text/plain" });
  res.end(fs.readFileSync(f));
}).listen(PORT, () => console.log("CYRUS OS on http://localhost:" + PORT));