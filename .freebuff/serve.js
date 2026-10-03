// tiny static server so CYRUS OS can be previewed over http://
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = process.cwd();
const TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css",
                ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".json":"application/json" };
const PORT = Number(process.argv[2] || 8791);
// The service worker must be served from the same directory as the page that
// registers it, or the browser refuses a root scope. The page is served at "/"
// so sw.js and the manifest are aliased to the root too — otherwise the worker
// only ever gets scope "/.freebuff/" and offline never applies to the real page.
const ALIASES = {
  "/": "/.freebuff/cyrus-os.html",
  "/sw.js": "/.freebuff/sw.js",
  "/manifest.webmanifest": "/.freebuff/manifest.webmanifest",
  "/cyrus-os.html": "/.freebuff/cyrus-os.html",
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (ALIASES[p]) p = ALIASES[p];
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
  }
  // Headers must be set before writeHead — Node has already flushed them by
  // the time writeHead returns, and a later setHeader throws
  // ERR_HTTP_HEADERS_SENT, which kills the connection rather than answering.
  const headers = { "Content-Type": TYPES[path.extname(f)] || "text/plain" };
  // The worker controls the root, so it must never be served from a cache.
  if (p.endsWith("sw.js")) headers["Cache-Control"] = "no-cache";
  res.writeHead(200, headers);
  res.end(fs.readFileSync(f));
}).listen(PORT, () => console.log("CYRUS OS on http://localhost:" + PORT));