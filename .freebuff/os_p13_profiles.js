// ============================================================================
//  OS PHASE 13 — DEVICE PROFILES
//  Named local profiles with separate encrypted vaults.
// ============================================================================
//
//  WHAT THIS IS NOT
//  ----------------
//  This is not multi-user, and nothing in the UI is allowed to imply that it is.
//
//  A real OS account means: an identity the machine trusts, permissions enforced
//  by a kernel, a login service, group policy, an audit trail keyed to a person.
//  A web page cannot supply any of that, and pretending otherwise would repeat
//  exactly the mistake this whole file exists to fix.
//
//  So the honest version: several *device-local profiles*, each with its own
//  vault, settings and audit log, unlocked by a passphrase held only by this
//  browser profile. The word "account" does not appear in the UI. The word
//  "user" does not appear either. SysProbe's "System users / permissions" row
//  stays permanently `unavailable`, because it is.
// ============================================================================

const Vaults = {
  // PBKDF2-SHA256, 210k iterations. `iterations` is stored with the payload so
  // a future bump stays readable instead of silently invalidating old vaults.
  ITER: 210000,
  SALT_BYTES: 16,

  async deriveKey(passphrase, salt, iterations){
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      {name:"PBKDF2", salt, iterations, hash:"SHA-256"},
      base,
      {name:"AES-GCM", length:256},
      false,
      ["encrypt","decrypt"]
    );
  },
  toB64(buf){ return btoa(String.fromCharCode(...new Uint8Array(buf))); },
  fromB64(s){ return Uint8Array.from(atob(s), c => c.charCodeAt(0)); },

  available(){ return typeof crypto !== "undefined" && !!(crypto.subtle && crypto.getRandomValues); },

  async encrypt(plaintext, passphrase){
    if(!this.available()) throw new Error("WebCrypto is not available in this browser");
    const salt = crypto.getRandomValues(new Uint8Array(this.SALT_BYTES));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const key  = await this.deriveKey(passphrase, salt, this.ITER);
    const data = new TextEncoder().encode(plaintext);
    const ct   = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, data);
    return JSON.stringify({ v:1, alg:"AES-GCM", kdf:"PBKDF2-SHA256", iterations:this.ITER,
                            salt:this.toB64(salt), iv:this.toB64(iv), data:this.toB64(ct) });
  },

  async decrypt(blob, passphrase){
    if(!this.available()) throw new Error("WebCrypto is not available in this browser");
    const b = JSON.parse(blob);
    if(!b || b.alg !== "AES-GCM") throw new Error("this vault was written by a different scheme");
    const key = await this.deriveKey(passphrase, this.fromB64(b.salt), b.iterations || this.ITER);
    let plain;
    try{
      plain = await crypto.subtle.decrypt({name:"AES-GCM", iv:this.fromB64(b.iv)}, key, this.fromB64(b.data));
    }catch(e){
      // AES-GCM authentication failed. Almost always a wrong passphrase, and
      // saying so is more useful than "operation failed".
      throw new Error("wrong passphrase, or this vault was damaged");
    }
    return new TextDecoder().decode(plain);
  },
};

// ============================================================================
const Profiles = {
  META:"cyrus_profiles_v1",
  active:null,
  _list:[],

  available(){ try{ return !!localStorage; }catch(e){ return false; } },

  list(){
    try{
      const raw = localStorage.getItem(this.META);
      const parsed = raw ? JSON.parse(raw) : null;
      this._list = (parsed && Array.isArray(parsed.profiles)) ? parsed.profiles : [];
    }catch(e){ this._list = []; }
    return this._list;
  },
  _save(){ try{ localStorage.setItem(this.META, JSON.stringify({profiles:this._list, active:this.active})); }catch(e){} },
  get(name){ return this.list().find(p => p.name === name) || null; },

  async create(name, passphrase){
    name = String(name||"").trim();
    if(!name) throw new Error("a profile needs a name");
    if(this.get(name)) throw new Error("a profile called “" + name + "” already exists");
    if(passphrase && !Vaults.available()) throw new Error("this browser has no WebCrypto, so a passphrase cannot be used");
    const p = { name, created:Date.now(), encrypted:!!passphrase, saltHint:null };
    if(passphrase){
      const enc = await Vaults.encrypt(this._emptyVault(), passphrase);
      localStorage.setItem(this._vaultKey(name), enc);
    }else{
      // Stored in plain sight, and the UI says so rather than implying safety.
      localStorage.setItem(this._vaultKey(name), this._emptyVault());
    }
    this.list().push(p);
    this._save();
    return p;
  },

  _emptyVault(){ return JSON.stringify({ vfs:VFS.node("/") || mkDirNode("/",{}), log:[], settings:Store.data.settings || defaultSettings(), notes:{} }); },
  _vaultKey(name){ return "cyrus_vault_" + encodeURIComponent(name); },

  // Unlock writes the vault into the live Store and returns whether it worked.
  async unlock(name, passphrase){
    const p = this.get(name);
    if(!p) return {ok:false, message:"No such profile."};
    const raw = localStorage.getItem(this._vaultKey(name));
    if(raw == null) return {ok:false, message:"That profile has no vault — it may have been removed from this browser."};
    let text = raw;
    if(p.encrypted){
      if(!passphrase) return {ok:false, message:"This profile is encrypted. Enter its passphrase."};
      try{ text = await Vaults.decrypt(raw, passphrase); }
      catch(e){ return {ok:false, message: e.message || "could not unlock that vault"}; }
    }
    let v;
    try{ v = JSON.parse(text); }catch(e){ return {ok:false, message:"That vault is corrupt."}; }
    Store.data.vfs = v.vfs || (VFS.node("/"));
    Store.data.log = Array.isArray(v.log) ? v.log : [];
    Store.data.settings = Object.assign(defaultSettings(), v.settings || {});
    Store.data.notes = v.notes || {};
    // VFS.root must point at the loaded tree or every later read sees the old one.
    VFS.root = Store.data.vfs;
    Store.save();
    this.active = name; this._save();
    return {ok:true, message:"Unlocked “" + name + "”."};
  },

  async saveActive(passphrase){
    const name = this.active;
    if(!name) return {ok:false, message:"no profile is active"};
    const p = this.get(name);
    const plain = JSON.stringify({vfs:VFS.root, log:Store.data.log, settings:Store.data.settings, notes:Store.data.notes});
    try{
      localStorage.setItem(this._vaultKey(name), p.encrypted ? await Vaults.encrypt(plain, passphrase) : plain);
      return {ok:true, message:"Saved."};
    }catch(e){ return {ok:false, message:e.message||String(e)}; }
  },

  remove(name){
    if(!this.get(name)) return false;
    localStorage.removeItem(this._vaultKey(name));
    this._list = this.list().filter(p => p.name !== name);
    if(this.active === name) this.active = null;
    this._save();
    return true;
  },

  // The sentence that keeps this feature honest, shown wherever profiles appear.
  blurb(){
    return "Device profiles. Each has its own files, settings and history, unlocked on this " +
           "browser only. There is no account, no identity and no permission system — CYRUS " +
           "cannot tell who you are, and a profile protects data at rest, not from you.";
  },
};

// ============================================================================
//  UI
// ============================================================================
Apps.register("profiles", {
  title:"Profiles", icon:"👥",
  launch(){
    WM.open({
      id:"cyrus-profiles", title:"Profiles", icon:"👥", w:560, h:520,
      build(win){
        const paint = ()=>{
          const list = Profiles.list();
          win.body.innerHTML = `<div class="cyr-prof">
            <p class="cyr-prof-blurb">${esc(Profiles.blurb())}</p>
            <div class="cyr-prof-list">${list.length ? list.map(p=>`
              <div class="cyr-prof-r">
                <div><b>${esc(p.name)}</b> <span>${p.encrypted ? "🔒 encrypted" : "⚠️ stored in plain text"}</span>
                  <em>created ${new Date(p.created).toLocaleDateString()}${Profiles.active===p.name ? " · active" : ""}</em></div>
                <div class="a"><button class="btn ghost" data-a="switch" data-n="${esc(p.name)}">Switch to</button>
                  <button class="btn danger" data-a="del" data-n="${esc(p.name)}">Delete</button></div>
              </div>`).join("") : `<div class="cyr-prof-empty">No profiles yet. The default desktop is not one — it is just this browser's storage.</div>`}</div>
            <div class="cyr-prof-new">
              <input id="cp-name" placeholder="Profile name" autocomplete="off">
              <input id="cp-pass" type="password" placeholder="Passphrase (optional — without one it is stored in plain text)" autocomplete="new-password">
              <button class="btn primary" id="cp-go">Create</button>
            </div>
            <div class="cyr-prof-note">Lock the screen (Ctrl+Shift+L) to pick a profile.</div>
          </div>`;

          win.body.querySelector("#cp-go").addEventListener("click", async ()=>{
            const n = win.body.querySelector("#cp-name").value.trim();
            const pw = win.body.querySelector("#cp-pass").value;
            try{
              await Profiles.create(n, pw);
              Toast.show("Profiles", "Created “" + n + "”. Switch to it to start using it.", null, "ok");
              paint();
            }catch(e){ Toast.show("Profiles", e.message || String(e), null, "err"); }
          });
          win.body.querySelectorAll("[data-a]").forEach(b=>b.addEventListener("click", async ()=>{
            const n = b.dataset.n;
            if(b.dataset.a === "del"){
              if(!await Modal.confirm({title:"Delete “" + n + "”?", body:"The profile and its vault are removed from this browser. Export a snapshot bundle first if you want a copy.", confirmText:"Delete", danger:true})) return;
              Profiles.remove(n); paint(); return;
            }
            await Profiles.saveActive();
            const r = await Profiles.unlock(n, "");
            if(!r.ok){
              const pw = prompt("“" + n + "” is encrypted.\n\nPassphrase:");
              if(pw == null) return;
              const r2 = await Profiles.unlock(n, pw);
              if(!r2.ok){ Toast.show("Profiles", r2.message, null, "err"); return; }
            }
            Toast.show("Profiles", "Switched to “" + n + "”.", null, "ok");
            WM.close("cyrus-profiles");
            Bus.emit("vfs"); Bus.emit("wm"); Bus.emit("log");
          }));
        };
        paint();
      }
    });
  }
});

// ============================================================================
//  Lock screen → profile picker
// ============================================================================
//  The lock screen is plain markup built at boot, so it can be re-skinned once
//  profiles exist. With no profiles it behaves exactly as before: one name, one
//  button, Enter to log in.
Cyrus.onReady(()=>{
  const list = Profiles.list();
  const card = document.querySelector("#lock-card");
  if(!card) return;

  if(list.length > 1){
    const hint = document.querySelector("#lock-hint");
    if(hint) hint.textContent = "Pick a profile to continue";
    const strip = Cyrus.el("div","cyr-lock-profiles");
    strip.innerHTML = list.map(p=>
      `<button class="cyr-lock-p" data-n="${esc(p.name)}">${esc(p.name)}${p.encrypted? " 🔒":""}</button>`).join("");
    card.insertBefore(strip, document.querySelector("#lock-btn"));
    strip.addEventListener("click", async ev=>{
      const b = ev.target.closest("[data-n]");
      if(!b) return;
      const p = Profiles.get(b.dataset.n);
      let pw = "";
      if(p && p.encrypted){
        pw = prompt("Passphrase for “" + p.name + "”:") || "";
        if(!pw) return;
      }
      const r = await Profiles.unlock(b.dataset.n, pw);
      if(!r.ok){ Toast.show("Profiles", r.message, null, "err"); return; }
      const btn = document.querySelector("#lock-btn");
      if(btn) btn.click();
    });
  }

  // Persist before the tab closes, so an encrypted profile is never left
  // holding the previous vault's contents.
  document.addEventListener("visibilitychange", ()=>{
    if(document.visibilityState === "hidden" && Profiles.active) Profiles.saveActive();
  });
});