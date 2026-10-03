// ---- save / run -----------------------------------------------------------
Object.assign(StApp.prototype, {

  toast(msg, kind){ Toast.show("CYRUS Studio", msg, null, kind); },

  save(opts){
    opts = opts || {};
    let saved = 0;
    for(const t of this.tabs){
      if(!t.dirty) continue;
      const text = t.path===this.active ? this.editor.text : t.text;
      if(text==null) continue;
      let out = text;
      if(StSettings.get("formatOnSave")){
        try{
          const ed = new StEditor(el("div","hidden"), {});
          ed.spec = LANG.forPath(t.path, text);
          ed.setContent(text, true);
          ed.format();
          out = ed.content;
        }catch(e){}
      }
      if(VFS.writeFile(t.path, out)){
        t.dirty = false; saved++;
        if(t.path===this.active) this.editor.setContent(out, true);
      }
    }
    if(saved){
      StIndex.invalidate();
      this.renderTabs(); this.refreshExplorer();
      this.analyze();
      this.renderStatus();
      if(!opts.quiet) this.toast(saved===1 ? "Saved "+VFS.base(this.tabs.find(t=>!t.dirty && t.path===this.active)?.path||this.active) : "Saved "+saved+" files", "ok");
    } else if(!opts.quiet && this.active){
      this.toast("No changes to save","warn");
    }
    return saved;
  },
  saveAll(){ return this.save({quiet:true}); },
  markClean(){ this.tabs.forEach(t=>t.dirty=false); this.renderTabs(); },

  async run(path){
    path = path || this.active;
    if(!path){ this.setPanelTab("output"); this.toast("Open a file first","warn"); return; }
    const t = this.tabs.find(x=>x.path===path);
    const text = path===this.active ? this.editor.text : (VFS.node(path)||{}).content || "";
    const spec = LANG.forPath(path, text);
    const plan = StRun.plan(this.root, path, text);
    this.running = true;
    this.runState = { path, plan, t0:performance.now() };
    this.setPanelTab("output");
    const out = [];
    const line = s => out.push(s);
    line(`▸ ${plan.command || "cyrus run "+VFS.base(path)}${plan.fromManifest ? "   (from "+MANIFEST+")" : "   (inferred from the language)"}`);
    line("─".repeat(60));
    const res = await StRun.exec(this.root, path, text);
    StRun.record(this.root, path, res);
    if(res.kind==="preview"){
      this.runState.preview = res.preview;
      this.setPanelTab("preview", true);
      this.renderPanel();
      this.running = false;
      this.renderStatus();
      return res;
    }
    if(res.note) line(res.note);
    if(res.out) line(res.out);
    if(res.err) line(res.err);
    line("─".repeat(60));
    line(`${res.ok?"✔":"✖"} ${res.kind} · ${Math.round(res.ms)}ms · ${new Date().toLocaleTimeString()}`);
    this.runState.result = res;
    this.runState.problems = DIAG.fromOutput((res.err||"")+"\n"+(res.out||""), path);
    this.termLines = out;
    this.pbodyHtml = out.map(s=>this.colorize(s)).join("\n");
    this.running = false;
    this.renderPanel(); this.renderStatus();
    this.analyze();
    if(!res.ok) this.pulseProblems();
    return res;
  },
  colorize(s){
    const e = esc(s);
    if(/^✔/.test(s)) return '<span class="g">'+e+"</span>";
    if(/^✖|^Traceback|Error:|error:/.test(s)) return '<span class="e">'+e+"</span>";
    if(/^⚠|^Warning|warning:/.test(s)) return '<span class="w">'+e+"</span>";
    if(/^▸|^─/.test(s)) return '<span class="i">'+e+"</span>";
    return e;
  },
  pulseProblems(){ this.setPanelTab("problems"); },
  stopRun(){ this.running=false; this.toast("Nothing to stop — runs in this panel are synchronous","warn"); this.renderStatus(); },
  restartRun(){ if(this.active) this.run(); },

  async runConfigPicker(){
    const r = StProject.resolved(this.root);
    if(!r.runs.length){ this.toast("No run configs in "+MANIFEST+" — add one, or just Run the file","warn"); return; }
    StPalette.open({ tag:"run", placeholder:"Run a configuration…",
      items:r.runs.map(c=>({ cfg:c })),
      render:(it,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">▶</span><span class="lbl">${esc(it.cfg.name)}</span><span class="sub">${esc(it.cfg.command)}</span></div>`,
      quick:(q,items)=>Fuzzy.rank(q,items,x=>x.cfg.name+" "+x.cfg.command).map(x=>x.item),
      onPick:async(it)=>{
        const parts = it.cfg.command.split(/\s+/);
        const fileArg = parts.slice(1).find(a=>!a.startsWith("-"));
        const target = fileArg && VFS.node(VFS.norm(this.root, fileArg)) ? VFS.norm(this.root, fileArg) : this.active;
        this.setPanelTab("output");
        this.termLines = ["▸ "+it.cfg.command, "─".repeat(60),
          "This configuration names a host command. CYRUS runs what the browser can run and reports the rest:",
          "  "+it.cfg.command, "", "(no shell inside the page — copy the line above into your terminal)"];
        this.pbodyHtml = this.termLines.map(s=>this.colorize(s)).join("\n");
        this.renderPanel();
        Log.record("studio: run config "+it.cfg.name, "run_script", {name:it.cfg.name, cmd:it.cfg.command}, "medium", false, true, "Run config selected");
      }
    });
  },
  async runAllConfigs(){
    const r = StProject.resolved(this.root);
    if(!r.runs.length) return this.runConfigPicker();
    const lines = r.runs.map(c=>`${c.name.padEnd(10)} ${c.command}`);
    this.setPanelTab("output");
    this.termLines = ["▹ all run configurations in "+MANIFEST, "─".repeat(60), ...lines, "", "CYRUS does not chain host commands."];
    this.pbodyHtml = this.termLines.map(s=>this.colorize(s)).join("\n");
    this.renderPanel();
  },

  async explainFailure(){
    const rs = this.runState;
    if(!rs || !rs.result || rs.result.ok){ this.toast("Nothing has failed yet","warn"); return; }
    this.setRightTab("cyrus");
    const r = rs.result;
    const diag = this.lastProblems.slice(0,8).map(d=>"· line "+((d.line||0)+1)+": "+d.msg).join("\n");
    this.askAI("The run of "+VFS.base(rs.path)+" failed.\n\nCommand: "+(r.cmd||"(in-browser)")+
      "\n\nOutput:\n"+(r.out||"").slice(0,900)+"\n"+(r.err||"").slice(0,900)+
      "\n\nDiagnostics CYRUS itself reported:\n"+(diag||"(none)")+
      "\n\nExplain the root cause and give the exact fix.");
  },

  // ================= status bar =================
  buildStatusBar(){
    this.r.status.addEventListener("mousedown", e=>{
      const s = e.target.closest("[data-s]");
      if(!s) return;
      const a = s.dataset.s;
      if(a==="side") this.toggleSide();
      if(a==="right") this.toggleRight();
      if(a==="panel") this.togglePanel();
      if(a==="problems") this.setPanelTab("problems");
      if(a==="conn") StConn.sheet(null);
      if(a==="run") this.run();
      if(a==="lang") this.pickLanguage();
      if(a==="indent") this.pickIndent();
      if(a==="eol") this.toast("CYRUS Studio uses LF. The host editor decides the truth.","warn");
      if(a==="enc") this.toast("UTF-8","ok");
      if(a==="theme") this.cycleTheme();
      if(a==="settings") this.showSettings();
      if(a==="ai") { StSettings.set("inlineAI", !StSettings.get("inlineAI")); this.toast("Inline suggestions "+(StSettings.get("inlineAI")?"on":"off"),"ok"); this.renderStatus(); }
    });
  },
  renderStatus(){
    const ed = this.editor;
    const p = ed.primary;
    const line = ed.lineOf(p.e);
    const col = p.e - ed.lineStart(line);
    const selChars = p.e-p.s;
    const path = this.active;
    const tag = path ? LANG.forPath(path, ed.text) : null;
    const counts = this.lastProblems.reduce((a,d)=>{ a[d.sev]=(a[d.sev]||0)+1; return a; },{});
    const L = (key, content, cls)=>`<span class="s ${cls||""}" data-s="${key}">${content}</span>`;
    const parts = [];
    parts.push(L("side","🗂️ EXPLORER"));
    parts.push(L("right","✨ CYRUS"));
    parts.push(L("panel", this.panelOpen ? "▾ PANEL" : "▸ PANEL"));
    parts.push('<span class="grow"></span>');
    if(selChars) parts.push(`<span class="s" data-s="cursor">${selChars} selected</span>`);
    parts.push(L("cursor","Ln "+(line+1)+", Col "+(col+1)));
    if(counts.err) parts.push(`<span class="s" data-s="problems"><span style="color:#e8798f">✖ ${counts.err}</span></span>`);
    if(counts.warn) parts.push(`<span class="s" data-s="problems"><span style="color:#e0b155">⚠ ${counts.warn}</span></span>`);
    if(StSettings.get("inlineAI")) parts.push(L("ai","✨ inline"));
    // Phase 9: one cell that always says whether the granted authorities still hold.
    try{ parts.push(StConn.statusCell()); }catch(e){}
    if(path) parts.push(L("lang", tag ? tag.name : "Plain Text"));
    parts.push(L("indent","Spaces: "+StSettings.get("tabSize")));
    parts.push(L("eol","LF"));
    parts.push(L("enc","UTF-8"));
    parts.push(L("theme","◐ "+StThemes[StSettings.get("theme")].name));
    parts.push(L("settings","⚙"));
    this.r.status.innerHTML = parts.join("");
  },

  // ================= bottom panel =================
  bindPanel(){
    this.r.ptabs.addEventListener("mousedown", e=>{
      const t = e.target.closest("[data-pt]");
      if(t) this.setPanelTab(t.dataset.pt);
    });
  },
  setPanelTab(tab, silent){
    this.panelTab = tab;
    if(!silent){ this.panelOpen = true; StSettings.set("lastPanel", tab); StSettings.save(); }
    this.r.panel.classList.toggle("h0", !this.panelOpen);
    this.renderPanel(); this.renderStatus();
  },
  togglePanel(which){
    if(which && which!==this.panelTab){ this.setPanelTab(which); return; }
    this.panelOpen = !this.panelOpen;
    StSettings.set("lastPanel", this.panelTab); StSettings.save();
    this.r.panel.classList.toggle("h0", !this.panelOpen);
    this.renderStatus();
  },
  dockPanel(){ this.panelOpen = true; this.r.panel.classList.remove("h0"); this.renderStatus(); },
  renderPanel(){
    const tabs = [["problems","PROBLEMS"],["output","OUTPUT"],["terminal","TERMINAL"],["preview","PREVIEW"],["debug","DEBUG"],["tasks","TASKS"]];
    const counts = this.lastProblems.reduce((a,d)=>{ a[d.sev]=(a[d.sev]||0)+1; return a; },{});
    this.r.ptabs.innerHTML = tabs.map(([id,label])=>{
      const on = id===this.panelTab ? " on":"";
      const b = id==="problems" && counts.err ? `<span class="bdg">${counts.err}</span>` :
                id==="problems" && counts.warn ? `<span class="bdg" style="background:#e0b155">${counts.warn}</span>` : "";
      return `<div class="st2-ptab${on}" data-pt="${id}">${label}${b}</div>`;
    }).join("");

    const body = this.r.pbody;
    if(this.panelTab==="preview"){
      const pv = this.runState && this.runState.preview;
      body.innerHTML = pv ? `<iframe sandbox="allow-scripts" srcdoc="${esc(pv)}"></iframe>`
        : '<span class="d">Run a file to preview it here. HTML, CSS, Markdown and SVG render live.</span>';
      return;
    }
    if(this.panelTab==="problems"){
      if(!this.lastProblems.length){
        body.innerHTML = '<span class="g">✔ No problems detected</span><br><span class="d">'+
          "CYRUS checks brackets, unterminated strings, mixed indentation, unused imports, hard-coded secrets, "+
          "loose equality, long lines, bare excepts and missing include guards — without a compiler.</span>";
        return;
      }
      // Offer a ⚡ button only where CYRUS can fix the problem without guessing.
      // A mechanical fix is computed from the token stream; anything that would
      // need a model keeps its "Ask CYRUS" button and says so.
      const spec0 = LANG.forPath(this.active, this.editor.text);
      const src0 = this.editor.text;
      const fixable = this.lastProblems.map(d=>this.fixableFor(src0, spec0, d));
      // the count on the button is the number Fix All will actually apply
      const nFixable = fixable.filter(Boolean).length;
      const nSafe = fixable.filter(f=>f && f.safe).length;
      const head = nSafe>1
        ? `<div class="st2-pfixall"><span>${nSafe} of these CYRUS can fix on its own — no model, no guess.</span>`+
          `<button class="st2-btn fix" data-fixall="1">⚡ Fix all ${nSafe}</button></div>` : "";
      body.innerHTML = head + this.lastProblems.slice(0,300).map((d,i)=>{
        const loc = `${d.file?p2(d.file,this.root):""}${d.line!=null?":"+(d.line+1):""}${d.col?", "+(d.col+1):""}`;
        const mech = fixable[i]
          ? `<button class="st2-btn fix" data-mfix="${i}" title="${esc(fixable[i].label)}">⚡ Fix</button>` : "";
        const ai = (d.src==="run" || !mech) && d.sev!=="info"
          ? `<button class="st2-btn" data-fix="${i}" style="margin-left:6px;padding:1px 7px;font-size:10px">Ask CYRUS</button>` : "";
        return `<div class="st2-prow" data-prob="${i}"><span class="cl">${d.line!=null?String(d.line+1).padStart(4," "):""}</span>`+
               `<span class="${d.sev==="err"?"e":d.sev==="warn"?"w":"i"}">${d.sev==="err"?"✖":d.sev==="warn"?"⚠":"ℹ"}</span>`+
               `<span>${esc(d.msg)}</span><span class="cl" style="color:#4b4370">${esc(loc)}</span>${mech}${ai}</div>`;
      }).join("");
      body.querySelectorAll("[data-prob]").forEach(row=>{
        row.addEventListener("click", ()=>{
          const d = this.lastProblems[+row.dataset.prob];
          this.selectedProblem = d;
          if(d.file && d.file!==this.active) this.openPath(d.file);
          if(d.line!=null){ const p=this.editor.posAt(d.line, d.col||0); this.editor.setSelection(p, this.editor.lineEnd(d.line)); this.editor.revealLine(d.line); }
        });
        row.addEventListener("contextmenu", e=>{
          e.preventDefault();
          const d = this.lastProblems[+row.dataset.prob];
          this.selectedProblem = d;
          const m = fixable[+row.dataset.prob];
          this.problemMenu(e.clientX, e.clientY, d, m);
        });
      });
      const fa = body.querySelector("[data-fixall]");
      if(fa) fa.addEventListener("click", e=>{ e.stopPropagation(); this.fixAllMechanical(); });
      body.querySelectorAll("[data-mfix]").forEach(b=>b.addEventListener("click", e=>{
        e.stopPropagation();
        this.quickFix(this.lastProblems[+b.dataset.mfix]);
      }));
      body.querySelectorAll("[data-fix]").forEach(b=>b.addEventListener("click", e=>{
        e.stopPropagation();
        const d = this.lastProblems[+b.dataset.fix];
        this.selectedProblem = d;
        this.fixProblem();
      }));
      return;
    }
    if(this.panelTab==="output"){
      body.innerHTML = (this.pbodyHtml || '<span class="d">Nothing has run yet. Press ▶ or Ctrl+Enter.</span>');
      body.scrollTop = body.scrollHeight;
      return;
    }
    if(this.panelTab==="terminal"){
      const hist = StTerm.history.slice(-8).reverse().map(h=>`<div class="d">$ ${esc(h)}</div>`).join("");
      body.innerHTML = `<div class="d">CYRUS in-browser shell · cwd <span style="color:#8a80ab">${esc(StTerm.cwd)}</span> · type <span style="color:#8a80ab">help</span></div>`+
        `<div class="d" style="border-top:1px solid #1e1638;margin:6px 0;padding-top:5px">${hist}</div>`+
        (this.termOut||'<span class="d">(no output)</span>')+
        `<div style="display:flex;gap:6px;margin-top:8px;border-top:1px solid #1e1638;padding-top:7px">`+
        `<span style="color:var(--accent)">$</span>`+
        `<input data-r="term" spellcheck="false" placeholder="help" style="flex:1;background:transparent;border:none;outline:none;color:#e6dffc;font-family:var(--st-mono);font-size:11.5px">`+
        `<button class="st2-btn" data-a="termRun" style="padding:1px 10px">Run</button></div>`;
      const inp = body.querySelector('[data-r="term"]');
      const go = async ()=>{
        const v = inp.value.trim(); if(!v) return;
        inp.value = "";
        let out;
        try{ out = await StTerm.exec(v, { open:p=>this.openPath(p), run:p=>this.run(p) }); }
        catch(e){ out = '<span class="e">'+esc(e.message)+"</span>"; }
        if(out==="\u0000CLEAR") this.termOut = "";
        else this.termOut = `$ ${esc(v)}\n` + out + "\n";
        this.renderPanel();
        setTimeout(()=>{ const i2=this.r.pbody.querySelector('[data-r="term"]'); if(i2){ i2.focus(); } },10);
      };
      inp.addEventListener("keydown", e=>{ e.stopPropagation(); if(e.key==="Enter") go(); if(e.key==="ArrowUp"){ StTerm.hi=Math.max(0,StTerm.hi-1); inp.value=StTerm.history[StTerm.hi]||""; } });
      body.querySelector('[data-a="termRun"]').addEventListener("click", go);
      setTimeout(()=>{ if(this.panelTab==="terminal" && !StPalette.node){ const i2=this.r.pbody.querySelector('[data-r="term"]'); if(i2) i2.focus(); } },20);
      body.scrollTop = body.scrollHeight;
      return;
    }
    if(this.panelTab==="debug"){ this.renderDebug(body); return; }
    // tasks
    const r = StProject.resolved(this.root);
    const all = StSettings.get("savedTasks")||[];
    body.innerHTML = `<div class="st2-sec">FROM ${MANIFEST}</div>`+
      (r.runs.length ? r.runs.map(c=>`<div class="st2-prow"><span class="cl">▶</span><span>${esc(c.name)}</span><span class="d">${esc(c.command)}</span></div>`).join("")
                    : '<span class="d">No run configs declared. Run a file directly, or add a "runs" array to '+MANIFEST+".</span>")+
      `<div class="st2-sec">SAVED TASKS</div>`+
      (all.length ? all.map(c=>`<div class="st2-prow"><span class="cl">★</span><span>${esc(c.name)}</span><span class="d">${esc(c.command)}</span></div>`).join("")
        : '<span class="d">None. Terminal lines starting with "npm ", "cargo ", "go " and "python " are offered to be saved.</span>');
  },

  // ================= find bar =================
  buildFind(){
    const bar = el("div","st2-find hidden");
    bar.innerHTML =
      `<span style="font-size:11px;color:#8a80ab">Find</span>
       <input data-r="fq" placeholder="find" spellcheck="false">
       <button class="fx" data-r="fc" title="Match case">Aa</button>
       <button class="fx" data-r="fw" title="Whole word">|ab|</button>
       <button class="fx" data-r="fr" title="Regex">.*</button>
       <span class="ct" data-r="fcn">0/0</span>
       <button class="fx" data-r="fp" title="Previous">↑</button>
       <button class="fx" data-r="fn" title="Next">↓</button>
       <button class="fx" data-r="fx">✕</button>
       <input data-r="rq" placeholder="replace" spellcheck="false" style="display:none;width:130px">
       <button class="fx" data-r="rx" title="Replace">⇄</button>
       <button class="fx" data-r="ra" title="Replace all" style="display:none">⇉</button>`;
    this.win.body.appendChild(bar);
    bar.style.position = "absolute";
    bar.style.top = "34px";
    bar.style.right = "100px";
    this.findBar = bar;
    const q = k => bar.querySelector(`[data-r="${k}"]`);
    this.fq = q("fq"); this.rq = q("rq"); this.fcn = q("fcn");
    this.findOpts = { caseOn:false, whole:false, regex:false };
    const run = ()=>{
      const n = this.editor.setFind(this.fq.value, Object.assign({}, this.findOpts));
      this.fcn.textContent = (this.editor.find && this.editor.find.matches.length ? this.editor.find.idx+1 : 0)+"/"+n;
    };
    this.fq.addEventListener("input", run);
    this.fq.addEventListener("keydown", e=>{
      e.stopPropagation();
      if(e.key==="Enter"){ e.preventDefault(); this.editor.findNext(e.shiftKey?-1:1); this.fcn.textContent=(this.editor.find.idx+1)+"/"+this.editor.find.matches.length; }
      if(e.key==="Escape"){ e.preventDefault(); this.closeFind(); }
      if(e.key==="Tab"){ e.preventDefault(); this.rq.focus(); }
    });
    this.rq.addEventListener("keydown", e=>{
      e.stopPropagation();
      if(e.key==="Enter"){ e.preventDefault(); this.editor.replaceCurrent(this.rq.value); }
      if(e.key==="Escape"){ e.preventDefault(); this.closeFind(); }
    });
    q("fc").onclick = ()=>{ this.findOpts.caseOn=!this.findOpts.caseOn; q("fc").style.color=this.findOpts.caseOn?"var(--accent2)":""; run(); };
    q("fw").onclick = ()=>{ this.findOpts.whole=!this.findOpts.whole; q("fw").style.color=this.findOpts.whole?"var(--accent2)":""; run(); };
    q("fr").onclick = ()=>{ this.findOpts.regex=!this.findOpts.regex; q("fr").style.color=this.findOpts.regex?"var(--accent2)":""; run(); };
    q("fn").onclick = ()=>{ this.editor.findNext(1); this.fcn.textContent=(this.editor.find.idx+1)+"/"+this.editor.find.matches.length; };
    q("fp").onclick = ()=>{ this.editor.findNext(-1); this.fcn.textContent=(this.editor.find.idx+1)+"/"+this.editor.find.matches.length; };
    q("fx").onclick = ()=>this.closeFind();
    q("rx").onclick = ()=>{ const on=this.rq.style.display==="none"; this.rq.style.display=on?"":"none"; q("ra").style.display=on?"":"none"; if(on) this.rq.focus(); };
    q("ra").onclick = ()=>{ const n=this.editor.replaceAll(this.rq.value); this.toast("Replaced "+n+" occurrence"+(n===1?"":"s"),"ok"); };
    this.win.body.addEventListener("mousedown", e=>{
      if(!this.findBar.classList.contains("hidden") && !e.target.closest(".st2-find") && !e.target.closest(".st2-ta")){
        this.editor.setFind("", {}); this.closeFind();
      }
    });
  },
  openFind(replace){
    this.findBar.classList.remove("hidden");
    const ed = this.editor;
    const sel = ed.primary;
    if(sel.s!==sel.e && sel.e-sel.s<120) this.fq.value = ed.content.slice(sel.s, sel.e);
    this.fq.focus(); this.fq.select();
    if(replace){ this.rq.style.display=""; this.rq.focus(); }
    if(this.fq.value) this.editor.setFind(this.fq.value, this.findOpts);
  },
  closeFind(){ this.findBar.classList.add("hidden"); this.editor.setFind("", {}); this.editor.focus(); }
});