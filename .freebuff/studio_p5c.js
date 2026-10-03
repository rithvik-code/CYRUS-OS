// ---------------------------------------------------------------------------
//  Copilot — the AI surfaces
// ---------------------------------------------------------------------------
const Copilot = {
  ctx(app){ return app && typeof app.buildContext==="function" ? app.buildContext() : {}; },

  systemPrompt(c, mode){
    const base = [
      "You are CYRUS Copilot, the assistant inside CYRUS Studio — an AI-native code editor.",
      "You are given REAL STRUCTURE, not a blind file dump: the file's symbols, its imports, the enclosing function.",
      c.project ? "PROJECT CONTEXT:\n"+c.project : "",
      c.style ? "OBSERVED PROJECT STYLE: "+c.style : "",
      c.errors ? "DIAGNOSTICS CYRUS ITSELF REPORTED:\n"+c.errors : "",
      c.symbols && c.symbols.length ? "SYMBOLS IN THIS FILE:\n"+c.symbols : ""
    ].filter(Boolean).join("\n\n");
    if(mode==="edit"){
      return base + "\n\nTASK: rewrite the file so it satisfies the request. "+
        "Return ONLY the complete new file inside one fenced code block with the correct language tag. "+
        "No prose before or after it. Preserve everything you were not asked to change, "+
        "match the project's existing style, and never invent APIs you were not given.";
    }
    if(mode==="inline"){
      return base + "\n\nTASK: continue the code at the cursor. Return ONLY the code that should appear next, "+
        "no fences, no prose, no repetition of what is already there. Maximum 6 lines. "+
        "If nothing sensible follows, return nothing.";
    }
    return base + "\n\nAnswer the developer's question precisely. "+
      "Lead with the answer, then the reasoning. Be concise — this is an editor panel, not an essay. "+
      "When you show code, put it in one fenced block with the right language tag. "+
      "If the file is already correct, say so plainly instead of inventing work.";
  },

  buildMessages(c, userText, mode){
    const msgs = [{ role:"system", content:this.systemPrompt(c, mode||"chat") }];
    if(c.file){
      let f = c.file;
      let head = "FILE: " + c.file.path + "\n";
      if(c.selection && c.selection.text) head += "SELECTION (lines "+c.selection.from+"–"+c.selection.to+"):\n"+c.selection.text+"\n";
      head += "```"+(c.file.lang||"")+"\n"+c.file.body+"\n```";
      msgs.push({ role:"user", content: head + "\n\n" + userText });
    } else if(c.files && c.files.length){
      const list = c.files.map(f=>"• "+f.path+" — "+f.note).join("\n");
      msgs.push({ role:"user", content:"Workspace files:\n"+list+"\n\n"+userText });
    } else {
      msgs.push({ role:"user", content: userText });
    }
    return msgs;
  },

  async ask(c, userText, opts){
    opts = opts || {};
    const r = await Router.chat(this.buildMessages(c, userText, opts.mode),
      { taskType: opts.taskType || "reasoning", temperature: opts.temperature==null?0.25:opts.temperature, maxTokens: opts.maxTokens || 1200 });
    return r;
  },

  // ---- inline autocomplete ------------------------------------------------
  async complete(c, prefix, suffix){
    const msgs = [
      { role:"system", content:this.systemPrompt(c,"inline") },
      { role:"user", content:
        "FILE: " + c.file.path + "\n" +
        "--- BEFORE THE CURSOR ---\n" + prefix.slice(-1400) + "\n" +
        "--- CURSOR IS HERE ---\n" +
        "--- AFTER THE CURSOR ---\n" + suffix.slice(0, 500) +
        "\n\nReturn the code that goes at the cursor." }
    ];
    const r = await Router.chat(msgs, { taskType:"fast", temperature:0.05, maxTokens:110 });
    if(!r.ok) return null;
    let t = String(r.text||"");
    t = t.replace(/^```[\w+#.-]*\n?/,"").replace(/```\s*$/,"");
    // drop a leading fragment that duplicates what the user already typed
    const lines = prefix.split("\n");
    const lastLine = lines[lines.length-1]||"";
    if(t.split("\n")[0] && lastLine && t.split("\n")[0].startsWith(lastLine))
      t = t.split("\n").slice(1).join("\n");
    t = t.replace(/\s+$/,"");
    if(!t || t.length>400) return null;
    if(!/[A-Za-z0-9_)}]/.test(t)) return null;
    return { text:t, via:r.viaLabel };
  },

  // ---- agentic edit --------------------------------------------------------
  // Ask for a rewrite, extract the fenced block, return a candidate the caller
  // can show as a diff. Nothing is written until the human accepts.
  async edit(c, instruction, currentText){
    const msgs = [
      { role:"system", content:this.systemPrompt(c,"edit") },
      { role:"user", content:
        "FILE: " + c.file.path + "\n" +
        "CURRENT CONTENT:\n```" + (c.file.lang||"") + "\n" + currentText + "\n```\n\n" +
        "CHANGE REQUESTED: " + instruction }
    ];
    const r = await Router.chat(msgs, { taskType:"reasoning", temperature:0.15, maxTokens:2600 });
    if(!r.ok) return { ok:false, err:"CYRUS could not reach the brain ("+((r.errors||[]).join("; ")||"offline")+")." };
    let blocks = mdCodeBlocks(r.text);
    if(!blocks.length){
      // the model answered in prose — say so rather than inventing a patch
      return { ok:false, prose:r.text, err:"CYRUS answered in prose instead of returning a file. Nothing was changed." };
    }
    // prefer a block whose language matches the file
    let pick = blocks.find(b=> b.lang && LANG.byName(b.lang) && b.lang.toLowerCase().startsWith(c.file.lang));
    if(!pick) pick = blocks[blocks.length-1];
    const before = currentText;
    const after = pick.code;
    if(before===after) return { ok:false, prose:r.text, err:"CYRUS returned the file unchanged. Nothing to apply." };
    const rows = Diff.lines(before, after);
    const st = Diff.stat(rows);
    return { ok:true, code:after, rows, stat:st, via:r.viaLabel, raw:r.text };
  }
};