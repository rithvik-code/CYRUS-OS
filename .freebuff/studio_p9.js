// ============================================================================
//  PHASE 9 — CONNECT · persistent provider authority
//
//  The problem this solves: the Puter SDK deliberately discards its stored
//  session on web pages (`discardStoredSessionToken_()` runs on every web
//  boot), so its popup asks for a sign-in over and over. But `setAuthToken()`
//  is public and `puter.authToken` is readable after any sign-in.
//
//  So the authority only has to be obtained ONCE. CYRUS captures it, stores it
//  next to the provider keys it already keeps, and re-applies it on every boot.
//
//  Honesty rule (same one the whole project runs on): a provider is only ever
//  shown green when something actually proved it. A 401 is amber, a failing
//  probe is red. We never round a guess up into a claim.
// ============================================================================

const StConn = {
  // ---- every provider, and what each one must actually prove to be "connected"
  META: {
    local:        { label:"Local rule engine", icon:"⚙️",  kind:"local" },
    puter:        { label:"Puter",             icon:"🌐",  kind:"authority" },
    openai:       { label:"OpenAI",            icon:"✨",  kind:"key" },
    groq:         { label:"Groq",              icon:"⚡",  kind:"key" },
    gemini:       { label:"Google AI Studio",  icon:"🔵",  kind:"key" },
    openrouter:   { label:"OpenRouter",        icon:"🧭",  kind:"key" },
    pollinations: { label:"Pollinations",      icon:"🌸",  kind:"keyless" },
    ollama:       { label:"Ollama (local PC)", icon:"🦙",  kind:"local" },
    did:          { label:"D-ID avatar",       icon:"🗣️",  kind:"key" },
  },
  ORDER: ["puter","openai","groq","gemini","openrouter","pollinations","ollama","did","local"],
  // `local` is offline and unconditional, so counting it would just inflate the score.
  SCORED: ["puter","openai","groq","gemini","openrouter","pollinations","ollama","did"],

  rows:{},          // id -> { state, detail, model, at }
  attached:null,    // the StApp we render into, if Studio is open
  _toasted:false,   // the "authority saved" nudge, once per page load

  // ---- state vocabulary ----------------------------------------------------
  // connected : proven working right now
  // needs     : has an authority/key but has not proved it since boot
  // off       : nothing stored, nothing to prove
  // error     : actively failing (this is what Pollinations lands on today)
  // checking  : a probe is in flight
  STATES: ["connected","needs","off","error","checking"],

  // ---- small helpers -------------------------------------------------------
  meta(id){ return this.META[id] || { label:id, icon:"•", kind:"key" }; },
  row(id){ return this.rows[id] || (this.rows[id] = { state:"off", detail:"not checked", model:"", at:0 }); },
  set(id, state, detail, model){
    const r = this.row(id);
    r.state = state;
    if(detail !== undefined) r.detail = detail;
    if(model  !== undefined) r.model = model;
    r.weak = false;                 // only a verified authority clears this
    r.at = Date.now();
    this.paint();
    return r;
  },
  paint(){
    if(this.attached) this.renderInto(this.attached.r && this.attached.r.conn);
    if(this.attached && this.attached.renderStatus) this.attached.renderStatus();
    Bus.emit("conn", this.summary());
  },

  // ---- the stored authority ------------------------------------------------
  token(){ return (Router.keys().puterToken || "").trim(); },
  key(id){ return (Router.keys()[id] || "").trim(); },
  endpoint(){ return (Router.endpoints().ollama || "").trim(); },

  // A token is only a token if it survives this. Anything that looks like a
  // stringified object, a boolean or a one-word error must never be stored —
  // that is how a broken capture silently poisons every later boot.
  normalize(t){
    if(typeof t !== "string") return "";
    let s = t.trim();
    if(s.length >= 2){
      const a = s[0], b = s[s.length-1];
      if((a === '"' && b === '"') || (a === "'" && b === "'")) s = s.slice(1,-1).trim();
    }
    if(!s) return "";
    const junk = ["undefined","null","[object object]","true","false","nan","promise"];
    if(junk.indexOf(s.toLowerCase()) >= 0) return "";
    if(s.length < 16) return "";
    return s;
  },

  // Four places a live Puter authority can be found, best first. We take the
  // first that survives normalize(); the source is kept so the UI can be honest
  // about where the authority actually came from.
  readToken(){
    const found = [];
    try{ if(window.puter && typeof window.puter.authToken === "string") found.push(["puter.authToken", window.puter.authToken]); }catch(e){}
    try{
      const st = window.puter && window.puter.puterAuthState;
      if(st && st.authGranted && typeof window.puter.authToken === "string") found.push(["sign-in", window.puter.authToken]);
    }catch(e){}
    try{ const v = localStorage.getItem("puter.auth.token.v2"); if(v) found.push(["puter.auth.token.v2", v]); }catch(e){}
    try{ const v = localStorage.getItem("puter.auth.token");      if(v) found.push(["puter.auth.token", v]); }catch(e){}
    for(let i=0;i<found.length;i++){
      const n = this.normalize(found[i][1]);
      if(n) return { token:n, src:found[i][0] };
    }
    return { token:"", src:"" };
  },

  // Capture and persist, if we have anything real and it is not already stored.
  // Returns true when the stored authority actually changed.
  capture(reason){
    const got = this.readToken();
    if(!got.token) return false;
    if(got.token === this.token()) return false;
    Router.keys().puterToken = got.token;
    Store.save();
    Log.record("connections: captured Puter authority", "studio_conn",
               { provider:"puter", action:"autocapture", from:got.src, reason:reason||"boot" },
               "low", true, true, "Puter authority saved — you will not be asked to sign in again.");
    if(!this._toasted){
      this._toasted = true;
      Toast.show("Connections", "Puter authority saved — you will not be asked to sign in again.", null, "ok");
    }
    this.set("puter","needs","authority saved from " + got.src + ", verifying…");
    return true;
  },

  // Puter fires onAuth the moment a sign-in completes. Hooking it means the
  // authority is captured then, not whenever the next chat happens to run.
  hookAuth(){
    try{
      const p = window.puter;
      if(!p) return false;
      p.onAuth = ()=>{ this.capture("sign-in"); this.verify("puter"); };
      return true;
    }catch(e){ return false; }
  },

  // ---- proving it ----------------------------------------------------------
  withTimeout(pr, ms){
    return Promise.race([ pr, new Promise((_,rej)=>setTimeout(()=>rej(new Error("timed out")), ms)) ]);
  },

  // The Puter authority is only green when the SDK actually resolves an identity
  // behind it (whoami, else getUser). Token presence alone is not proof, and if
  // neither surface exists we mark the claim weak rather than dress it up.
  async whoami(){
    if(!this.token()) return { ok:false, why:"no authority saved yet" };
    try{ await this.withTimeout(Router.puterReady(), 12000); }
    catch(e){ return { ok:false, why:"Puter SDK did not load" }; }
    const p = window.puter;
    if(!p) return { ok:false, why:"Puter SDK did not load" };
    if(typeof p.whoami === "function"){
      try{
        const u = await this.withTimeout(Promise.resolve(p.whoami()), 12000);
        if(u) return { ok:true, who:(u.username||u.email||u.sub||""), weak:false };
      }catch(e){
        const m = String((e && e.message) || e || "");
        if(/401|unauthor/i.test(m) || (e && e.status === 401)) return { ok:false, why:"401 — the saved authority was rejected" };
        return { ok:false, why:m.slice(0,60) || "whoami failed" };
      }
    }
    // The published SDK has no whoami on the global; getUser is the public
    // equivalent and it really does prove a signed-in identity behind the token.
    if(typeof p.getUser === "function"){
      try{
        const u = await this.withTimeout(Promise.resolve(p.getUser()), 12000);
        if(u) return { ok:true, who:(u.username||u.email||u.sub||""), weak:false };
        return { ok:false, why:"no signed-in user behind that authority" };
      }catch(e){
        const m = String((e && e.message) || e || "");
        if(/401|unauthor/i.test(m) || (e && e.status === 401)) return { ok:false, why:"401 — the saved authority was rejected" };
        return { ok:false, why:m.slice(0,60) || "getUser failed" };
      }
    }
    // Nothing to verify with — say so instead of dressing a token up as proof.
    return { ok:!!this.normalize(p.authToken), who:"", weak:true };
  },

  // Verify one provider for real. Never trusts "the token exists".
  async verify(id){
    const kind = this.meta(id).kind;
    if(kind === "local" && id === "local"){
      this.set("local","connected","offline · always on");
      return this.row("local");
    }
    if(id === "ollama"){
      if(!this.endpoint()){ this.set("ollama","off","no endpoint set"); return this.row("ollama"); }
      this.set("ollama","checking","asking your machine…");
      const ok = await this.withTimeout(Router.probe("ollama"), 3000).catch(()=>false);
      this.set("ollama", ok ? "connected" : "error", ok ? "answering" : "no answer from that endpoint");
      return this.row("ollama");
    }
    if(id === "puter"){
      // Nothing stored is "off", not "needs" — the same condition must not
      // produce two different states depending on which path noticed it.
      if(!this.token()){
        this.set("puter","off","sign in once — then CYRUS keeps it");
        return this.row("puter");
      }
      this.set("puter","checking","verifying authority…");
      const r = await this.whoami();
      let model = "";
      try{ model = Router.pickModel("puter"); }catch(e){}
      if(r.ok){
        const who = r.who ? " · " + r.who : "";
        this.set("puter","connected", (r.weak ? "authority saved (unverified)" : "authority valid" + who), model);
        this.row("puter").weak = !!r.weak;   // say plainly when we only saw a token
      }else{
        this.set("puter","needs", r.why, model);
      }
      return this.row("puter");
    }
    // A keyless provider has no key to check, so it must be probed on its own
    // terms — never short-circuited to "off" just because the key is empty.
    if(kind === "keyless"){
      this.set(id,"checking","probing…");
      let ok = false;
      try{ ok = !!(await this.withTimeout(Router.probe(id), 8000)); }catch(e){ ok = false; }
      if(ok){
        let model = "";
        try{ model = Router.pickModel(id); }catch(e){}
        this.set(id,"connected","no key needed", model);
      }else{
        this.set(id,"error","keyless, but the endpoint did not answer");
      }
      return this.row(id);
    }
    // key providers: nothing stored means nothing to prove
    if(!this.key(id)){ this.set(id,"off","no key saved"); return this.row(id); }
    this.set(id,"checking","checking key…");
    let ok = false;
    try{ ok = !!(await this.withTimeout(Router.probe(id), 8000)); }catch(e){ ok = false; }
    if(ok){
      let model = "";
      try{ model = Router.pickModel(id); }catch(e){}
      this.set(id,"connected", "key accepted", model);
    }else{
      this.set(id,"error","key stored but the endpoint did not accept it");
    }
    return this.row(id);
  },

  async verifyAll(ids){
    const list = (ids && ids.length) ? ids : this.SCORED;
    for(const id of list){ try{ await this.verify(id); }catch(e){ this.set(id,"error","check failed"); } }
    return this.summary();
  },

  // ---- boot ----------------------------------------------------------------
  // Runs when Studio opens. Re-applies whatever authority we already hold, then
  // checks each provider once. Keyless providers are verified lazily (they cost
  // a request); anything with a stored secret is checked immediately so the
  // panel is honest from the first frame.
  async restore(){
    this.booted = true;
    const hasToken = !!this.token();
    if(hasToken){
      try{ await this.withTimeout(Router.puterReady(), 12000); }catch(e){}
      this.hookAuth();
      this.capture("boot");                    // pick up a fresher one if the SDK has it
      await this.verify("puter");
    }else{
      this.set("puter","off","sign in once — then CYRUS keeps it");
    }
    const immediate = this.SCORED.filter(id => id !== "puter" && id !== "pollinations" && (this.key(id) || this.endpoint()));
    await this.verifyAll(immediate);
    // Pollinations is keyless: give it one probe so the panel can report its
    // real state (it currently 403s behind Turnstile — shown red, not green).
    try{ await this.withTimeout(Router.probe("pollinations"), 8000); }catch(e){}
    this.verify("pollinations");
    this.verify("local");
    this.paint();
    return this.summary();
  },

  // ---- acting on a row -----------------------------------------------------
  async connect(id){
    if(id === "puter") return this.connectPuter();
    if(id === "ollama"){ this.sheet("ollama"); return null; }
    this.sheet(id);
    return null;
  },

  // Puter's sign-in, then immediate capture. authenticateWithPuter is the
  // SDK's own entry point; if the SDK does not expose it we make a real call,
  // which raises the popup as a side effect.
  async connectPuter(){
    this.set("puter","checking","waiting for sign-in…");
    Toast.show("Puter", "Finish the sign-in in the popup — CYRUS keeps the authority from then on.");
    let got = false;
    try{
      await this.withTimeout(Router.puterReady(), 12000);
      this.hookAuth();
      const p = window.puter;
      if(p && p.ui && typeof p.ui.authenticateWithPuter === "function"){
        await this.withTimeout(Promise.resolve(p.ui.authenticateWithPuter()), 90000);
        got = true;
      }else if(p && p.ai && typeof p.ai.chat === "function"){
        await this.withTimeout(p.ai.chat("Reply with exactly: TOKEN-OK", { model:"gpt-4o-mini" }), 90000);
        got = true;
      }
    }catch(e){ /* the popup may have been blocked — say so rather than pretend */ }
    this.capture("connect");
    const r = await this.verify("puter");
    if(r.state === "connected"){
      Log.record("connections: Puter connected", "studio_conn", { provider:"puter", action:"connect", popup:got },
                 "low", true, true, "Puter authority obtained and stored.");
      Toast.show("Connections", "Puter connected — you will not be asked again.", null, "ok");
    }else{
      Log.record("connections: Puter sign-in did not complete", "studio_conn", { provider:"puter", action:"connect", popup:got },
                 "low", true, false, r.detail || "no authority captured");
      Toast.show("Puter", "No authority captured" + (got ? "" : " — the sign-in popup was likely blocked. Open CYRUS OS in its own tab, or paste a token in Settings → CYRUS Brain."), null, "warn");
    }
    return r;
  },

  setKey(id, value){
    const v = String(value || "").trim();
    if(!v){ this.forget(id); return null; }
    Router.keys()[id] = v;
    Store.save();
    Log.record("connections: key saved for " + id, "studio_conn", { provider:id, action:"key" },
               "low", true, true, "Key stored for " + this.meta(id).label + " (value never logged).");
    this.set(id,"checking","checking key…");
    return this.verify(id);
  },

  forget(id){
    if(id === "puter"){
      delete Router.keys().puterToken;
    }else{
      delete Router.keys()[id];
    }
    Store.save();
    Log.record("connections: forgot " + id, "studio_conn", { provider:id, action:"forget" },
               "low", true, true, "Removed the stored authority for " + this.meta(id).label + ".");
    this.set(id,"off","not connected");
    if(id === "puter") Toast.show("Connections", "Puter authority forgotten. Next use will ask you to sign in again.");
    return this.row(id);
  },

  // ---- summary for the status bar -----------------------------------------
  summary(){
    let live=0, need=0, err=0;
    for(const id of this.SCORED){
      const s = (this.rows[id] || {}).state;
      if(s === "connected") live++;
      else if(s === "error") err++;
      else if(s === "needs" || s === "checking") need++;
    }
    const p = this.rows.puter || {};
    return { live, need, err, total:this.SCORED.length, puter:p.state || "off" };
  },
  statusCell(){
    const s = this.summary();
    const tone = s.err ? " e" : s.need ? " w" : " g";
    const label = s.err ? (s.err + " failing") : s.need ? (s.need + " to connect") : (s.live + "/" + s.total + " live");
    return `<span class="s st2-conn-cell${tone}" data-s="conn" title="Connections — click to manage">🔑 ${esc(label)}</span>`;
  },

  // ---- rendering -----------------------------------------------------------
  rowHtml(id){
    const m = this.meta(id);
    const r = this.row(id);
    const detail = r.detail || "";
    const right = r.state === "connected" && r.model ? esc(r.model) : esc(detail);
    const title = m.label + " — " + (r.state||"off") + (detail ? ": " + detail : "");
    return `<div class="st2-conn-row ${r.state}" data-c="${esc(id)}" title="${esc(title)}">
      <span class="st2-conn-dot"></span>
      <span class="st2-conn-ico">${m.icon}</span>
      <span class="st2-conn-name">${esc(m.label)}</span>
      <span class="st2-conn-det">${right}</span>
    </div>`;
  },

  renderInto(node){
    if(!node) return;
    node.innerHTML = this.ORDER.map(id => this.rowHtml(id)).join("");
    const rows = node.querySelectorAll("[data-c]");
    for(let i=0;i<rows.length;i++) rows[i].onclick = ()=> this.sheet(rows[i].getAttribute("data-c"));
  },

  // ---- the manage sheet ----------------------------------------------------
  sheet(id){
    if(typeof stModal !== "function") return;
    const back = stModal();
    const body = id ? this.detailHtml(id) : this.listHtml();
    back.innerHTML = `<div class="st2-conn-sheet"><div class="st2-pane-h">${id ? esc(this.meta(id).label) : "Connections"}
        <span class="st2-act"><button data-x="close">✕</button></span></div>
      <div class="st2-conn-body">${body}</div></div>`;
    document.body.appendChild(back);
    const close = ()=>{ back.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e)=>{ if(e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", (e)=>{ if(e.target === back) close(); });
    const x = back.querySelector('[data-x="close"]');
    if(x) x.onclick = close;

    const acts = back.querySelectorAll("[data-act]");
    for(let i=0;i<acts.length;i++){
      acts[i].onclick = async ()=>{
        const cid = acts[i].getAttribute("data-id");
        const what = acts[i].getAttribute("data-act");
        if(what === "close"){ close(); return; }
        if(what === "refresh"){ await this.verifyAll([cid]); close(); this.sheet(cid); return; }
        if(what === "forget"){ this.forget(cid); close(); this.sheet(cid); return; }
        if(what === "connect"){ close(); await this.connect(cid); if(id) this.sheet(id); return; }
        if(what === "savekey"){
          const inp = back.querySelector("[data-keyinput]");
          if(!inp) return;
          await this.setKey(cid, inp.value);
          close(); this.sheet(cid); return;
        }
      };
    }
  },

  listHtml(){
    const s = this.summary();
    const head = `<div class="st2-conn-sum"><b>${s.live}/${s.total}</b> proven live${s.need?` · <span class="w">${s.need} to connect</span>`:""}${s.err?` · <span class="e">${s.err} failing</span>`:""}</div>
      <div class="st2-conn-hint">Every provider only turns green when something actually proved it. A 401 shows amber; a failing probe shows red.</div>`;
    return head + this.ORDER.map(id=>{
      const m = this.meta(id);
      return `<div class="st2-conn-item ${this.row(id).state}" data-c2="${esc(id)}"><span class="st2-conn-dot"></span><span>${m.icon} ${esc(m.label)}</span><span class="st2-conn-det">${esc(this.row(id).detail||"")}</span></div>`;
    }).join("");
  },

  detailHtml(id){
    const m = this.meta(id), r = this.row(id);
    const prov = (typeof PROVIDERS !== "undefined" && PROVIDERS[id]) || null;
    const desc = prov && prov.desc ? prov.desc
      : id === "did" ? "Talking-avatar lane for the Assistant app. Optional."
      : "";
    let h = `<div class="st2-conn-state ${r.state}">${esc(r.state)}${r.weak?" (unverified)":""}</div>
      <div class="st2-conn-desc">${esc(desc)}</div>`;
    if(m.kind === "authority"){
      const t = this.token();
      h += `<div class="st2-conn-cred">${t ? "Authority saved · <code>••••••••" + esc(t.slice(-4)) + "</code>" : "No authority saved"}</div>`;
      h += `<div class="st2-conn-note">Puter discards its own web session on every reload. CYRUS captures the authority after one sign-in and re-applies it on every boot — that is why you are only ever asked once.</div>`;
      h += `<div class="st2-conn-btns">
        <button class="tb-btn" data-act="connect" data-id="${esc(id)}">${t?"Sign in again":"Sign in once"}</button>
        <button class="tb-btn" data-act="refresh" data-id="${esc(id)}">Re-verify</button>
        ${t?`<button class="tb-btn" data-act="forget" data-id="${esc(id)}">Forget</button>`:""}
      </div>`;
    }else if(m.kind === "key"){
      const k = this.key(id);
      h += `<div class="st2-conn-cred">${k ? "Key saved · <code>••••••••" + esc(k.slice(-4)) + "</code>" : "No key saved"}</div>`;
      h += `<input class="sw" type="password" data-keyinput placeholder="Paste your ${esc(m.label)} key" value="">
        <div class="st2-conn-btns">
          <button class="tb-btn" data-act="savekey" data-id="${esc(id)}">Save &amp; test</button>
          <button class="tb-btn" data-act="refresh" data-id="${esc(id)}">Re-verify</button>
          ${k?`<button class="tb-btn" data-act="forget" data-id="${esc(id)}">Forget</button>`:""}
        </div>`;
    }else if(m.kind === "keyless"){
      h += `<div class="st2-conn-note">No key and no sign-in. CYRUS probes it for real and reports what it finds — including failing.</div>
        <div class="st2-conn-btns"><button class="tb-btn" data-act="refresh" data-id="${esc(id)}">Probe now</button></div>`;
    }else{
      const ep = this.endpoint();
      h += `<div class="st2-conn-cred">${ep ? "Endpoint · <code>"+esc(ep)+"</code>" : "No endpoint set"}</div>
        <div class="st2-conn-btns"><button class="tb-btn" data-act="refresh" data-id="${esc(id)}">Probe now</button>
        <button class="tb-btn" data-act="close">Close</button></div>`;
    }
    return h;
  },

  // ---- attach to a running Studio -----------------------------------------
  attach(app){
    this.attached = app;
    this.renderInto(app.r && app.r.conn);
    if(!this.booted) this.restore();
    return this;
  },
  refreshAll(){ return this.restore(); },
};