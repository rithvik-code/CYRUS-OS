// ---- right panel: Copilot · Outline · Problems · Extensions · Source -----
Object.assign(StApp.prototype, {

  buildRight(){
    this.r.rtabs.addEventListener("mousedown", e=>{
      const t = e.target.closest("[data-rt]");
      if(t) this.setRightTab(t.dataset.rt);
    });
    this.r.rbody.addEventListener("mousedown", e=>{
      const g = e.target.closest("[data-goto]");
      if(g){ this.openPath(g.dataset.goto, { line:g.dataset.line?+g.dataset.line:undefined }); return; }
      const s = e.target.closest("[data-sym]");
      if(s){ const [p,l]=s.dataset.sym.split("|"); this.openPath(p,{line:+l}); return; }
      const a = e.target.closest("[data-extcmd]");
      if(a){ StExt.run(this, a.dataset.extcmd); return; }
      const c = e.target.closest("[data-ctxact]");
      if(c) this.quickAction(c.dataset.ctxact);
    });
    this.aiInput = this.newAIInput();
  },
  // A fresh, fully wired chat textarea. cloneNode() would drop the listeners,
  // and stringifying a node into innerHTML yields "[object HTMLTextAreaElement]",
  // so the panel builds its input through here instead.
  newAIInput(){
    const ta = el("textarea");
    ta.placeholder = "Ask about this code, or say “rewrite this to …”";
    ta.rows = 1;
    ta.addEventListener("keydown", e=>{
      e.stopPropagation();
      if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); this.send(); }
      if(e.key==="Tab"){
        e.preventDefault();
        const ed = this.editor;
        const s = ed ? ed.primary : null;
        const sel = (ed && s && s.s!==s.e) ? ed.content.slice(s.s,s.e) : "";
        ta.value += (ta.value && !/\s$/.test(ta.value) ? " " : "") + (sel ? "`"+sel+"`" : "");
        ta.focus();
      }
    });
    ta.addEventListener("input", ()=>{
      ta.style.height = "auto";
      ta.style.height = Math.min(120, ta.scrollHeight) + "px";
    });
    return ta;
  },
  setRightTab(tab){ this.rightTab = tab; this.renderRight(); },
  toggleRight(){ this.r.right.classList.toggle("w0"); this.renderRight(); },
  toggleSide(){ this.r.side.classList.toggle("w0"); },

  renderRight(){
    const tabs = [["cyrus","COPILOT"],["outline","OUTLINE"],["problems","PROBLEMS"],["ext","EXTENSIONS"]];
    const counts = this.lastProblems.reduce((a,d)=>{ a[d.sev]=(a[d.sev]||0)+1; return a; },{});
    this.r.rtabs.innerHTML = tabs.map(([id,label])=>{
      const b = id==="problems" && (counts.err||counts.warn) ? `<span class="bdg" style="background:${counts.err?"#e8798f":"#e0b155"}">${counts.err||counts.warn}</span>` : "";
      return `<div class="st2-rtab ${id===this.rightTab?"on":""}" data-rt="${id}">${label}${b}</div>`;
    }).join("");

    const b = this.r.rbody;
    if(this.rightTab==="cyrus") return this.renderAI(b);
    if(this.rightTab==="outline") return this.renderOutline(b);
    if(this.rightTab==="problems") return this.renderProblemsList(b);
    if(this.rightTab==="ext") return this.renderExtensions(b);
  },

  renderOutline(b){
    b.innerHTML = "";
    const path = this.active;
    if(!path){ b.innerHTML = '<div class="st2-empty">Open a file to see its structure.</div>'; return; }
    const t = this.tabs.find(x=>x.path===path);
    const text = path===this.active ? this.editor.text : (t&&t.text) || (VFS.node(path)||{}).content || "";
    const spec = LANG.forPath(path, text);
    const syms = SYMBOLS.extract(text, spec);
    const head = `<div class="st2-sec">${esc(spec.name.toUpperCase())} · ${syms.length} symbols · ${spec.pairs&&Object.keys(spec.pairs).length?"bracket-aware":""}</div>`;
    if(!syms.length){
      b.innerHTML = head + `<div class="st2-empty">No declarations found in ${esc(VFS.base(path))}.<br><span style="opacity:.7">The extractor understands ${LANG.count} languages; this file has no top-level symbols.</span></div>`;
      return;
    }
    const ic = { fn:"ƒ", cls:"◈", int:"◻", var:"▪", let:"▪", mod:"▣", prm:"◔", proc:"ƒ", ty:"τ" };
    const cur = this.editor.primary;
    const curLine = this.editor.lineOf(cur.e);
    b.innerHTML = head + syms.map(s=>{
      const here = s.line===curLine;
      return `<div class="st2-sym" data-sym="${esc(path)}|${s.line}" style="padding-left:${6+s.depth*11}px;${here?"background:#241a42;color:#e6dffc":""}">`+
        `<span class="ic ${s.kind}">${ic[s.kind]||"•"}</span>`+
        `<span class="nm">${esc(s.name)}${s.container?`<span style="color:#5b5382"> in ${esc(s.container)}</span>`:""}</span>`+
        `<span class="ln">${s.line+1}</span></div>`;
    }).join("");
  },

  renderProblemsList(b){
    if(!this.lastProblems.length){ b.innerHTML = '<div class="st2-empty">✔ No problems. <span style="opacity:.7">Compiler-free checks only.</span></div>'; return; }
    b.innerHTML = `<div class="st2-sec">${this.lastProblems.length} findings</div>`+
      this.lastProblems.map((d,i)=>`<div class="st2-prob ${d.sev}" data-goto="${esc(d.file||"")}" data-line="${d.line!=null?d.line:0}">`+
        `<b style="color:${d.sev==="err"?"#e8798f":d.sev==="warn"?"#e0b155":"#6fb3f2"}">${d.sev==="err"?"✖":d.sev==="warn"?"⚠":"ℹ"}</b> ${esc(d.msg)}`+
        `<span class="loc">${esc(p2(d.file||"",this.root))}${d.line!=null?" · line "+(d.line+1):""} · ${esc(d.src||"")}</span></div>`).join("");
  },

  renderExtensions(b){
    const list = StExt.list();
    b.innerHTML = `<div class="st2-sec">${list.length} INSTALLED · declarative manifests</div>`+
      `<div class="st2-note" style="margin-bottom:9px">Extensions here cannot execute arbitrary code. A plugin is a JSON manifest — it can only contribute commands, snippets and problem matchers, and every capability it asks for passes the table below.</div>`+
      `<div class="st2-sec">CAPABILITIES</div>`+
      Object.entries(CAPS).map(([k,v])=>`<div class="st2-prow"><span class="cl">${esc(k)}</span><span class="${v.risk==="high"?"e":v.risk==="medium"?"w":"g"}">${v.risk}</span><span class="d">${esc(v.desc)}</span></div>`).join("")+
      `<div class="st2-sec">EXTENSIONS</div>`+
      list.map(m=>{
        const cmds = (m.contributes&&m.contributes.commands)||[];
        return `<div class="st2-ext"><div class="nm">${m.icon||"🧩"} ${esc(m.name)} <span class="ver">v${esc(m.version||"1.0.0")}</span></div>`+
          `<div class="ds">${esc(m.description||"")}</div>`+
          `<div class="pm">${(m.permissions||[]).map(p=>{ const c=CAPS[p]; return `<b class="${c&&c.risk==="high"?"r":c&&c.risk==="medium"?"y":"g"}">${esc(p)}</b>`; }).join("")}</div>`+
          (cmds.length? `<div class="act">${cmds.slice(0,4).map(c=>`<button data-extcmd="${esc(c.id)}">${esc(c.title)}</button>`).join("")}</div>` : "")+
          `</div>`;
      }).join("")+
      `<div class="st2-sec">ADD YOUR OWN</div>`+
      `<div class="st2-note">Drop a JSON manifest at <b style="color:#a99ccc">${StExt.dir}/&lt;id&gt;.json</b> then run <b style="color:#a99ccc">Extensions: Reload</b>.</div>`+
      `<div class="st2-btn" data-extcmd="__install" style="margin-top:7px;align-self:flex-start">Scaffold an extension…</div>`;
    if(!VFS.node(StExt.dir)) VFS.mkdirp(StExt.dir);
  },

  showExtPanel(title, html){
    this.r.rtabs.querySelectorAll("[data-rt]").forEach(t=>t.classList.remove("on"));
    if(!this._extTab){ this._extTab = document.createElement("div");
      this._extTab.className="st2-rtab"; this._extTab.dataset.rt="__ext";
      this._extTab.addEventListener("mousedown", ()=>this.setRightTab("__ext"));
      this.r.rtabs.appendChild(this._extTab); }
    this._extTab.textContent = title.toUpperCase().slice(0,12);
    this._extTab.classList.add("on");
    this.rightTab = "__ext";
    this.r.rbody.innerHTML = html;
    this.r.rbody.querySelectorAll("[data-goto]").forEach(n=>{
      n.addEventListener("click", ()=>this.openPath(n.dataset.goto, { line:n.dataset.line?+n.dataset.line:undefined }));
    });
  },

  // ================= CYRUS Copilot =================
  buildContext(){
    const path = this.active;
    const c = { file:null, selection:null, symbols:"", errors:"" };
    c.project = StProject.aiContext(this.root);
    c.style = StProject.learn(this.root).summary;
    if(path){
      const t = this.tabs.find(x=>x.path===path);
      const text = this.editor.text;
      const spec = LANG.forPath(path, text);
      const p = this.editor.primary;
      const syms = SYMBOLS.extract(text, spec);
      const enclosing = SYMBOLS.at(syms, this.editor.lineOf(p.e), p.e - this.editor.lineStart(this.editor.lineOf(p.e)));
      c.file = { path, lang:spec.id, body:text.slice(0,16000), truncated:text.length>16000 };
      if(p.s!==p.e){
        const l1=this.editor.lineOf(p.s), l2=this.editor.lineOf(p.e);
        c.selection = { from:l1+1, to:l2+1, text:text.slice(p.s,p.e).slice(0,6000) };
      }
      if(syms.length)
        c.symbols = syms.slice(0,60).map(s=>`${s.kind} ${s.name} :${s.line+1}${s.container?" in "+s.container:""}`).join("\n");
      const errs = this.lastProblems.filter(d=>d.file===path && (d.sev==="err"||d.sev==="warn")).slice(0,12);
      if(errs.length) c.errors = errs.map(d=>`line ${d.line+1}: ${d.msg}`).join("\n");
      c.enclosing = enclosing ? `The cursor is inside ${enclosing.kind} ${enclosing.name} (line ${enclosing.line+1}).` : "";
      const t2 = this.tabs.find(x=>x.path===path);
      if(t2) t2.text = text;
    }
    // A tab can outlive its file on disk (deleted from the explorer, renamed
    // externally), and symbolsFor() has no symbols to report in that case.
    const firstSym = p => { const s = StIndex.symbolsFor(p); return (s && s.syms && s.syms[0] ? s.syms[0].name : ""); };
    c.openFiles = this.tabs.slice(0,8).map(t=>({ path:t.path, note: (t.dirty?"unsaved · ":"") + firstSym(t.path) }));
    return c;
  },
  renderAI(b){
    const ctx = this.buildContext();
    const chips = [];
    if(ctx.file) chips.push(`<span title="current file"><b>${esc(VFS.base(ctx.file.path))}</b><i data-c="file">✕</i></span>`);
    if(ctx.selection) chips.push(`<span><b>selection</b><i data-c="sel">✕</i></span>`);
    if(ctx.enclosing) chips.push(`<span><b>${esc(ctx.enclosing.replace("The cursor is inside ",""))}</b></span>`);
    if(ctx.symbols) chips.push(`<span><b>${(ctx.symbols||"").split("\n").length} symbols</b></span>`);
    if(ctx.errors) chips.push(`<span><b style="color:#e8798f">${this.lastProblems.filter(d=>d.sev==="err").length} errors</b></span>`);
    chips.push(`<span><b>${esc(StProject.resolved(this.root).name)}</b></span>`);
    const quota = this.ai.length ? "" : `<div class="st2-m ai">I read the <b>token stream</b>, not just the text — symbols, imports and diagnostics. Ask anything, or use a quick action.</div>`;
    b.innerHTML = `<div class="st2-msgs" data-r="msgs">${quota}${this.ai.map((m,i)=>this.aiHTML(m,i)).join("")}</div>
      <div class="st2-quick" style="margin-top:10px">
        <button data-ctxact="explain">Explain</button>
        <button data-ctxact="bugs">Find bugs</button>
        <button data-ctxact="refactor">Refactor</button>
        <button data-ctxact="tests">Tests</button>
        <button data-ctxact="docs">Document</button>
        <button data-ctxact="types">Explain types</button>
      </div>`;
    const msgs = b.querySelector('[data-r="msgs"]');
    msgs.scrollTop = msgs.scrollHeight;
    // inline panel input
    const box = el("div","st2-aiin");
    box.innerHTML = `<div class="st2-ctx">${chips.join("")}</div>
      <div class="row"><span data-a="slot"></span><button data-a="send">➤</button></div>`;
    box.querySelector("[data-a=slot]").replaceWith(this.newAIInput());
    b.appendChild(box);
    const ta = box.querySelector("textarea");
    box.querySelector("[data-a=send]").onclick = ()=>this.send();
    box.querySelectorAll("[data-c]").forEach(x=>x.onclick=()=>{
      if(x.dataset.c==="file"){ this.ai=[]; }
      this.renderRight();
    });
    // code-block buttons
    msgs.querySelectorAll(".codeblock button").forEach(btn=>{
      btn.addEventListener("mousedown", e=>{
        e.preventDefault(); e.stopPropagation();
        const msg = this.ai[+btn.closest(".st2-m").dataset.i];
        const blocks = mdCodeBlocks(msg.text);
        const b2 = blocks[+btn.dataset.i];
        if(!b2) return;
        if(btn.dataset.act==="copy"){ this.toast(copied(b2.code),"ok"); return; }
        if(btn.dataset.act==="ask"){ const t2=this.r.rbody.querySelector(".st2-aiin textarea"); if(t2){ t2.value="Explain this code:\n\n"+b2.code; t2.focus(); } return; }
        this.applyCode(b2);
      });
    });
  },
  aiHTML(m, i){
    if(m.role==="user") return `<div class="st2-m user" data-i="${i}">${esc(m.text)}</div>`;
    if(m.role==="sys") return `<div class="st2-m sys" data-i="${i}">${esc(m.text)}</div>`;
    return `<div class="st2-m ai" data-i="${i}">${mdToHtml(m.text)}${m.via?`<div class="md-c" style="margin-top:6px">via ${esc(m.via)}</div>`:""}</div>`;
  },
  aiAdd(role, text, via){
    this.ai.push({ role, text, via });
    if(this.ai.length>40) this.ai.splice(0, this.ai.length-40);
    this.rightTab = "cyrus";
    this.renderRight();
    return text;
  },
  async send(explicit){
    const box = this.r.rbody.querySelector(".st2-aiin textarea");
    // An explicit question comes from askAI() and the quick actions, which never
    // touch the textarea; re-reading it there silently dropped them.
    const v = (explicit!=null ? String(explicit) : (box ? box.value : "")).trim();
    if(!v || this.aiBusy) return;
    if(box && explicit!=null) box.value = "";
    this.aiAdd("user", v);
    this.aiBusy = true;
    const wait = this.aiAdd("ai","⏳ thinking…");
    const c = this.buildContext();
    const mode = /\b(rewrite|refactor|rename|convert|add tests|document|comment|implement)\b/i.test(v) ? "edit" : "chat";
    try{
      const r = await Copilot.ask(c, v, { mode, maxTokens: mode==="edit"?2600:1200 });
      const idx = this.ai.indexOf(wait);
      if(idx>=0) this.ai.splice(idx,1);
      if(r.ok){
        this.aiAdd("ai", r.text, r.viaLabel);
        Log.record("studio: ask "+v.slice(0,60), "ai_query", {q:v.slice(0,200)}, "low", false, true, "Answered via "+r.viaLabel);
      } else {
        this.aiAdd("sys", "CYRUS could not reach the brain ("+((r.errors||[]).join("; ")||"all providers offline")+"). "+
          "Connect one in Settings → CYRUS Brain — a free keyless provider (Pollinations, Puter) is enough for most of this panel.");
      }
    }catch(e){
      const idx = this.ai.indexOf(wait);
      if(idx>=0) this.ai.splice(idx,1);
      this.aiAdd("sys","Request failed: "+e.message);
    }
    this.aiBusy = false;
    this.renderRight();
  },
  // send() records the question itself, so this must not add it a second time.
  askAI(text, opts){ this.setRightTab("cyrus"); this.send(text); this.renderRight(); },
  focusAI(){ this.setRightTab("cyrus"); setTimeout(()=>{ const t=this.r.rbody.querySelector(".st2-aiin textarea"); if(t) t.focus(); },40); },
  quickAction(kind){
    const map = {
      explain:"Explain what this file does, step by step, and why it is written this way.",
      bugs:"Find real bugs, race conditions and edge cases. For each one give the line, why it is wrong, and the exact fix.",
      refactor:"Refactor this to be clearer and easier to test. Keep behaviour identical.",
      tests:"Write unit tests for this file. Match the project's existing conventions.",
      docs:"Add clear documentation to this file. Return the complete file.",
      types:"Explain the types, interfaces and data flow in this file."
    };
    const mode = ["refactor","tests","docs"].includes(kind) ? "edit" : "chat";
    this.aiAdd("user", map[kind]||kind);
    this.setRightTab("cyrus");
    const run = async ()=>{
      const wait = this.aiAdd("ai","⏳ thinking…");
      const c = this.buildContext();
      if(mode==="edit") return this.runAgentic(c, map[kind]);
      const r = await Copilot.ask(c, map[kind]||kind, { mode:"chat" });
      const idx=this.ai.indexOf(wait); if(idx>=0) this.ai.splice(idx,1);
      if(r.ok) this.aiAdd("ai", r.text, r.viaLabel);
      else this.aiAdd("sys","CYRUS could not reach the brain ("+((r.errors||[]).join("; ")||"offline")+").");
      this.renderRight();
    };
    setTimeout(run, 20);
  },
  async runAgentic(c, instruction){
    const path = this.active;
    if(!path){ this.aiAdd("sys","Open a file first."); return; }
    const before = this.editor.text;
    const res = await Copilot.edit(c, instruction, before);
    if(!res.ok){
      this.aiAdd("sys", res.err + (res.prose? "\n\n"+res.prose : ""));
      this.renderRight();
      return;
    }
    this.aiAdd("ai", `Here is the rewrite — <b>${res.stat.add} added, ${res.stat.del} removed</b>. Nothing has been written yet; review the diff and accept it below.`, res.via);
    this.setRightTab("cyrus");
    this.renderRight();
    this.showDiff({ title:path, a:before, b:res.code, rows:res.rows, stat:res.stat, target:path,
      applyLabel:"Accept & write",
      onApply:(final)=>{
        this.editor.setContent(final, true);
        const t = this.tabs.find(x=>x.path===path);
        if(t){ t.text = final; t.dirty = true; }
        this.analyze();
        Log.record("studio: agentic edit "+path, "studio_ai_edit", {path, add:res.stat.add, del:res.stat.del},
                   "medium", true, true, "Accepted an AI rewrite (+"+res.stat.add+" −"+res.stat.del+")");
        this.toast("Applied · save to write to disk","ok");
        this.renderTabs(); this.renderStatus();
      }});
  },
  applyCode(block){
    const p = this.editor.primary;
    if(p.s!==p.e && block.code.trim().length < 4000){
      this.editor.apply(()=> this.editor.content.slice(0,p.s)+block.code+this.editor.content.slice(p.e));
      this.toast("Replaced the selection","ok");
    } else if(block.code.split("\n").length > 5 && (VFS.node(this.active)||{}).content === this.editor.text){
      this.showDiff({ title:this.active, a:this.editor.text, b:block.code, target:this.active,
        applyLabel:"Accept & apply", onApply:(f)=>{ this.editor.setContent(f,true); const t=this.tabs.find(x=>x.path===this.active); if(t) t.text=f; this.analyze(); this.renderTabs(); } });
    } else {
      this.editor.insert("\n"+block.code+"\n");
      this.toast("Inserted at the cursor","ok");
    }
  },
  async fixProblem(){
    const d = this.selectedProblem;
    if(!d){ this.toast("Select a problem in the Problems panel first","warn"); return; }
    if(d.file && d.file!==this.active) this.openPath(d.file, {line:d.line});
    await this.runAgentic(this.buildContext(),
      `Fix the problem CYRUS reported at line ${(d.line||0)+1}: ${d.msg}. Change only what is necessary and keep everything else identical.`);
  },
  // -------------------------------------------------------------------------
  //  DEBUG — the honest kind
  //  There is no debugger in a page: no breakpoints, no stepper, no stack. What
  //  a browser CAN show you truthfully is the token stream everything else is
  //  built on, and exactly which token the caret is sitting in. So that is what
  //  this panel shows, and it works before anything has been run.
  // -------------------------------------------------------------------------
  tokenAt(pos){
    const ed = this.editor;
    if(!ed || pos==null) return null;
    const src = ed.text, spec = ed.spec;
    const toks = LANG.tokenize(src, spec);
    const t = toks.find(x=> pos>=x.s && pos<x.e);
    const line = ed.lineOf(pos);
    const ls = ed.lineStart(line) || 0;
    if(!t) return { kind:"plain", text:src[pos]?src[pos]:"(end of file)", line, col:pos-ls, size:1 };
    return { kind:t.t||"plain", cls:t.c||"", text:src.slice(t.s,t.e), line:ed.lineOf(t.s),
             col:t.s-(ed.lineStart(ed.lineOf(t.s))||0), size:t.e-t.s, start:t.s };
  },
  renderDebug(body){
    const rs = this.runState;
    const spec = this.editor ? this.editor.spec : LANG.forPath("");
    const tok = this.tokenAt(this.editor ? this.editor.primary.e : null);
    const diagAt = tok ? this.lastProblems.filter(p=>p.line===tok.line) : [];
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576)+" MB heap" : "heap not exposed";

    let html = `<div class="st2-sec">CARET</div>`;
    if(tok){
      // tokenize() emits {s,e,t}; the colour comes from the .<kind> CSS rule, so
      // showing the token inside a .st2-hl span shows the real editor colour
      html += `<div class="st2-prow"><span class="cl">token</span><span class="st2-mono st2-hl-inline"><span class="${esc(tok.cls||tok.kind)}">${esc(tok.text.length>60?tok.text.slice(0,60)+"…":tok.text)}</span></span></div>`+
        `<div class="st2-prow"><span class="cl">kind</span><span><span class="st2-badge y">${esc(tok.kind)}</span> coloured by <span class="st2-mono">.${esc(tok.cls||tok.kind)}</span></span></div>`+
        `<div class="st2-prow"><span class="cl">at</span><span>line ${tok.line+1}, col ${tok.col+1} · offsets ${tok.start}–${tok.start+tok.size} · ${tok.size} char${tok.size===1?"":"s"}</span></div>`+
        (diagAt.length ? `<div class="st2-prow"><span class="cl">here</span><span>${diagAt.map(d=>esc(d.msg)).join("<br>")}</span></div>` : "");
    } else {
      html += `<div class="st2-prow"><span class="d">Put the caret in the file to inspect its token.</span></div>`;
    }

    html += `<div class="st2-sec">RUN</div>`;
    if(rs && rs.result){
      const res = rs.result;
      html += `<div class="st2-prow"><span class="cl">file</span><span>${esc(rs.path)}</span></div>`+
        `<div class="st2-prow"><span class="cl">cmd</span><span>${esc(rs.plan.command||"(in-browser)")}${rs.plan.fromManifest?" [manifest]":" [inferred]"}</span></div>`+
        `<div class="st2-prow"><span class="cl">result</span><span class="${res.ok?"g":"e"}">${res.ok?"ok":"failed"} · ${res.kind} · ${Math.round(res.ms||0)}ms</span></div>`;
    } else {
      html += `<div class="st2-prow"><span class="d">Nothing has run yet. The caret readout above works anyway.</span></div>`;
    }

    const toks = LANG.tokenize(this.editor ? this.editor.text : "", spec);
    const byType = {};
    toks.forEach(t=>{ if(t.t) byType[t.t]=(byType[t.t]||0)+1; });
    html += `<div class="st2-sec">TOKEN STREAM (what every other phase reads)</div>`+
      (Object.keys(byType).length
        ? Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="st2-prow"><span class="cl">${esc(k)}</span><span>${v}</span></div>`).join("")
        : `<div class="st2-prow"><span class="d">Empty file.</span></div>`);

    html += `<div class="st2-sec">RUNTIME</div>`+
      `<div class="st2-prow"><span class="cl">heap</span><span>${mem}</span></div>`+
      `<div class="st2-prow"><span class="cl">lines</span><span>${this.editor?this.editor.lineCount():0}</span></div>`+
      `<div class="st2-prow"><span class="cl">language</span><span>${esc(spec.name)} · ${spec.derived?"(derived fallback)":spec.exts.length+" extensions"}</span></div>`+
      `<div class="st2-note" style="margin-top:8px">No breakpoints and no stepper: a page cannot host a debugger. `+
      `What you see above is the real token stream and the real timing of the run — inspect it rather than take it on faith.</div>`;
    body.innerHTML = html;
  },

// -------------------------------------------------------------------------
  //  QUICK FIX
  //  A mechanical fix is one CYRUS derived from the token stream itself, so it
  //  needs no model and is correct for the class of bug it names. An AI fix is
  //  a guess. Both arrive as one diff, and the diff says which tier produced it
  //  — the difference is the whole point, so it is never hidden.
  // -------------------------------------------------------------------------
  fixableFor(src, spec, d){
    return DIAG.quickFix(src, spec, d).find(f=>f.kind==="mechanical") || null;
  },
  quickFix(d, opts){
    opts = opts || {};
    if(!this.active){ this.toast("Open a file first","warn"); return; }
    if(d && d.file && d.file!==this.active) this.openPath(d.file, {line:d.line});
    const src = this.editor.text;
    const spec = LANG.forPath(this.active, src);
    // Fix All only batches safe fixes; unsafe ones (adding `export`) stay one click
    const pool = opts.all ? this.lastProblems : [d].filter(Boolean);
    const chosen = [];
    for(const p of pool){
      const m = this.fixableFor(src, spec, p);
      if(m && (!opts.all || m.safe)) chosen.push(m);
    }

    if(!chosen.length){
      const target = opts.all ? null : d;
      if(target){
        this.toast("No mechanical fix for that — asking CYRUS instead","warn");
        return this.fixProblem();
      }
      this.toast("Nothing here CYRUS can fix on its own","info");
      return;
    }
    const after = DIAG.applyFixes(src, chosen);
    if(after===src){ this.toast("Nothing to change","info"); return; }
    const rows = Diff.lines(src, after);
    this.showDiff({
      title: opts.all ? this.active+" — "+chosen.length+" fixes" : this.active+" — "+chosen[0].label,
      a:src, b:after, rows, stat:Diff.stat(rows), target:this.active,
      tier:"mechanical",
      note: chosen.length>1 ? chosen.map(c=>c.label).join(" · ")
                            : (chosen[0].note || chosen[0].label),
      applyLabel: opts.all ? ("Apply "+chosen.length+" fixes") : "Apply fix",
      onApply:(final)=>{
        this.editor.setContent(final, true);
        const t = this.tabs.find(x=>x.path===this.active);
        if(t){ t.text = final; t.dirty = true; }   // setContent bypasses on.change, so mark it here
        this.analyze();
        Log.record("studio: quick fix "+this.active, "studio_quickfix",
                   {path:this.active, tier:"mechanical", fixes:chosen.map(c=>c.id)},
                   "low", true, true, "Applied "+chosen.length+" mechanical fix(es): "+chosen.map(c=>c.id).join(", "));
        this.toast("Fixed · save to write to disk","ok");
        this.renderTabs(); this.renderStatus(); this.renderPanel();
      }
    });
  },
  fixAllMechanical(){ this.quickFix(null, {all:true}); },

  // Ctrl+.  Uses the problem the caret is sitting on when nothing is selected,
  // which is what you want when your eyes are in the editor, not the panel.
  quickFixSelected(){
    if(!this.active){ this.toast("Open a file first","warn"); return; }
    const src = this.editor.text, spec = LANG.forPath(this.active, src);
    let d = this.selectedProblem;
    if(!d && this.editor){
      const line = this.editor.lineOf(this.editor.primary.e);
      const onLine = this.lastProblems.filter(p=>p.line===line && p.file!==undefined || (p.line===line && !p.file));
      // prefer the worst thing on the caret's line: a bracket error beats a note
      d = onLine.sort((a,b)=>({err:0,warn:1,info:2})[a.sev]-({err:0,warn:1,info:2})[b.sev])[0];
    }
    if(!d){ this.toast("No problem at the cursor","info"); return; }
    this.selectedProblem = d;
    this.quickFix(d);
  },

  // Right-click a problem. The mechanical entry only appears when one exists,
  // so the menu never offers a button that would have to guess.
  problemMenu(x, y, d, mech){
    const items = [];
    if(mech) items.push(["⚡", mech.label, ()=>this.quickFix(d), true]);
    items.push(["✷", "Ask CYRUS to fix this", ()=>this.fixProblem(), d.sev!=="info"]);
    items.push(["?", "Explain this problem", ()=>this.explainProblem(), true]);
    items.push(["→", "Go to it", ()=>{
      if(d.file && d.file!==this.active) this.openPath(d.file, {line:d.line});
      else if(d.line!=null){ const p=this.editor.posAt(d.line,d.col||0); this.editor.setSelection(p,this.editor.lineEnd(d.line)); this.editor.revealLine(d.line); }
    }, d.line!=null]);
    items.push(["⧉", "Copy message", ()=>{ this.toast(copied(d.msg),"ok"); }, true]);
    buildCtxMenu(items, x, y);
  },

  explainProblem(){
    const d = this.selectedProblem;
    if(!d){ this.toast("Select a problem first","warn"); return; }
    this.askAI(`CYRUS's diagnostic engine flagged line ${(d.line||0)+1} of ${d.file}: "${d.msg}". Explain what that means here, whether it is a real bug or a false positive, and what to do.`);
  },

  // ================= navigation =================
  navTo(path, line){
    this.nav.stack = this.nav.stack.slice(0, this.nav.pos+1);
    if(this.active && this.active!==path) this.nav.stack.push({path:this.active, line:this.editor.lineOf(this.editor.caret)});
    this.nav.pos = this.nav.stack.length-1;
    this.openPath(path, { line });
  },
  navBack(){
    if(this.nav.pos<=0) return;
    this.nav.pos--; const n=this.nav.stack[this.nav.pos];
    this.openPath(n.path, {line:n.line});
  },
  navForward(){
    if(this.nav.pos>=this.nav.stack.length-1) return;
    this.nav.pos++; const n=this.nav.stack[this.nav.pos];
    this.openPath(n.path, {line:n.line});
  },
  quickOpen(){
    const recent = StSettings.get("recent")||[];
    const items = StIndex.quickOpen(this.root, "", 400).concat(
      recent.filter(p=>VFS.node(p)).map(p=>({path:p, kind:"recent"})));
    StPalette.open({
      tag:"file", placeholder:"Search files by name or by what's inside them…",
      items,
      render:(it,i)=>{
        const spec = LANG.forPath(it.path);
        const r = it.ranges;
        return `<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">${this.iconFor(it.path)}</span>`+
          `<span class="lbl">${r?Fuzzy.highlight(VFS.base(it.path), r):esc(VFS.base(it.path))}</span>`+
          `<span class="sub">${esc(p2(it.path,this.root))} · ${esc(spec.name)}</span></div>`;
      },
      quick:(q,items)=>StIndex.quickOpen(this.root, q, 40).map(x=>Object.assign(x,{ranges:Fuzzy.match(q,VFS.base(x.path))?.ranges})),
      onPick:(it)=>{ this.navTo(it.path); if(it.why) this.toast(it.why,"ok"); }
    });
  },
  gotoSymbol(){
    if(!this.active){ this.toast("Open a file first","warn"); return; }
    const spec = LANG.forPath(this.active, this.editor.text);
    const syms = SYMBOLS.extract(this.editor.text, spec);
    if(!syms.length){ this.toast("No symbols in this file","warn"); return; }
    StPalette.open({ tag:"symbol", placeholder:"Go to symbol in "+VFS.base(this.active)+"…",
      items:syms,
      render:(s,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">${s.kind==="fn"?"ƒ":s.kind==="cls"?"◈":"▪"}</span>`+
        `<span class="lbl">${esc(s.name)}</span><span class="sub">${s.container?esc(s.container)+" · ":""}line ${s.line+1}</span></div>`,
      quick:(q,items)=>Fuzzy.rank(q,items,x=>x.name).map(x=>x.item),
      onPick:(s)=>{ this.editor.setSelection(this.editor.posAt(s.line,0), this.editor.posAt(s.line,s.col)+s.name.length);
        this.editor.revealLine(s.line); this.editor.focus(); } });
  },
  gotoWorkspaceSymbol(){
    StPalette.open({ tag:"workspace", placeholder:"Go to a symbol anywhere in "+p2(this.root,"~")+"…",
      items:StIndex.symbolSearch(this.root, "", 300),
      render:(s,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">${s.kind==="fn"?"ƒ":s.kind==="cls"?"◈":"▪"}</span>`+
        `<span class="lbl">${esc(s.name)}</span><span class="sub">${esc(p2(s.path,this.root))}${s.container?" › "+esc(s.container):""} · ${s.line+1}</span></div>`,
      quick:(q,items)=>{
        if(!q) return items;
        const byName = Fuzzy.rank(q, items, x=>x.name).map(x=>x.item);
        const seen=new Set(byName.map(x=>x.path+"::"+x.name));
        return byName.concat(items.filter(x=>!seen.has(x.path+"::"+x.name) && (x.container||"").toLowerCase().includes(q.toLowerCase())));
      },
      onPick:(s)=>this.navTo(s.path, s.line) });
  },
  gotoLine(){
    StPalette.open({ tag:"line", placeholder:"Go to line…",
      items:Array.from({length:Math.max(1,this.editor.lineCount())},(_,i)=>i+1),
      render:(n,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">${n}</span><span class="lbl">${esc(this.editor.lineText(n-1).slice(0,80)||"(blank)")}</span></div>`,
      quick:(q,items)=>{ const n=parseInt(q,10); return isNaN(n) ? items.slice(0,30) : items.filter(x=>x>=n).slice(0,30); },
      onPick:(n)=>{ const p=this.editor.posAt(n-1,0); this.editor.setSelection(p,p); this.editor.revealLine(n-1); this.editor.focus(); } });
  },
  findReferences(){
    const w = this.editor.wordAtCaret;
    if(!w){ this.toast("Put the cursor on a name first","warn"); return; }
    const refs = StIndex.references(this.root, w, this.active);
    StPalette.open({ tag:"refs", placeholder:`${refs.length} reference${refs.length===1?"":"s"} to ${w}…`, items:refs,
      render:(r,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">${this.iconFor(r.path)}</span>`+
        `<span class="lbl">${esc(w)}</span><span class="sub">${esc(p2(r.path,this.root))}:${r.line+1}</span></div>`,
      quick:(q,items)=>Fuzzy.rank(q,items,x=>p2(x.path,this.root)).map(x=>x.item),
      onPick:(r)=>this.navTo(r.path, r.line) });
    Log.record("studio: find references "+w, "search_files", {name:w, n:refs.length}, "low", false, true, refs.length+" references");
  },
  referencesPanel(){
    const w = this.editor.wordAtCaret;
    if(!w) return;
    const refs = StIndex.references(this.root, w, this.active);
    this.showExtPanel("References", `<div class="st2-sec">${refs.length} references to <b style="color:var(--accent2)">${esc(w)}</b></div>`+
      refs.map(r=>`<div class="st2-prob info" data-goto="${esc(r.path)}" data-line="${r.line}"><b>${esc(w)}</b><span class="loc">${esc(p2(r.path,this.root))}:${r.line+1}</span></div>`).join(""));
  },

  commandPalette(){
    const items = StCmds.forPalette();
    StPalette.open({ tag:"cmd", placeholder:"Type a command…", items,
      render:(c,i)=>`<div class="st2-pal-i ${i?"on":""}" data-i="${i}"><span class="ic">▸</span>`+
        `<span class="lbl"><b>${esc(c.category)}</b> › ${esc(c.title)}</span>${c.key?`<span class="kc">${esc(c.key)}</span>`:""}</div>`,
      quick:(q,items)=>items.map(c=>({c,m:Fuzzy.match(q, c.category+" "+c.title)})).filter(x=>x.m)
        .sort((a,b)=>b.m.score-a.m.score).map(x=>x.c),
      footer:"<b>↑↓</b> move · <b>enter</b> run · <b>esc</b> dismiss",
      onPick:(c)=>c.run() });
  },
});