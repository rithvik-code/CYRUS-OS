// ---------------------------------------------------------------------------
//  Symbols — structure, not just colour.
// ---------------------------------------------------------------------------
const SYMBOLS = (()=>{
  function lineStarts(src){
    const starts=[0];
    for(let i=0;i<src.length;i++) if(src[i]==="\n") starts.push(i+1);
    return starts;
  }
  function lineOf(starts,pos){
    let lo=0, hi=starts.length-1;
    while(lo<hi){ const mid=(lo+hi+1)>>1; if(starts[mid]<=pos) lo=mid; else hi=mid-1; }
    return lo;
  }

  function extract(src, spec){
    const starts = lineStarts(src);
    const out = [];
    const seen = new Set();
    for(const rule of (spec.sym||[])){
      rule.re.lastIndex = 0;
      let m, guard = 0;
      while((m = rule.re.exec(src)) && guard++ < 2000){
        const name = (m[rule.g]||"").trim();
        if(!name || name.length>80) continue;
        let pos = m.index + m[0].indexOf(name);
        if(pos<0) continue;
        const line = lineOf(starts,pos);
        const col = pos - starts[line];
        const key = rule.kind+":"+name+":"+line;
        if(seen.has(key)) continue;
        seen.add(key);
        // nesting: count indentation depth for the outline
        let depth = 0;
        for(let i=line-1;i>=0;i--){
          const ls = src.slice(starts[i], i+1<starts.length?starts[i+1]-1:src.length);
          const t = ls.trim();
          if(!t) continue;
          const ind = ls.length - ls.replace(/^[ \t]*/,"").length;
          if(ind < col - 1){ depth++; if(depth>8) break; }
          else break;
        }
        out.push({ name, kind:rule.kind, line, col, pos, depth,
                   container: nearestContainer(out, line, col) });
      }
    }
    out.sort((a,b)=> a.line-b.line || a.col-b.col);
    return out.slice(0,900);
  }
  function nearestContainer(list, line, col){
    let best=null;
    for(const s of list){
      if(s.line<=line && (s.line<line || s.col<=col)){
        if(!best || s.line>best.line || (s.line===best.line && s.col>best.col)) best=s;
      }
    }
    return best ? best.name : null;
  }

  // enclosing symbol at a caret position
  function at(list, line, col){
    let best=null;
    for(const s of list){
      if(s.line<=line){
        if(s.kind==="fn"||s.kind==="cls"||s.kind==="int"||s.kind==="let"){
          const end = list.find(x=>x!==s && x.line>s.line && x.depth<=s.depth);
          const eLine = end ? end.line : Infinity;
          if(line < eLine || (line===eLine && (end? col<=end.col : true))){
            if(!best || s.line>=best.line) best=s;
          }
        }
      }
    }
    return best;
  }

  // workspace-wide reference search for an identifier
  function references(src, name, spec){
    const out=[]; const starts=lineStarts(src);
    const re = new RegExp("\\b"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g");
    let m, guard=0;
    while((m=re.exec(src)) && guard++<400){
      out.push({ line: lineOf(starts,m.index), col: m.index-starts[lineOf(starts,m.index)], pos:m.index, len:name.length });
    }
    return out;
  }

  return { extract, at, references, lineStarts, lineOf };
})();

// ---------------------------------------------------------------------------
//  Diagnostics — compiler-free structural analysis, honest about its limits.
// ---------------------------------------------------------------------------
const DIAG = (()=>{
  const SEV = { err:3, warn:2, info:1 };
  // column of the `var` keyword itself, not the char in front of it
  const varIdx = L => { const m=/(^|[^\w.])var\s+[A-Za-z_$]/.exec(L); return m ? m.index+m[1].length : 0; };
  function analyze(src, spec, opts={}){
    const out = [];
    const starts = SYMBOLS.lineStarts(src);
    const lineOf = p => SYMBOLS.lineOf(starts,p);
    // `pos` is the character offset. Fixers need it to build a range edit without
    // re-parsing the source, so every diagnostic carries one from the start.
    const at = p => { const l=lineOf(p); return { pos:p, line:l, col:p-starts[l] }; };
    const atLC = (l,c) => { const p=(starts[l]||0)+c; return { pos:p, line:l, col:c }; };

    // ---- 1. bracket balance, computed from the token stream (so strings and
    //         comments never produce phantom errors)
    const toks = LANG.tokenize(src, spec);
    const stack = [];
    // Angle brackets are deliberately excluded: in every C-family language `<`
    // and `>` are overwhelmingly comparison operators, so pairing them turns
    // `if(x > 1)` into three bogus diagnostics. The highlighter can afford the
    // guess because it only colours text; the balance check cannot.
    const PAIRS = spec.pairs || {};
    const openers = Object.keys(PAIRS).filter(o=>o!=="<" && o!==">");
    const closers = openers.map(o=>PAIRS[o]);
    // Once a mismatch happens the stack no longer describes the file, so
    // anything derived from it afterwards would be a confident lie. `const b =
    // [1,2;` makes the `}` swallow the `[` and the remaining `{` then looks
    // unclosed — appending a `}` would "fix" a file that was missing a `]`.
    let desynced = false;
    for(const t of toks){
      if(t.t!=="op" && t.t!=="pun") continue;
      const ch = src[t.s];
      if(openers.includes(ch)) stack.push({ch, pos:t.s});
      else if(closers.includes(ch)){
        const want = openers.find(o=>PAIRS[o]===ch);
        const top = stack.pop();
        if(!top){ desynced = true;
          out.push({...at(t.s), len:1, sev:"err", msg:`Unexpected closing “${ch}”`, src:"bracket" }); }
        else if(top.ch!==want){
          desynced = true;
          const p=at(top.pos);
          out.push({...p, len:1, sev:"err", msg:`“${top.ch}” closed by “${ch}”`, src:"bracket" });
          const q=at(t.s);
          out.push({...q, len:1, sev:"warn", msg:`Expected “${PAIRS[top.ch]}” to close this`, src:"bracket" });
        }
      }
    }
    // `order` is the opener's depth in the stack, so closing several at once can
    // emit them innermost-first and reconstruct the nesting correctly
    if(!desynced) stack.slice(0,8).forEach((s,i)=>{
      out.push({...at(s.pos), order:i, len:1, sev:"err", msg:`“${s.ch}” is never closed`, src:"bracket" });
    });

    // ---- 2. unterminated strings (tokenizer stops at newline)
    for(const t of toks){
      if(t.t!=="str") continue;
      const text = src.slice(t.s,t.e);
      const open = spec.str.find(s=>text.startsWith(s[0]));
      if(!open) continue;
      const closed = text.length>=open[0].length+open[1].length && text.endsWith(open[1]) && text.slice(-open[1].length-1, -open[1].length)!==undefined
                     && text.trimEnd().endsWith(open[1]);
      if(!closed){
        out.push({...at(t.s), len:Math.min(text.length,60), sev:"err", msg:"String is never closed", src:"string" });
      }
    }

    // ---- 3. line-level rules
    const lines = src.split("\n");
    const MAXL = opts.maxLine || 140;
    for(let i=0;i<lines.length;i++){
      const L = lines[i];
      if(L.length>MAXL) out.push({...atLC(i,MAXL),len:1,sev:"info",msg:`Line is ${L.length} characters`,src:"style"});
      if(/\t/.test(L) && /^ +\S/.test(L.replace(/^\t+/,"")) && spec.indent===4 && /^\t|^\s{2,4}\t/.test(L)){
        out.push({...atLC(i,0),len:1,sev:"warn",msg:"Mixed tabs and spaces in indentation",src:"style"});
      }
      if(spec.regexp){
        const m=/[^=!<>]==[^=]/.exec(L); if(m && !/["'`]/.test(L.slice(Math.max(0,m.index-1),m.index)))
          out.push({...atLC(i,m.index+1),len:2,sev:"warn",msg:"Loose equality — consider ===",src:"quality"});
        if(/(^|[^\w.])var\s+[A-Za-z_$]/.test(L) && !/\/\//.test(L.split(m&&m.index)[0]||""))
          out.push({...atLC(i,varIdx(L)),len:3,sev:"info",msg:"`var` is function-scoped — prefer let/const",src:"quality"});
        if(/\bdebugger\b/.test(L)) out.push({...atLC(i,L.indexOf("debugger")),len:8,sev:"warn",msg:"`debugger` statement left in",src:"quality"});
      }
      if(/\b(TODO|FIXME|HACK|XXX)\b/.test(L))
        out.push({...atLC(i,Math.max(0,L.search(/\b(TODO|FIXME|HACK|XXX)\b/)||L.length-4)),len:4,sev:"info",msg:"Note: "+L.match(/\b(TODO|FIXME|HACK|XXX)\b/)[0],src:"note"});
      if(spec.id==="python" && /^\s*except\s*:/.test(L))
        out.push({...atLC(i,L.indexOf("except")),len:6,sev:"warn",msg:"Bare except swallows every error",src:"quality"});
      if(spec.id==="cpp" && /^\s*#\s*include\s*<[^>]*\.h>/.test(L))
        out.push({...atLC(i,0),len:1,sev:"info",msg:"C header in C++ — prefer the matching .hpp",src:"style"});
      if(/\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"']{6,}["']/i.test(L))
        out.push({...atLC(i,Math.max(0,L.search(/\b(password|passwd|secret|api[_-]?key|token)\b/i))),len:4,sev:"warn",msg:"Possible hard-coded secret",src:"security"});
    }

    // ---- 4. unused imports (high signal, low false-positive)
    const imported = [];
    // Branch on language identity, never on a loose flag. `spec.fam` is "c" for
    // almost everything curly-braced (including JavaScript) and `spec.regexp`
    // is true for most of them too, so either test misroutes #include and
    // import rules. Only these languages actually spell it #include.
    const C_INCLUDE = new Set(["c","cpp","objectivec"]);
    if(spec.id==="python"){
      const re=/^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import[ \t]+(.+)|import[ \t]+([.\w, ]+))$/gm;
      let m;
      while((m=re.exec(src))){
        const names=(m[2]||m[3]||"").split(",").map(s=>s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
        names.forEach(n=> imported.push({name:n.replace(/^\./,""), pos:m.index}));
      }
    } else if(C_INCLUDE.has(spec.id)){
      const re=/^[ \t]*#\s*include\s*[<"]([^>"]+)[>"]/gm;
      let m;
      while((m=re.exec(src))) imported.push({name:null, pos:m.index, header:m[1]});
    } else if(spec.regexp || spec.id==="typescript" || spec.id==="javascript"){
      const re=/^[ \t]*import[ \t]+(?:([A-Za-z_$][\w$]*)[ \t]*,?\s*)?(?:.*?from\s*)?["'][^"']+["']/gm;
      let m;
      while((m=re.exec(src))) if(m[1]) imported.push({name:m[1], pos:m.index});
      const re2=/^[ \t]*const[ \t]*\{([^}]*)\}[ \t]*=[ \t]*require\(/gm;
      while((m=re2.exec(src))) m[1].split(",").forEach(n=>{ const nm=n.trim().split(":").pop().trim(); if(nm) imported.push({name:nm,pos:m.index}); });
    } else if(spec.fam==="c"){
      const re=/^[ \t]*#\s*include[ \t]*[<"]([^>"]+)[>"]/gm;
      let m;
      while((m=re.exec(src))) imported.push({name:null, pos:m.index, header:m[1]});
    }
    const bodyNoImports = src.replace(/^[ \t]*(?:import|from|#\s*include|use)[^\n]*$/gm,"");
    for(const im of imported){
      if(im.name){
        const uses = (bodyNoImports.match(new RegExp("\\b"+im.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g"))||[]).length;
        if(uses===0) out.push({...at(im.pos), len:im.name.length, sev:"info", msg:`“${im.name}” is imported but never used`, src:"unused"});
      } else if(im.header){
        const guard = new RegExp("#\\s*ifndef\\s+_?"+im.header.replace(/[^\w]/g,"").toUpperCase());
        if(!guard.test(src)) out.push({...at(im.pos), len:im.header.length+9, sev:"warn", msg:`“${im.header}” has no include guard`, src:"quality"});
      }
    }

    // ---- 5. defined-but-never-referenced functions (info only)
    const syms = SYMBOLS.extract(src, spec);
    for(const s of syms){
      if(s.kind!=="fn") continue;
      if(/^(test_|Test|setUp|tearDown|main|__)/.test(s.name)) continue;
      const line = src.slice(starts[s.line], starts[s.line+1]||src.length);
      const uses = (src.match(new RegExp("\\b"+s.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g"))||[]).length;
      if(uses<=1 && line.length<400) out.push({...atLC(s.line,s.col), len:s.name.length, sev:"info", name:s.name, msg:`“${s.name}” is defined but never referenced`, src:"unused"});
    }

    out.sort((a,b)=> a.line-b.line || a.col-b.col || SEV[b.sev]-SEV[a.sev]);
    return out.slice(0,200);
  }

  const runnerPatterns = [
    { re:/^([\w./\\-]*?)(\w+)\.(\w+):(\d+):?\s*(.*)$/, sev:"err", msg:m=>`${m[2]}.${m[3]} — ${m[5]||m[4]}`, file:m=>m[1]?m[1]+"."+m[2]:"", line:m=>+m[4] },
    { re:/^Traceback \(most recent call last\)/, sev:"err", msg:()=>"Python traceback", file:()=>null, line:()=>0, bare:true },
    { re:/^\s*File "([^"]+)", line (\d+)/, sev:"err", msg:m=>"Python traceback", file:m=>m[1], line:m=>+m[2] },
    { re:/^([\w./\\-]+):(\d+):(\d+):?\s*(?:fatal\s+)?(?:error|Error)(.*)$/, sev:"err", msg:m=>"Compiler error", file:m=>m[1], line:m=>+m[2] },
    { re:/^(?:.*?\b)?(Warning|warning|warn)\b:?\s*(.*)$/, sev:"warn", msg:m=>m[1]+": "+m[2], file:()=>null, line:()=>0 },
    { re:/^(.*?):(\d+):(\d+):?\s*note:/, sev:"info", msg:m=>"Note: "+m[1], file:m=>m[1], line:m=>+m[2] },
    { re:/^\s*(?:ERROR|Error|error):\s*(.*)$/, sev:"err", msg:m=>m[1], file:()=>null, line:()=>0 },
    { re:/^\s*(WARN|Warning|warning):\s*(.*)$/, sev:"warn", msg:m=>m[1], file:()=>null, line:()=>0 },
  ];

  // turn raw runner output into clickable problems
  function fromOutput(text, fileHint){
    const out=[];
    const src = String(text);
    // a bare "Traceback ..." header is only interesting when no frame line follows it
    const hasFrames = /^\s*File\s+"[^"]+",\s*line\s+\d+/m.test(src);
    for(const line of src.split("\n").slice(0,400)){
      for(const p of runnerPatterns){
        if(p.bare && hasFrames) continue;
        const m = p.re.exec(line);
        if(m){
          const f = p.file(m);
          out.push({ file: f && !/^<|^\//.test(f) ? f : (fileHint||null), line: p.line(m)||0, col:0, len:1,
                     sev:p.sev, msg:p.msg(m), src:"run", raw:line });
          break;
        }
      }
    }
    return out;
  }

  const counts = list => list.reduce((a,d)=>{ a[d.sev]=(a[d.sev]||0)+1; return a; }, {});
  // ---------------------------------------------------------------------------
  //  QUICK FIX
  //  Two tiers, and the difference matters more than anything else in here:
  //
  //    mechanical — CYRUS already proved the bug from the token stream, so it
  //                 computes the patch itself. No model is consulted and the
  //                 fix is correct for the class of error it claims.
  //    ai         — a guess. Offered because a human still reviews the diff,
  //                 never because CYRUS knows the answer.
  //
  //  A fix is a list of range edits {start, end, insert} rather than a
  //  replacement string, so it can be previewed, applied out of order and
  //  combined with other fixes without any of them invalidating the others.
  // ---------------------------------------------------------------------------
  // `safe` means "batching this changes nothing the author meant to write".
  // Safe fixes are what "Fix all" is allowed to apply together. Adding a
  // keyword like `export` is mechanical and correct but it changes the module's
  // public surface, so it stays a one-at-a-time decision.
  const M = (id, label, edits, note, order, safe) =>
    ({ id, label, kind:"mechanical", edits, note:note||"", order:order||0, safe:safe!==false });
  const A = (id, label) => ({ id, label, kind:"ai", edits:null, note:"" });
  const lineEndOf = (src, pos) => { const n=src.indexOf("\n", pos); return n<0 ? src.length : n; };
  const eof = src => src.replace(/[ \t]*\n?$/,"").length;

  function quickFix(src, spec, d){
    if(!d) return [];
    const fixes = [];
    const at1 = d.pos==null ? 0 : d.pos;

    // ---- brackets ------------------------------------------------------
    let m;
    if(d.src==="bracket" && (m=/^“(.+?)” is never closed$/.exec(d.msg))){
      const closer = (spec.pairs||{})[m[1]];
      if(closer) fixes.push(M("bracket.close", `Insert the missing “${closer}”`, [{start:eof(src), end:eof(src), insert:closer}], "", d.order));
    }
    if(d.src==="bracket" && (m=/^Expected “(.+?)” to close this$/.exec(d.msg))){
      // Deliberately no mechanical fix here. A mismatched pair means the parser
      // lost sync, and the right place for the missing closer is genuinely
      // ambiguous: `if(x > 1 {` would come back as `if(x >) 1 {`. That is a
      // guess wearing the costume of a certainty, so it goes to the model.
    }
    if(d.src==="bracket" && (m=/^Unexpected closing “(.+?)”$/.exec(d.msg))){
      const opener = Object.keys(spec.pairs||{}).find(o=>spec.pairs[o]===m[1]);
      if(opener) fixes.push(M("bracket.open", `Insert the missing opening “${opener}”`, [{start:at1, end:at1, insert:opener}]));
    }

    // ---- strings --------------------------------------------------------
    if(d.src==="string"){
      const quote = /^[“'"]/.test(d.msg) ? null : src[at1];
      if(quote) fixes.push(M("string.close", `Close the string with “${quote}”`,
        [{start:lineEndOf(src,at1), end:lineEndOf(src,at1), insert:quote}]));
    }

    // ---- unused imports --------------------------------------------------
    if(d.src==="unused" && (m=/^“(.+?)” is imported but never used$/.exec(d.msg))){
      const ls = src.lastIndexOf("\n", at1-1)+1;          // statement start
      let le = src.indexOf("\n", ls); if(le<0) le = src.length;
      const stmt = src.slice(ls, le);
      // only delete when the statement really does nothing but import this one
      const single = spec.id==="python"
        ? new RegExp("^\\s*(?:import|from)\\s+.*\\b"+m[1]+"\\b.*$").test(stmt)
        : /^\s*(?:import\s+[\w$]+\b|const\s*\{)/.test(stmt);
      if(single) fixes.push(M("unused.import", `Remove the unused import of “${m[1]}”`,
        [{start:ls, end:le, insert:""}], "deletes one line"));
    }
    if(d.src==="unused" && (m=/^“(.+?)” is defined but never referenced$/.exec(d.msg))){
      const ls = src.lastIndexOf("\n", at1-1)+1;
      if((spec.regexp || spec.id==="typescript") && /^\s*(function|const|let|class)\b/.test(src.slice(ls,ls+40)) && !/\bexport\b/.test(src.slice(ls,ls+20))){
        fixes.push(M("unused.export", `Export “${m[1]}” so it is referenced`, [{start:ls, end:ls, insert:"export "}], "", 0, false));
      }
    }

    // ---- quality --------------------------------------------------------
    if(d.src==="quality" && d.msg.indexOf("Loose equality")===0){
      const op = src.substr(at1,2);
      const strict = op==="!=" ? "!==" : "===";
      fixes.push(M("eq.strict", `Use “${strict}”`, [{start:at1, end:at1+2, insert:strict}]));
    }
    if(d.src==="quality" && d.msg.indexOf("`var`")===0)
      fixes.push(M("var.let", "Use “let” instead of “var”", [{start:at1, end:at1+3, insert:"let"}]));
    if(d.src==="quality" && d.msg.indexOf("Bare except")===0)
      fixes.push(M("except.ex", "Catch “Exception” explicitly",
        [{start:at1+6, end:at1+6, insert:" Exception"}]));
    if(d.src==="quality" && (m=/^“(.+?)” has no include guard$/.exec(d.msg))){
      const guard = m[1].replace(/[^\w]/g,"").toUpperCase();
      fixes.push(M("guard.add", `Wrap in include guard “${guard}”`, [
        {start:0, end:0, insert:`#ifndef ${guard}\n#define ${guard}\n`},
        {start:eof(src), end:eof(src), insert:`\n#endif // ${guard}`}
      ]));
    }

    // ---- style ----------------------------------------------------------
    if(d.src==="style" && d.msg.indexOf("Mixed tabs and spaces")===0){
      const ls = src.lastIndexOf("\n", at1-1)+1;
      let le = src.indexOf("\n", ls); if(le<0) le = src.length;
      const body = src.slice(ls, le);
      const width = /^\t/.test(body) ? (spec.indent||2) : 2;
      const ind = /^[ \t]*/.exec(body)[0];
      const vis = ind.replace(/\t/g, " ".repeat(width));
      if(vis!==ind) fixes.push(M("style.indent", "Normalise the indentation",
        [{start:ls, end:ls+ind.length, insert:vis}], "tabs become spaces"));
    }

    // Everything else is a judgement call, so it goes to the model — and says so.
    if(!fixes.length) fixes.push(A("ai.propose", "Ask CYRUS to fix this"));
    return fixes;
  }

  // Apply many fixes at once. Edits run right-to-left so every offset stays
  // valid, and edits sharing one offset are merged into a single splice — that
  // is what lets two unclosed brackets both get their closer appended instead of
  // the second one being discarded as an overlap.
  function applyFixes(src, fixes){
    const groups = new Map();
    fixes.forEach((f,fi)=>{
      (f.edits||[]).forEach((e,ei)=>{
        const k = e.start;
        if(!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ e, f, fi, ei });
      });
    });
    let out = src;
    for(const k of [...groups.keys()].sort((a,b)=> b-a)){
      const g = groups.get(k);
      // replacements that actually consume text come first; then insertions,
      // innermost opener first, so `(` then `{` closes as `)}` and not `}{`
      g.sort((a,b)=>
        (b.e.end - a.e.end) ||
        ((b.f.order||0) - (a.f.order||0)) ||
        (b.fi - a.fi));
      const ins = g.map(x=>x.e.insert).join("");
      const end = Math.max(...g.map(x=>x.e.end));
      out = out.slice(0,k) + ins + out.slice(end);
    }
    return out;
  }

  return { analyze, fromOutput, counts, SEV, quickFix, applyFixes };
})();