/* CYRUS offline shell.
 *
 * Served from the site root (serve.js aliases /sw.js here) because a service
 * worker's default scope is its own directory. Registered from the page at "/",
 * it therefore needs to live at "/" to be allowed to control "/".
 *
 * The only thing worth caching is the OS itself. The AI Router's endpoints must
 * never be cached — a cached model reply outliving the network it came from is
 * a brain answering from stale fiction, which is the one failure this project
 * cares most about avoiding.
 *
 * On file:// none of this registers at all. See os_p14_offline.js for why.
 */
const CACHE = "cyrus-shell-v1";
// Absolute, because this file is served from "/" but is also cached and
// replayed for navigations to "/" — relative paths would resolve against "/".
const SHELL_DOC = "/";
const SHELL = ["/", "/manifest.webmanifest"];

function isAPIRequest(req){
  const u = new URL(req.url);
  // Ollama and the bridge are loopback. Never cached: a stale model reply or a
  // stale file listing is worse than no answer.
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  return /\/api\/(chat|completions|generate|tags|embed)|generateContent|\/v1\/|\/chat\/completions/.test(u.pathname + u.search);
}

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  if(isAPIRequest(req)) return;   // straight to the network, every time

  if(req.mode === "navigate"){
    // Network first so a rebuilt CYRUS is picked up immediately; the cache is
    // the floor, not the source of truth. An old cached shell that outranks
    // the network would be a bug report nobody could reproduce.
    e.respondWith((async () => {
      try{
        const net = await fetch(req);
        if (net && net.ok) {
          const c = await caches.open(CACHE);
          c.put(SHELL_DOC, net.clone());
        }
        return net;
      }catch(err){
        const hit = await caches.match(SHELL_DOC);
        if (hit) return hit;
        return new Response("<h1>CYRUS is offline</h1><p>Open it once with a network connection first.</p>",
                            {status:503, headers:{"Content-Type":"text/html"}});
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try{
      const net = await fetch(req);
      if (net && net.ok && new URL(req.url).origin === self.location.origin){
        const c = await caches.open(CACHE);
        c.put(req, net.clone());
      }
      return net;
    }catch(err){ return Response.error(); }
  })());
});