// ============================================================================
//  OS PHASE 14 — OFFLINE
//  A brain that works with the cable pulled, and an honest reason when it can't.
// ============================================================================
//
//  THE CONSTRAINT THAT DECIDES THIS FILE
//  -------------------------------------
//  Service workers do not register on `file://`. Neither does the install
//  prompt, and OPFS is unreliable there. CYRUS is a single HTML file that most
//  people open by double-clicking, so "add a service worker" is not a feature —
//  it is a decision about which origins get it.
//
//  It gets them where it can work. `node .freebuff/serve.js 8791` serves the
//  same file over http://localhost, which is a secure context, and everything
//  below switches on there. On `file://` nothing is registered, nothing breaks,
//  and the Offline app explains precisely why.
//
//  THE OLLAMA PROBLEM
//  ------------------
//  With the page on http://localhost:8791 and Ollama on http://localhost:11434,
//  the browser treats that as cross-origin. Ollama answers a preflight, refuses
//  it, and `fetch` rejects with an opaque TypeError that is indistinguishable
//  from "Ollama is not running".
//
//  Both states look identical to JavaScript. The only way to tell them apart is
//  to probe the endpoint from a context that is *not* subject to CORS, and the
//  answer is: you cannot, from the page. So this file does the next best thing —
//  it names both causes, says which fix applies to each, and never claims to
//  know which one it was.
// ============================================================================

const Offline = {
  // Served from the site root by serve.js, because a service worker's default
  // scope is its own directory and the page that registers it lives at "/".
  swUrl:"/sw.js",
  manifestUrl:"/manifest.webmanifest",
  reg:null,
  installed:false,
  reason:"",
  // Cross-origin needs a server. file:// gets neither of these.
  canRegister(){
    return typeof navigator!=="undefined" && "serviceWorker" in navigator &&
           /^https?:$/.test(location.protocol);
  },

  async register(){
    if(!this.canRegister()){
      this.reason = location.protocol === "file:"
        ? "This page is open as file://, where browsers do not allow service workers."
        : "This browser does not support service workers.";
      return {ok:false, reason:this.reason};
    }
    // The manifest is injected from JS rather than sitting in <head>, because
    // the build restores the HTML from HEAD — a hand-edited <link> would be
    // erased on the next `node .freebuff/rebuild.js`. On file:// the href is
    // null so no pointless request is made.
    if(!document.querySelector('link[rel="manifest"]')){
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = this.canRegister() ? this.manifestUrl : "";
      if(link.href) document.head.appendChild(link);
    }
    try{
      this.reg = await navigator.serviceWorker.register(this.swUrl, {scope:"./"});

      // On a FIRST visit there is nothing active yet: the worker is still
      // installing and reg.active is null. Reading the state only once left
      // the panel saying "Registering…" forever even though the worker came
      // active a moment later, so activation is tracked as it happens.
      this.installed = !!this.reg.active;
      this._watch(this.reg.active);
      this._watch(this.reg.installing);
      this._watch(this.reg.waiting);

      // A stale worker from an earlier visit serves an older CYRUS. Say so
      // rather than letting the user debug phantom behaviour.
      this.reg.addEventListener("updatefound", ()=>{
        const w = this.reg.installing;
        if(!w) return;
        w.addEventListener("statechange", ()=>{
          if(w.state === "installed" && navigator.serviceWorker.controller){
            Toast.show("Offline","A new version of CYRUS is ready. Close every CYRUS tab to switch over.",null,"warn");
          }
        });
      });

      return {ok:true, state:this.reg.active ? "active" : (this.reg.installing ? "installing" : "waiting")};
    }catch(e){
      this.reason = e.message || String(e);
      return {ok:false, reason:this.reason};
    }
  },

  // Follow a worker's lifecycle and reflect it in the panel. A worker that
  // reaches "activated" means offline really is available from now on.
  _watch(worker){
    if(!worker || worker.__cyrusWatched) return;
    worker.__cyrusWatched = true;
    worker.addEventListener("statechange", ()=>{
      if(worker.state === "activated"){
        this.installed = true;
        this.reason = "";
      }else if(worker.state === "redundant"){
        this.installed = false;
      }
      Bus.emit("cyrus:offline");   // the Offline window repaints on this
    });
  },

  // What "offline" actually means here, stated by what is cached and what is not.
  coverage(){
    return [
      { what:"The CYRUS shell (this HTML file)", when:"cached after the first load", ok:this.installed },
      { what:"Your files, settings and audit log", when:"always local — never needs a network", ok:true },
      { what:"Local model (Ollama)", when:"works offline, if the endpoint allows this origin", ok:null },
      { what:"Puter, Groq, Gemini, OpenRouter, Pollinations", when:"cloud — these need a network and will say so", ok:false },
      { what:"Web search", when:"needs a network", ok:false },
    ];
  },
};

// ============================================================================
//  Ollama CORS diagnosis
// ============================================================================
//  Replaces the old probe's single red "no answer from that endpoint".
const OllamaDiag = {
  // Ollama has to opt in to a browser origin with OLLAMA_ORIGINS. Without it
  // the reply is a preflight failure that fetch() reports as a bare TypeError.
  corsHint(){
    const origin = location.origin === "null" ? "(file:// — no origin, always refused)" : location.origin;
    return origin;
  },
  fix(){
    return process_free_text(
      "Ollama is on port 11434 and your page is on " + this.corsHint() +
      ". These are different origins, so the browser sends a preflight and Ollama" +
      " refuses it unless you name the page explicitly.\n\n" +
      "  # in the shell Ollama is running in, before starting it:\n" +
      "  export OLLAMA_ORIGINS='" + this.corsHint() + "'\n" +
      "  ollama serve\n\n" +
      "On Windows PowerShell:\n" +
      "  $env:OLLAMA_ORIGINS='" + this.corsHint() + "'; ollama serve\n\n" +
      "Or set it to '*' if this machine is yours alone — that lets any page" +
      " reach your model, which is a real trade-off and not a recommendation."
    );
  },

  // A single request cannot separate "not running" from "refused". So try the
  // endpoint three ways and report what is actually distinguishable.
  async diagnose(endpoint){
    const url = String(endpoint||"").replace(/\/v1\/chat\/completions\/?$/,"");
    if(!url) return {state:"no-endpoint", text:"No endpoint set. Settings → CYRUS Brain → Ollama."};

    // 1. A plain no-cors probe: opaque either way, but a *network-level*
    //    failure (nothing listening) rejects, while a server that answers with
    //    a CORS error resolves opaquely. That difference is real and usable.
    let reachable = null;
    try{ await fetch(url + "/api/tags", {mode:"no-cors", cache:"no-store"}); reachable = true; }
    catch(e){ reachable = false; }

    if(!reachable){
      return {
        state:"unreachable",
        text:"Nothing answered at " + url + ".\n\n" +
             "  · Is Ollama running?  `ollama serve`, then `ollama pull qwen2.5:3b`\n" +
             "  · Is it on another port? Check with `ollama list` or the terminal's `netstat`\n" +
             "  · Did you mean your cloud providers? The AI Router tries those first anyway."
      };
    }

    // 2. Something is listening. Now the only likely cause left is the origin.
    let cors = false, body = null;
    try{
      const r = await fetch(url + "/api/tags", {cache:"no-store"});
      cors = true;
      try{ body = await r.json(); }catch(e){}
    }catch(e){ cors = false; }

    if(cors) return {state:"ok", text:"Connected — " + ((body && body.models && body.models.length) ? body.models.length + " model(s) installed" : "reachable, but no models pulled yet (`ollama pull qwen2.5:3b`)"), models:(body&&body.models||[]).map(m=>m.name)};

    return {
      state:"cors",
      text:"Ollama is running and CYRUS reached it, but the browser blocked the reply.\n\n" +
           "Your page is a different origin from Ollama, and Ollama has not been told to allow it.\n\n" + this.fix(),
      hint:this.fix()
    };
  },
};
function process_free_text(s){ return s; } // kept as a seam for future locale work

// ============================================================================
//  UI
// ============================================================================
Apps.register("offline", {
  title:"Offline", icon:"📴",
  launch(){
    WM.open({
      id:"cyrus-offline", title:"Offline", icon:"📴", w:580, h:500,
      build(win){
        const paint = async ()=>{
          const rows = Offline.coverage();
          const ep = (typeof Router!=="undefined" && Router.endpoints) ? (Router.endpoints().ollama||"") : "";
          win.body.innerHTML = `<div class="cyr-off">
            <div class="cyr-off-h ${Offline.canRegister()? (Offline.installed?"ok":"warn") : "warn"}">
              ${Offline.canRegister()
                ? (Offline.installed ? "✓ Offline shell is active" : "◷ Registering the offline shell…")
                : "✗ Offline is unavailable on this origin"}
            </div>
            <p class="cyr-off-why">${esc(Offline.reason || (Offline.canRegister()
              ? "CYRUS is served over http, so it can install a service worker and run with no network."
              : "Open CYRUS over http to enable offline: `node .freebuff/serve.js 8791` then visit http://localhost:"+ (location.port||"8791") +". A file:// tab cannot register a service worker — that is a browser rule, not a CYRUS setting."))}</p>
            <div class="cyr-off-list">${rows.map(r=>`
              <div class="cyr-off-r ${r.ok===true?"ok":r.ok===false?"no":"maybe"}">
                <div class="w">${esc(r.what)}</div>
                <div class="v">${r.ok===true?"✓ works offline":r.ok===false?"✕ needs a network":"~ depends on setup"}</div>
                <div class="n">${esc(r.when)}</div></div>`).join("")}</div>
            <div class="cyr-off-sec">
              <h4>Local model check</h4>
              <div class="cyr-off-end">${esc(ep || "no endpoint set")}</div>
              <button class="btn ghost" id="co-check">Check</button>
              <pre class="cyr-off-out" id="co-out">—</pre>
            </div>
          </div>`;
          win.body.querySelector("#co-check").addEventListener("click", async ()=>{
            const out = win.body.querySelector("#co-out");
            out.textContent = "asking " + (ep||"nothing") + " …";
            const d = await OllamaDiag.diagnose(ep);
            out.textContent = "[" + d.state + "]\n\n" + d.text;
          });
        };
        paint();
      },
    });
  }
});

Cyrus.onReady(()=>{ Offline.register(); });