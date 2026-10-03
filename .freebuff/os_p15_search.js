// ============================================================================
//  OS PHASE 15 — SEARCH
//  Full-content index, ranked with BM25. Offline, no dependencies.
// ============================================================================
//
//  WHY THIS FILE EXISTS
//  --------------------
//  CYRUS could already "search". `scoreSearch()` walked the filesystem and
//  scored NAMES. That is why the README said search was over filenames and
//  paths: it was. Asking "find every file mentioning recursion that I edited
//  this month" returned nothing, because no file was ever opened to look.
//
//  This indexes CONTENTS. The structure is an inverted index — term -> posting
//  list of (path, term frequency) — scored with Okapi BM25, which is what makes
//  a rare term outrank a common one instead of everything matching "the" tying.
//
//  HONEST NAMING: THIS IS LEXICAL, NOT NEURAL
//  ------------------------------------------
//  The native layer (cyrus/cyrus/indexer.py) embeds sentences with
//  sentence-transformers and searches by meaning. A page cannot run that model
//  offline. So this is BM25 over stemmed tokens: it finds "recursion" in a file
//  that never uses the word "recursive", but it does not find "recursion" in a
//  file that only says "the function calls itself". Calling this "semantic"
//  would be exactly the kind of claim this project does not make. The UI labels
//  it "BM25 (lexical, offline)"; meaning-based search stays on the native side.
//
//  INCREMENTAL BY DEFAULT
//  ----------------------
//  A full reindex on every save would make the OS feel broken, so each document
//  carries an (mtime, size, hash) fingerprint and only changed files are re-read.
//  The index is persisted to IndexedDB so a reload does not re-walk the disk.
const SearchIndex = {
  DB:"cyrus_search_v1",
  terms:new Map(),    // term -> Map(path -> tf)
  docs:new Map(),     // path  -> {len, mtime, size, ext, name, hash}
  avgLen:0,
  built:false, building:false, dirty:false, lastBuild:0, scanned:0,
  K1:1.4, B:0.72,    // Okapi BM25 defaults; B is how much doc length is penalised

  // ---- tokenizer ----------------------------------------------------------
  STOP:new Set(("a an and are as at be but by for from has have if in into is it its of on " +
                "or that the their then there these they this to was were will with you your").split(" ")),

  tokenize(s){
    const raw = String(s == null ? "" : s).toLowerCase().match(/[a-z0-9_]+/g);
    if(!raw) return [];
    const out = [];
    for(const w of raw){
      if(w.length < 2 || this.STOP.has(w)) continue;
      out.push(this.stem(w));
    }
    return out;
  },

  // A deliberately small stemmer. It does not need to be linguistically
  // correct; it needs to make "recursion"/"recursive"/"recursing" collide
  // without mangling unrelated words.
  stem(w){
    if(w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if(w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
    // -ion / -ive must reach the same root as -ing, or "recursion",
    // "recursive" and "recursing" never collide — which is the one job this
    // stemmer has. Without these two rules it silently failed at exactly the
    // example the phase exists to handle.
    if(w.length > 5 && w.endsWith("ion")) return w.slice(0, -3);
    if(w.length > 5 && w.endsWith("ive")) return w.slice(0, -3);
    if(w.length > 4 && w.endsWith("ed"))  return w.slice(0, -2);
    if(w.length > 4 && w.endsWith("es"))  return w.slice(0, -2);
    if(w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
    return w;
  },

  hash(s){
    s = String(s == null ? "" : s);
    let h = 0x811c9dc5;
    for(let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
    return h.toString(16);
  },

  // ---- index maintenance --------------------------------------------------
  addDoc(path, content, meta){
    this.removeDoc(path);
    const toks = this.tokenize(content);
    const doc = {
      len: toks.length, mtime: meta.mtime || 0, size: meta.size || 0,
      ext: meta.ext || "", name: meta.name || VFS.base(path), hash: this.hash(content),
    };
    this.docs.set(path, doc);
    if(!toks.length) return doc;
    const tf = new Map();
    for(const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for(const [t, n] of tf){
      if(!this.terms.has(t)) this.terms.set(t, new Map());
      this.terms.get(t).set(path, n);
    }
    return doc;
  },

  removeDoc(path){
    if(!this.docs.has(path)) return false;
    for(const [t, p] of Array.from(this.terms)){
      p.delete(path);
      if(!p.size) this.terms.delete(t);
    }
    this.docs.delete(path);
    return true;
  },

  // Every readable file CYRUS can see: the virtual disk plus any real mount.
  sources(){
    const out = [];
    for(const f of VFS.allFiles()){
      const n = f.node;
      if(n && n.content != null && String(n.content).length)
        out.push({path:f.path, content:String(n.content), mtime:n.mtime, size:n.size, ext:n.ext, name:n.name});
    }
    if(typeof Mnt !== "undefined"){
      for(const m of Mnt.list()){
        if(!m.ready) continue;
        const walk = (node, base) => {
          for(const child of Object.values(node.children || {})){
            const p = base === "/" ? "/" + child.name : base + "/" + child.name;
            if(child.type === "dir") walk(child, p);
            else if(child.content != null && String(child.content).length)
              out.push({path:p, content:String(child.content), mtime:child.mtime, size:child.size, ext:child.ext, name:child.name});
          }
        };
        walk(m.tree, "/");
      }
    }
    return out;
  },

  async build(force){
    if(this.building) return this;
    if(this.built && !this.dirty && !force) return this;
    this.building = true;
    try{
      const srcs = this.sources();
      let changed = 0;
      for(const s of srcs){
        const prev = this.docs.get(s.path);
        const h = this.hash(s.content);
        // The whole point of the fingerprint: an unchanged file is not re-read.
        if(!force && prev && prev.hash === h && prev.mtime === s.mtime && prev.size === s.size) continue;
        this.addDoc(s.path, s.content, s);
        changed++;
      }
      // Drop documents whose file disappeared while we were not looking.
      const live = new Set(srcs.map(s => s.path));
      for(const p of Array.from(this.docs.keys())) if(!live.has(p)) this.removeDoc(p);

      let total = 0;
      for(const d of this.docs.values()) total += d.len;
      this.avgLen = this.docs.size ? total / this.docs.size : 0;
      this.scanned = srcs.length; this.built = true; this.dirty = false; this.lastBuild = Date.now();
      this.persist();
      Cyrus.audit("search index", "search_index", {scanned:srcs.length, changed}, "low", true, true,
                  "Indexed " + srcs.length + " file(s); " + changed + " new or changed.");
      return this;
    } finally { this.building = false; }
  },

  invalidate(){ this.dirty = true; },

  // ---- persistence --------------------------------------------------------
  persist(){
    if(typeof indexedDB === "undefined") return;
    try{
      const req = indexedDB.open(this.DB, 1);
      req.onupgradeneeded = ()=>{ if(!req.result.objectStoreNames.contains("ix")) req.result.createObjectStore("ix",{keyPath:"k"}); };
      req.onsuccess = ()=>{
        const db = req.result;
        db.transaction("ix","readwrite").objectStore("ix").put({
          k:"main", saved:Date.now(),
          terms:[...this.terms].map(([t,p])=>[t,[...p]]),
          docs:[...this.docs], avgLen:this.avgLen,
        });
      };
    }catch(e){ console.error("[search] persist failed", e); }
  },

  restore(){
    if(typeof indexedDB === "undefined") return Promise.resolve(false);
    return new Promise(res=>{
      let req;
      try{ req = indexedDB.open(this.DB, 1); }catch(e){ res(false); return; }
      req.onupgradeneeded = ()=>{ if(!req.result.objectStoreNames.contains("ix")) req.result.createObjectStore("ix",{keyPath:"k"}); };
      req.onsuccess = ()=>{
        const db = req.result;
        let got;
        try{ got = db.transaction("ix","readonly").objectStore("ix").get("main"); }catch(e){ res(false); return; }
        got.onsuccess = ()=>{
          const v = got.result;
          if(!v || !v.terms){ res(false); return; }
          this.terms = new Map(v.terms.map(([t,p])=>[t,new Map(p)]));
          this.docs = new Map(v.docs);
          this.avgLen = v.avgLen || 0;
          this.built = true; this.dirty = false;
          res(true);
        };
        got.onerror = ()=>res(false);
      };
      req.onerror = ()=>res(false);
    });
  },

  // ---- query --------------------------------------------------------------
  // opts: {ext, sinceDays, path (prefix), limit, phrase}
  query(q, opts){
    opts = opts || {};
    const terms = this.tokenize(q);
    if(!terms.length) return [];
    const N = this.docs.size || 1;
    const scores = new Map();

    for(const t of terms){
      const post = this.terms.get(t);
      if(!post) continue;
      const df = post.size;
      // BM25 IDF with the +1 guard so a term in every document still scores
      // slightly positive instead of going negative and cancelling real hits.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for(const [path, tf] of post){
        const doc = this.docs.get(path);
        if(!doc) continue;
        const avg = this.avgLen || 1;
        const denom = tf + this.K1 * (1 - this.B + this.B * (doc.len / avg));
        scores.set(path, (scores.get(path) || 0) + idf * ((tf * (this.K1 + 1)) / denom));
      }
    }

    // A quoted phrase must actually appear as text, not merely as a bag of
    // stems — otherwise "end of line" ranks every file containing line and end.
    const phrase = opts.phrase ? String(opts.phrase).toLowerCase().trim() : null;
    const now = Date.now();
    const out = [];
    for(const [path, score] of scores){
      const doc = this.docs.get(path);
      if(!doc) continue;
      if(opts.ext && doc.ext !== String(opts.ext).toLowerCase().replace(/^\./,"")) continue;
      if(opts.path && !path.toLowerCase().startsWith(String(opts.path).toLowerCase())) continue;
      if(opts.sinceDays){
        const cut = now - (opts.sinceDays * 86400000);
        if((doc.mtime || 0) < cut) continue;
      }
      if(phrase){
        const node = VFS.node(path);
        const text = node && node.content != null ? String(node.content).toLowerCase() : "";
        if(!text.includes(phrase)) continue;
      }
      out.push({path, score, doc, why:this.explain(terms, path)});
    }
    out.sort((a, b) => b.score - a.score || (b.doc.mtime || 0) - (a.doc.mtime || 0));
    return out.slice(0, opts.limit || 40);
  },

  // Why did this match? Named terms, not a mystery number.
  explain(terms, path){
    const hits = [];
    for(const t of terms){ const p = this.terms.get(t); if(p && p.has(path)) hits.push(t); }
    return hits.join(" ");
  },

  // A real snippet: the densest window of matching lines, not the first hit.
  snippet(path, q, width){
    width = width || 3;
    const node = VFS.node(path);
    const body = node && node.content != null ? String(node.content) : "";
    if(!body) return "";
    const terms = this.tokenize(q).filter(t => t.length > 2);
    const lines = body.split("\n");
    if(!terms.length) return lines.slice(0, width).join("\n").slice(0, 300);
    let best = -1, bestScore = -1;
    for(let i = 0; i < lines.length; i++){
      const lo = lines[i].toLowerCase();
      let s = 0;
      for(const t of terms){
        // Match the stem back to the surface form so the window is accurate.
        const re = new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\w{0,3}", "gi");
        const m = lo.match(re);
        if(m) s += m.length;
      }
      if(s > bestScore){ bestScore = s; best = i; }
    }
    if(best < 0) return lines.slice(0, width).join("\n").slice(0, 300);
    return lines.slice(Math.max(0, best - 1), best + width).join("\n").slice(0, 400);
  },

  stats(){
    return { docs:this.docs.size, terms:this.terms.size, avgLen:Math.round(this.avgLen),
             built:this.built, lastBuild:this.lastBuild, scanned:this.scanned,
             engine:"BM25 (lexical, offline)" };
  },
};

// Keep the index fresh without re-walking on every write.
if(typeof Bus !== "undefined") Bus.on("vfs", ()=>{ SearchIndex.invalidate(); });
if(typeof Mnt !== "undefined") Mnt.onChange(()=>{ SearchIndex.invalidate(); });

// ---- the Search app --------------------------------------------------------
Apps.register("search", {
  title:"Search", icon:"🔎",
  launch(){
    WM.open({
      id:"cyrus-search", title:"Search", icon:"🔎", w:720, h:560,
      build(win){
        win.body.innerHTML = `<div class="cyr-search">
          <div class="cyr-search-bar">
            <input id="cs-q" placeholder="Search inside every file — try: recursion" autocomplete="off">
            <select id="cs-ext"><option value="">any type</option></select>
            <select id="cs-when">
              <option value="">any time</option>
              <option value="7">last 7 days</option>
              <option value="30">last 30 days</option>
              <option value="90">last 90 days</option>
            </select>
            <button class="btn ghost" id="cs-rebuild">Reindex</button>
          </div>
          <div class="cyr-search-note" id="cs-note">indexing…</div>
          <div class="cyr-search-out" id="cs-out"></div>
        </div>`;

        const q    = win.body.querySelector("#cs-q");
        const ext  = win.body.querySelector("#cs-ext");
        const when = win.body.querySelector("#cs-when");
        const out  = win.body.querySelector("#cs-out");
        const note = win.body.querySelector("#cs-note");

        // Offer the extensions actually present, rather than a fixed list.
        const exts = {};
        for(const d of SearchIndex.docs.values()) if(d.ext) exts[d.ext] = (exts[d.ext] || 0) + 1;
        for(const [e, n] of Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 12)){
          const o = win.body.ownerDocument.createElement("option");
          o.value = e; o.textContent = "." + e + " (" + n + ")";
          ext.appendChild(o);
        }

        const paint = async ()=>{
          await SearchIndex.build();
          const s = SearchIndex.stats();
          note.textContent = s.docs + " files · " + s.terms.toLocaleString() + " terms · " + s.engine +
                             (s.lastBuild ? " · indexed " + new Date(s.lastBuild).toLocaleTimeString() : "");
          if(!q.value.trim()){ out.innerHTML = ""; return; }
          const phrase = /"([^"]+)"/.exec(q.value);
          const text = q.value.replace(/"[^"]+"/g, "").trim() || (phrase ? phrase[1] : q.value);
          const hits = SearchIndex.query(text, {
            ext: ext.value, sinceDays: when.value ? Number(when.value) : 0,
            phrase: phrase ? phrase[1] : null, limit: 50,
          });
          if(!hits.length){
            out.innerHTML = `<div class="cyr-search-empty">Nothing inside any indexed file matched <b>${esc(q.value)}</b>.</div>`;
            return;
          }
          out.innerHTML = hits.map(h=>`
            <div class="cyr-search-r" data-p="${esc(h.path)}">
              <div class="h"><span class="f">${esc(h.doc.name)}</span><span class="p">${esc(h.path.replace("/home/rithvik","~"))}</span></div>
              <div class="m">matched ${esc(h.why)} · ${h.doc.len} tokens · ${fmtSize(h.doc.size)}</div>
              <pre class="s">${esc(SearchIndex.snippet(h.path, text, 3))}</pre>
            </div>`).join("");
          out.querySelectorAll(".cyr-search-r").forEach(r=>r.addEventListener("click", ()=>{
            const p = r.dataset.p;
            if(VFS.node(p)) Apps.open("editor", p); else Apps.open("files", p);
          }));
        };

        let t = null;
        q.addEventListener("input", ()=>{ clearTimeout(t); t = setTimeout(paint, 180); });
        ext.addEventListener("change", paint);
        when.addEventListener("change", paint);
        win.body.querySelector("#cs-rebuild").addEventListener("click", async ()=>{
          await SearchIndex.build(true); paint();
        });
        paint();
      },
    });
  }
});

// ---- wire the existing `search_files` intent to the real index -------------
// SCHEMAS / Actions are declared after this splice point, so this patches from
// onReady. The intent is already whitelisted and risk-low; this changes what it
// actually does, not whether it is allowed to.
Cyrus.onReady(async ()=>{
  if(typeof Actions === "undefined" || !Actions.search_files) return;
  await SearchIndex.restore().catch(()=>false);
  Actions.search_files = async function(f){
    await SearchIndex.build();
    const text = String(f.query || "").trim();
    if(!text) return {ok:false, message:"Search needs something to look for."};
    const hits = SearchIndex.query(text, {limit:25});
    if(!hits.length){
      const s = SearchIndex.stats();
      return {ok:true, message:`Nothing inside your files matched “${text}”.\n\n` +
        `The index covers ${s.docs} files and ${s.terms.toLocaleString()} terms. It searches file CONTENT, ` +
        `not just names — but it is lexical, so it finds the word, not the idea behind it.`};
    }
    const lines = hits.map(h=>{
      const rel = h.path.replace("/home/rithvik","~");
      return `• ${VFS.base(h.path)} — ${rel}\n   matched ${h.why} · ${h.doc.len} tokens`;
    });
    setTimeout(()=>Apps.open("search"), 250);
    return {ok:true, message:`Found ${hits.length} file${hits.length===1?"":"s"} containing “${text}”:\n\n${lines.join("\n")}`};
  };
});