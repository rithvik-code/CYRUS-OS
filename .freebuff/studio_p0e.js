// ---------------------------------------------------------------------------
//  HL — tokens + overlay decorations → HTML for the editor layer
//  Decorations: find matches, occurrence highlight, multi-cursor selections,
//  folded regions, diagnostics underlines, inline-AI ghost text, diff bands.
// ---------------------------------------------------------------------------
const HL = (()=>{
  const ESC = { "&":"&amp;", "<":"&lt;", ">":"&gt;" };
  const e = s => s.replace(/[&<>]/g, c=>ESC[c]);

  function render(src, spec, deco){
    const toks = LANG.tokenize(src, spec);
    deco = deco || {};
    const marks = [];

    // ---- 1. diagnostic underlines + diff bands + folded regions
    const lineStarts = SYMBOLS.lineStarts(src);
    const at = p => { let l=SYMBOLS.lineOf(lineStarts,p); return {s:lineStarts[l], e:(lineStarts[l+1]!==undefined?lineStarts[l+1]:src.length)}; };
    for(const d of (deco.problems||[])){
      const r = at(d.line!=null?lineStarts[d.line]||0 : 0);
      const off = d.line!=null && d.col!=null ? d.col : 0;
      marks.push({ s:r.s+Math.max(0,off), e:r.s+Math.max(0,off)+Math.max(1,d.len||1), c:"d-"+(d.sev==="err"?"er":d.sev==="warn"?"wr":"in"), t:"wave" });
    }
    for(const m of (deco.matches||[])) marks.push({ s:m.s, e:m.e, c:"mtch", t:"box" });
    for(const m of (deco.occurrences||[])) marks.push({ s:m.s, e:m.e, c:"occ", t:"box" });
    for(const m of (deco.sel2||[])) marks.push({ s:m.s, e:m.e, c:"sel2", t:"box" });
    for(const m of (deco.folded||[])) marks.push({ s:m.s, e:m.e, c:"fold", t:"fold" });
    for(const m of (deco.occWord||[])) marks.push({ s:m.s, e:m.e, c:"curw", t:"box" });

    // ---- 2. splice tokens + marks into one ordered stream
    const all = toks.map(t=>({s:t.s,e:t.e,c:t.t})).filter(t=>t.c);
    for(const m of marks) all.push(m);
    all.sort((a,b)=> a.s-b.s || (a.e-b.e));

    let html = "", cur = 0;
    for(const t of all){
      if(t.s < cur) continue;                     // overlapping: first wins
      if(t.s > cur) html += e(src.slice(cur,t.s));
      const body = e(src.slice(t.s,t.e));
      html += t.c
        ? '<span class="'+t.c+(t.t&&t.t!=="box"?' '+(t.t==="wave"?"wavy":t.t):"")+'">'+body+'</span>'
        : body;
      cur = t.e;
    }
    if(cur < src.length) html += e(src.slice(cur));

    // ---- 3. ghost text (inline autocomplete) appended after the caret line
    if(deco.ghost && deco.ghost.pos!=null && deco.ghost.text){
      // rebuild with the ghost split out at exactly that offset
      return render2(src, spec, deco, deco.ghost);
    }
    // trailing newline keeps the last (empty) line tall enough to click into
    if(src.endsWith("\n")) html += "\n";
    return html;
  }

  function render2(src, spec, deco, ghost){
    const html = render(src, spec, Object.assign({}, deco, {ghost:null}));
    const pos = ghost.pos;
    const gtext = ghost.text;
    const esc = s => String(s).replace(/[&<>]/g, c=>ESC[c]);
    // split the rendered html at `pos` by walking the raw source length
    let seen = 0, out = "", i = 0;
    while(i < html.length && seen < pos){
      const c = html[i];
      if(c==="&"){ const m=/^&(amp|lt|gt);/.exec(html.slice(i)); if(m){ seen += m[0]==="&amp;"?1:m[0]==="&lt;"?1:1; out+=m[0]; i+=m[0].length; continue; } }
      if(c==="<"){ const j=html.indexOf(">",i); const tag=html.slice(i,j+1); out+=tag; i=j+1; continue; }
      if(c==="\n"){ seen++; out+=c; i++; continue; }
      seen++; out+=c; i++;
    }
    const rest = html.slice(i);
    out += '<span class="ghost">'+esc(gtext)+"</span>"+rest;
    return out;
  }

  // minimap strips: one short run per token, scaled down
  function minimapRuns(src, spec, widthPx){
    const toks = LANG.tokenize(src, spec);
    const colW = 1.6;
    const runs = [];
    let prevColor = null;
    for(const t of toks){
      if(t.t!=="kw" && t.t!="str" && t.t!=="cmt" && t.t!=="num" && t.t!=="fn" && t.t!=="bi" && t.t!=="kw") continue;
      const line = src.slice(0,t.s).split("\n").length;
      const lineStart = t.s - src.lastIndexOf("\n", t.s-1) - 1;
      const col = t.s - lineStart;
      const color = { kw:"#8f5fc4", str:"#5f9e52", cmt:"#463c63", num:"#b07a45", fn:"#c9a850", bi:"#4d84c4" }[t.t];
      runs.push({ y: line*2, x: Math.floor(col*colW), w: Math.max(1, Math.round((t.e-t.s)*colW)), c:color });
      prevColor = color;
    }
    return runs;
  }

  return { render, minimapRuns };
})();