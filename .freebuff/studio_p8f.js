// ---- settings, extensions UI, diff modal, honesty, shortcuts, boot --------
Object.assign(StApp.prototype, {

  applySettings(){
    const S = StSettings;
    StThemes.apply(S.get("theme"));
    const ed = this.editor;
    if(!ed) return;
    ed.host.style.setProperty("--st-fs", S.get("fontSize")+"px");
    ed.host.style.setProperty("--st-lh", S.get("lineHeight")+"px");
    const cs = ed.ta.style;
    cs.fontSize = S.get("fontSize")+"px";
    cs.lineHeight = S.get("lineHeight")+"px";
    ed._measure();
    ed.mm.style.display = S.get("minimap") ? "" : "none";
    ed.gut.style.display = S.get("gutter") ? "" : "none";
    ed.ta.style.whiteSpace = S.get("wordWrap") ? "pre-wrap" : "pre";
    ed.ta.setAttribute("wrap", S.get("wordWrap") ? "soft" : "off");
    this.r.side.style.width = (S.get("sideWidth")||236)+"px";
    this.r.right.style.width = (S.get("rightWidth")||330)+"px";
    this.r.right.classList.remove("w1","w2");
    if(S.get("rightWidth")<280) this.r.right.classList.add("w1");
    if(S.get("rightWidth")>400) this.r.right.classList.add("w2");
    ed.render(); this.renderStatus();
  },
  cycleTheme(){
    const id = StThemes.next();
    StSettings.set("theme", id); StSettings.save();
    StThemes.apply(id);
    this.renderStatus();
    this.toast("Theme: "+StThemes[id].name,"ok");
    Log.record("studio: theme "+id, "studio_setting", {theme:id}, "low", false, true, "Editor theme → "+StThemes[id].name);
  },

  showSettings(){
    const S = StSettings;
    const back = stModal();
    const row = (label, hint, ctrl)=>`<div class="st2-set-r"><div class="lbl">${label}${hint?`<small>${hint}</small>`:""}</div>${ctrl}</div>`;
    const sw = (key)=>`<div class="sw ${S.get(key)?"on":""}" data-sw="${key}"></div>`;
    back.innerHTML = `<div class="st2-set">
      <div class="st2-diff-h"><span class="t">Settings</span><span class="st"></span>
        <button class="st2-btn" data-a="close" style="margin-left:auto">Close</button></div>
      <div class="st2-set-b">
        <div class="st2-set-g"><div class="h">Workspace</div>
          ${row("Root folder", "where the explorer starts", `<span class="st2-mono" style="color:#8a80ab">${esc(p2(this.root,"~"))}</span><button class="st2-btn" data-a="root">Change</button>`)}
          ${row("Manifest", MANIFEST+" declares the project", `<span class="st2-badge ${StProject.read(this.root)?"g":"y"}">${StProject.read(this.root)?"declared":"missing"}</span><button class="st2-btn" data-a="editman">Edit</button>`)}
          ${row("Open files on start", "restore the last tabs", sw("restoreTabs"))}
        </div>
        <div class="st2-hr"></div>
        <div class="st2-set-g"><div class="h">Editor</div>
          ${row("Font size", "", `<input type="range" min="10" max="20" step="0.5" data-n="fontSize" value="${S.get("fontSize")}"><span class="st2-mono" style="width:34px" data-o="fontSize">${S.get("fontSize")}</span>`)}
          ${row("Line height", "", `<input type="range" min="16" max="30" step="1" data-n="lineHeight" value="${S.get("lineHeight")}"><span class="st2-mono" style="width:34px" data-o="lineHeight">${S.get("lineHeight")}</span>`)}
          ${row("Tab size", "used by Tab, indent and the status bar", `<input type="range" min="2" max="8" step="1" data-n="tabSize" value="${S.get("tabSize")}"><span class="st2-mono" style="width:34px" data-o="tabSize">${S.get("tabSize")}</span>`)}
          ${row("Word wrap", "", sw("wordWrap"))}
          ${row("Minimap", "", sw("minimap"))}
          ${row("Line numbers", "", sw("gutter"))}
        </div>
        <div class="st2-hr"></div>
        <div class="st2-set-g"><div class="h">Intelligence</div>
          ${row("Inline suggestions", "ghost text from the CYRUS brain as you type", sw("inlineAI"))}
          ${row("Debounce", "milliseconds before CYRUS is asked", `<input type="range" min="200" max="2500" step="50" data-n="aiDelay" value="${S.get("aiDelay")}"><span class="st2-mono" style="width:46px" data-o="aiDelay">${S.get("aiDelay")}ms</span>`)}
          ${row("Max suggested lines", "", `<input type="range" min="1" max="30" step="1" data-n="aiMaxLines" value="${S.get("aiMaxLines")}"><span class="st2-mono" style="width:34px" data-o="aiMaxLines">${S.get("aiMaxLines")}</span>`)}
          ${row("Diagnostics", "bracket, string, style and unused-import checks", sw("diagnostics"))}
          ${row("Style + unused hints", "the softer informational checks", sw("unusedHints"))}
        </div>
        <div class="st2-hr"></div>
        <div class="st2-set-g"><div class="h">Files</div>
          ${row("Save on run", "write the file before executing", sw("saveOnRun"))}
          ${row("Auto-save", "after you stop typing", sw("autoSave"))}
          ${row("Format on save", "", sw("formatOnSave"))}
          ${row("Confirm before delete", "recommended — the audit trail depends on it", sw("confirmDelete"))}
        </div>
        <div class="st2-hr"></div>
        <div class="st2-set-g"><div class="h">Appearance</div>
          ${row("Editor theme", "token colours for every language", `<select data-sel="theme">${Object.entries(StThemes).map(([k,v])=>`<option value="${k}" ${S.get("theme")===k?"selected":""}>${esc(v.name)}</option>`).join("")}</select>`)}
        </div>
        <div class="st2-note">Language coverage: ${LANG.count} languages, ${LANG.extCount} file extensions. An unknown extension still gets a derived spec, so highlighting, symbols and diagnostics keep working.</div>
      </div></div>`;
    document.body.appendChild(back);
    const close = ()=>{ back.remove(); };
    back.addEventListener("mousedown", e=>{ if(e.target===back) close(); });
    back.querySelector('[data-a="close"]').onclick = close;
    back.querySelector('[data-a="root"]').onclick = ()=>{ close(); this.openFolderPicker(); };
    back.querySelector('[data-a="editman"]').onclick = ()=>{ close(); this.openPath(this.root+"/"+MANIFEST); };
    back.querySelectorAll("[data-sw]").forEach(s=>{
      s.onclick = ()=>{ const k=s.dataset.sw; S.set(k, !S.get(k)); s.classList.toggle("on", S.get(k)); S.save(); this.applySettings();
        if(k==="diagnostics"||k==="unusedHints") this.analyze(); };
    });
    back.querySelectorAll("[data-n]").forEach(n=>{
      n.oninput = ()=>{ const k=n.dataset.n; S.set(k, parseFloat(n.value)); S.save();
        const o=back.querySelector(`[data-o="${k}"]`); if(o) o.textContent = n.value + (k==="aiDelay"?"ms":"");
        this.applySettings(); };
    });
    back.querySelector('[data-sel="theme"]').onchange = e=>{ S.set("theme", e.target.value); S.save(); this.applySettings(); };
    this._settingsClose = close;
  },

  showExtensions(){
    this.r.right.classList.remove("w0");
    this.setRightTab("ext");
  },

  async installExtensionDialog(){
    const which = await new Promise(resolve=>{
      const kinds = StExt.factories();
      StPalette.open({ tag:"ext", placeholder:"Install a first-party extension, or scaffold your own…",
        items:kinds.map(f=>({f})),
        render:(it,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">${it.f.icon}</span><span class="lbl">${esc(it.f.name)}</span><span class="sub">${esc(it.f.permissions.join(", "))}</span></div>`,
        onPick:(it)=>{ StPalette.close(); resolve(it.f); } });
    });
    if(!which) return;
    const r = await StExt.install(this, which);
    if(r.ok){ Bus.emit("studio:ext"); this.renderRight(); this.toast("Installed "+which.name,"ok"); }
    else this.toast(r.err,"err");
  },

  showDiff(cfg){
    const rows = cfg.rows || Diff.lines(cfg.a, cfg.b);
    const stat = cfg.stat || Diff.stat(rows);
    const hunks = Diff.hunks(rows, 3);
    let html = "";
    for(const h of hunks){
      const firstA = h.rows.find(r=>r.a) ? h.rows.find(r=>r.a).a : "";
      const firstB = h.rows.find(r=>r.b) ? h.rows.find(r=>r.b).b : "";
      html += `<div style="padding:3px 12px;background:#0d0820;color:#5b5382;font-size:10.5px;border-top:1px solid #1e1638">@@ line ${firstA} · ${stat.add} added · ${stat.del} removed @@</div>`;
      html += h.rows.map(r=>
        `<div class="st2-dl ${r.t==="add"?"add":r.t==="del"?"del":"ctx"}">`+
        `<span class="ln">${r.t==="add"?(r.b||""):(r.a||"")}</span>`+
        `<span class="tx">${r.t==="add"?"+ ":r.t==="del"?"- ":"  "}${esc(r.text)||"&nbsp;"}</span></div>`).join("");
    }
    const back = stModal();
    // The tier badge is not decoration. "Mechanical" means no model was
    // consulted and the patch follows from the token stream; "AI" means the
    // model guessed. Both are wrong to read the same way.
    const tier = cfg.tier || "ai";
    const badge = tier==="mechanical"
      ? `<span class="st2-tier mech" title="Computed by CYRUS from the token stream. No model was consulted.">⚡ mechanical</span>`
      : `<span class="st2-tier ai" title="Proposed by a language model. It can be wrong.">✷ AI proposal</span>`;
    const note = cfg.note ? `<div class="st2-diff-note">${esc(cfg.note)}</div>` : "";
    back.innerHTML = `<div class="st2-diff">
      <div class="st2-diff-h"><span class="t">${esc(cfg.title||"Diff")}</span>${badge}
        <span class="st"><span class="a">+${stat.add}</span><span class="d">−${stat.del}</span></span></div>
      ${note}
      <div class="st2-diff-b">${html || '<div style="padding:20px;color:#6f6690">No differences.</div>'}</div>
      <div class="st2-diff-f"><span>${tier==="mechanical"
          ? "Computed by CYRUS — but nothing is written until you accept."
          : "A model guessed this. Review it — it can be wrong."}</span>
        <span class="rt">
          <button class="st2-btn" data-a="copy">Copy result</button>
          <button class="st2-btn dng" data-a="reject">Reject</button>
          <button class="st2-btn pri" data-a="accept">${esc(cfg.applyLabel||"Accept")}</button>
        </span></div></div>`;
    document.body.appendChild(back);
    const close = ()=>{ back.remove(); document.removeEventListener("keydown", trap, true); };
    const trap = e=>{ e.stopPropagation(); if(e.key==="Escape"){ e.preventDefault(); close(); } };
    document.addEventListener("keydown", trap, true);
    back.addEventListener("mousedown", e=>{ if(e.target===back) close(); });
    back.querySelector('[data-a="reject"]').onclick = close;
    back.querySelector('[data-a="copy"]').onclick = ()=>{ this.toast(copied(cfg.b),"ok"); };
    back.querySelector('[data-a="accept"]').onclick = ()=>{ close(); if(cfg.onApply) cfg.onApply(cfg.b); };
  },

  showHonesty(){
    const back = stModal();
    back.innerHTML = `<div class="st2-set">
      <div class="st2-diff-h"><span class="t">What CYRUS Studio really does — and what it refuses to pretend</span>
        <button class="st2-btn" data-a="close" style="margin-left:auto">Close</button></div>
      <div class="st2-set-b">
        <div class="st2-set-g"><div class="h" style="color:#63c47c">Real, no caveats</div>
          <div class="st2-prow">✓ <span>Syntax highlighting, symbols and diagnostics for <b>${LANG.count} languages</b> from one tokenizer — no per-language extension, no compiler.</span></div>
          <div class="st2-prow">✓ <span>Multi-cursor, bracket matching, auto-close, smart indent, folding, find &amp; replace with regex, minimap, symbol outline, workspace symbols, references.</span></div>
          <div class="st2-prow">✓ <span>Files and folders with the full operation set — create, rename, duplicate, copy, cut, paste, move by drag, delete behind a confirm.</span></div>
          <div class="st2-prow">✓ <span>JavaScript really executes. HTML, CSS, Markdown and SVG really render. JSON really validates.</span></div>
          <div class="st2-prow">✓ <span>Every destructive action writes to the audit log with its risk level.</span></div>
          <div class="st2-prow">✓ <span>Extensions are declarative manifests — they structurally cannot run arbitrary code.</span></div>
        </div>
        <div class="st2-hr"></div>
        <div class="st2-set-g"><div class="h" style="color:#e0b155">Best faithful approximation — labelled, never hidden</div>
          <div class="st2-prow">△ <span><b>Diagnostics</b> are structural: brackets, strings, indentation, unused imports, loose equality, bare excepts, include guards. They are not a type checker and will miss real bugs.</span></div>
          <div class="st2-prow">△ <span><b>Python</b> runs in a line-level sandbox: print and assignment are real, loops and control flow are not.</span></div>
          <div class="st2-prow">△ <span><b>Inline completion</b> goes to a routed model, so it needs a provider — and it is wrong sometimes. Tab accepts it; nothing is written until you accept a diff.</span></div>
          <div class="st2-prow">△ <span><b>Folding</b> is bracket- and comment-based, not grammar-based.</span></div>
        </div>
        <div class="st2-hr"></div>
        <div class="st2-set-g"><div class="h" style="color:#e8798f">Not here — and CYRUS says so</div>
          <div class="st2-prow">✕ <span><b>Type checking and compiler-driven refactors.</b> Those need language servers (tsserver, pyright, rust-analyzer) running as real processes. A page cannot host 80 of them.</span></div>
          <div class="st2-prow">✕ <span><b>A real shell.</b> The runner executes JavaScript in the page. For Rust, Go, Java or a package manager, CYRUS names the host command and refuses to fake its output.</span></div>
          <div class="st2-prow">✕ <span><b>A debugger.</b> The Debug panel shows the real token stream and real timings, not fake breakpoints.</span></div>
          <div class="st2-prow">✕ <span><b>Downloading third-party code.</b> Extensions here are manifests. A plugin that could call anything would undermine the one promise this OS makes.</span></div>
        </div>
      </div></div>`;
    document.body.appendChild(back);
    const close = ()=>{ back.remove(); document.removeEventListener("keydown", trap2, true); };
    const trap2 = e=>{ e.stopPropagation(); if(e.key==="Escape") close(); };
    document.addEventListener("keydown", trap2, true);
    back.addEventListener("mousedown", e=>{ if(e.target===back) close(); });
    back.querySelector('[data-a="close"]').onclick = close;
  },

  showShortcuts(){
    const groups = {};
    StCmds.all().filter(c=>c.key).forEach(c=>{ (groups[c.category] = groups[c.category]||[]).push(c); });
    const back = stModal();
    back.innerHTML = `<div class="st2-set">
      <div class="st2-diff-h"><span class="t">Keyboard shortcuts</span><button class="st2-btn" data-a="close" style="margin-left:auto">Close</button></div>
      <div class="st2-set-b">${Object.entries(groups).map(([cat,list])=>
        `<div class="st2-set-g"><div class="h">${esc(cat)}</div>`+
        list.map(c=>`<div class="st2-set-r"><div class="lbl">${esc(c.title)}</div><span class="st2-badge">${esc(c.key)}</span></div>`).join("")+
        `</div>`).join("")}</div></div>`;
    document.body.appendChild(back);
    const close = ()=>{ back.remove(); document.removeEventListener("keydown", t, true); };
    const t = e=>{ e.stopPropagation(); if(e.key==="Escape") close(); };
    document.addEventListener("keydown", t, true);
    back.addEventListener("mousedown", e=>{ if(e.target===back) close(); });
    back.querySelector('[data-a="close"]').onclick = close;
  },

  showAbout(){
    const back = stModal();
    back.innerHTML = `<div class="st2-set" style="width:min(600px,94vw)">
      <div class="st2-diff-h"><span class="t">CYRUS Studio</span><button class="st2-btn" data-a="close" style="margin-left:auto">Close</button></div>
      <div class="st2-set-b">
        <div style="font-size:24px;font-weight:800;letter-spacing:8px;color:var(--accent)">CYRUS STUDIO</div>
        <div class="st2-note">You speak in intent. CYRUS plans it, checks permission, does it, proves it.</div>
        <div class="st2-hr"></div>
        <div class="st2-set-r"><div class="lbl">Languages</div><span class="st2-badge g">${LANG.count}</span></div>
        <div class="st2-set-r"><div class="lbl">File extensions recognised</div><span class="st2-badge g">${LANG.extCount}</span></div>
        <div class="st2-set-r"><div class="lbl">Registered commands</div><span class="st2-badge g">${StCmds.all().length}</span></div>
        <div class="st2-set-r"><div class="lbl">Extensions installed</div><span class="st2-badge g">${StExt.list().length}</span></div>
        <div class="st2-set-r"><div class="lbl">Audit entries</div><span class="st2-badge">${Log.all().length}</span></div>
        <div class="st2-set-r"><div class="lbl">Workspace</div><span class="st2-mono" style="color:#8a80ab">${esc(this.root)}</span></div>
        <div class="st2-hr"></div>
        <div class="st2-note">One HTML file. No build step. No server. Everything above runs in this page.</div>
      </div></div>`;
    document.body.appendChild(back);
    const close = ()=>{ back.remove(); document.removeEventListener("keydown", t, true); };
    const t = e=>{ e.stopPropagation(); if(e.key==="Escape") close(); };
    document.addEventListener("keydown", t, true);
    back.addEventListener("mousedown", e=>{ if(e.target===back) close(); });
    back.querySelector('[data-a="close"]').onclick = close;
  }
});

// ---- helpers --------------------------------------------------------------
let _ctxMenu = null;
function closeCtxMenu(){ if(_ctxMenu){ _ctxMenu.remove(); _ctxMenu=null; } }
function buildCtxMenu(items, x, y){
  closeCtxMenu();
  const m = el("div");
  m.style.cssText = "position:fixed;z-index:600;min-width:212px;background:#150d29;border:1px solid #3a2c63;border-radius:9px;padding:5px;box-shadow:0 18px 50px rgba(0,0,0,.7)";
  m.innerHTML = items.map(it=>{
    if(!it) return '<div class="st2-hr" style="margin:4px 0"></div>';
    const [ic,label,fn,enabled] = it;
    return `<div class="st2-pal-i" data-m="${items.indexOf(it)}" style="${enabled===false?"opacity:.4":""}"><span class="ic">${ic}</span><span class="lbl">${esc(label)}</span></div>`;
  }).join("");
  m.addEventListener("mousedown", e=>{
    const r = e.target.closest("[data-m]");
    if(!r) return;
    const it = items[+r.dataset.m];
    if(!it || it[3]===false) return;
    e.preventDefault();
    closeCtxMenu();
    try{ it[2](); }catch(err){ Toast.show("Studio","That action failed: "+err.message,null,"err"); }
  });
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  setTimeout(()=>{
    const off = ()=>{ closeCtxMenu(); document.removeEventListener("mousedown", off); };
    document.addEventListener("mousedown", off);
  }, 0);
  _ctxMenu = m;
  return m;
}

// ---- the launcher ---------------------------------------------------------
function openStudio(arg){
  const opts = (arg && typeof arg==="object") ? arg : { path: typeof arg==="string" ? arg : undefined };
  const win = WM.open({ id:"editor", title:"CYRUS Studio", icon:"🧑‍💻", w:1360, h:840, build(w){
    const app = new StApp(w, opts);
    w.studio = app;
    w.openFile = p => app.openPath(p);
    w.loadFile = p => app.openPath(p);
    w.onReload = ()=>{ if(app.active) app.openPath(app.active); };
    w.onClose = ()=>{ StSettings.save(); };
    Bus.on("vfs", ()=>{ StIndex.invalidate(); app.afterVfsChange(); });
  }});
  return win;
}