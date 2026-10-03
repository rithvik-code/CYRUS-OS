// ---------------------------------------------------------------------------
// PHASE 4 — THE RUNNER
// What can actually run in a browser runs for real (JavaScript, JSON, HTML).
// What cannot is never faked: the panel names the host command, offers to copy
// it, and says plainly why it cannot run here. Honesty is the product thesis.
// ---------------------------------------------------------------------------
const StRun = {
  hostRuntime: { python:"python3", node:"node", rust:"cargo run", go:"go run", ruby:"ruby",
                 java:"java", php:"php", lua:"lua", r:"Rscript", julia:"julia", swift:"swift run" },
  runnable(langId){ return ["javascript","typescript","json","jsonc","html","xml","css","markdown"].includes(langId); },

  // resolve the command CYRUS would run, from the manifest when it declares one
  plan(root, path, content){
    const spec = LANG.forPath(path||"", content||"");
    const cfg = StProject.runFor(root, path);
    if(cfg) return { name:cfg.name||"run", command:cfg.command, watch:cfg.watch||[], fromManifest:true, spec };
    const host = this.hostRuntime[spec.id];
    return { name:"run", command: host ? `${host} ${path.replace(root+"/","")}` : null,
             watch:[], fromManifest:false, spec, noHost:!host && !this.runnable(spec.id) };
  },

  // execute. returns {ok, out, err, ms, kind}
  async exec(root, path, content){
    const t0 = performance.now();
    const spec = LANG.forPath(path||"", content||"");
    const r = { kind:spec.id, ok:true, out:"", err:"", ms:0, cmd:this.plan(root,path,content).command };

    if(spec.id==="json" || spec.id==="jsonc"){
      try{
        JSON.parse(String(content).replace(/^\s*\/\/.*$/gm,""));
        r.out = "Valid JSON ✓";
      }catch(e){ r.ok=false; r.err = e.message; }
      r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="html" || spec.id==="xml"){
      r.kind = "preview"; r.preview = content; r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="markdown"){
      r.kind = "preview"; r.preview = renderMarkdown(content); r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="css"){
      r.kind = "preview";
      r.preview = `<style>${content}</style><div style="font-family:system-ui;padding:20px;color:#111;background:#fff">
        <h1>Heading</h1><p>Paragraph text to show the stylesheet in context.</p>
        <button>Button</button><a href="#">Link</a></div>`;
      r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="javascript" || spec.id==="typescript"){
      let src = content;
      if(spec.id==="typescript"){
        src = stripTypes(content);
        r.out = "Type annotations stripped — CYRUS runs the JavaScript subset.\n";
      }
      r.kind = "js";
      const logs = [];
      const MAX = 4000;
      const fmt = a => a.map(x=>{ try{ return typeof x==="object"&&x!==null ? JSON.stringify(x) : String(x); }catch(e){ return String(x); } }).join(" ");
      const con = { log:(...a)=>logs.push(fmt(a)), info:(...a)=>logs.push(fmt(a)),
                    warn:(...a)=>logs.push("⚠ "+fmt(a)), error:(...a)=>{ logs.push("✖ "+fmt(a)); },
                    debug:(...a)=>logs.push(fmt(a)), table:(...a)=>logs.push(fmt(a)),
                    time:()=>{}, timeEnd:()=>{} };
      try{
        const fn = new Function("console","fetch","setTimeout","clearTimeout","setInterval","clearInterval",
                                "window","document","localStorage","alert","prompt","confirm", src + "\n//# sourceURL=" + path);
        const guarded = t => { if(logs.length>MAX) throw new Error("stopped after "+MAX+" log lines"); };
        await Promise.race([
          fn(con, undefined, (f,t)=>setTimeout(f,t), clearTimeout, setTimeout, clearInterval,
             undefined, undefined, undefined, undefined, undefined, ()=>false),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error("execution exceeded 3s — possible infinite loop")),3000))
        ]);
      }catch(e){
        r.ok = false;
        r.err = e.message;
        const m = /(\w+\.html?):(\d+)/.exec(e.stack||"");
        if(m) r.at = { line:+m[2] };
      }
      r.out = (r.out||"") + (logs.length ? logs.join("\n") : (r.ok ? "(ran — no console output)" : ""));
      r.ms = performance.now()-t0; return r;
    }
    if(spec.id==="python"){
      r.kind = "python";
      const py = PyRun.run(content);
      r.out = py;
      if(/Traceback|Unsupported|SyntaxError/.test(py)) r.ok = false;
      r.note = "PyRun is a line-level sandbox: print and assignment are real; loops and control flow are not evaluated.";
      r.ms = performance.now()-t0; return r;
    }
    // everything else: name the command, do not pretend
    r.kind = "unavailable";
    r.ok = false;
    r.out = "No host runtime for " + spec.name + " inside the browser.";
    r.err = r.cmd ? `Run this in your terminal:\n\n  ${r.cmd}` : `CYRUS has no runner for .${(path.split(".").pop()||"")} — add a run config to ${MANIFEST}.`;
    r.ms = performance.now()-t0;
    return r;
  },

  // a run written to the audit log, exactly like every other OS action
  record(root, path, res){
    Log.record(`studio: run ${VFS.base(path)}`, "run_script", {path, kind:res.kind, ms:Math.round(res.ms)},
               res.ok ? "low" : "medium", false, res.ok,
               res.ok ? `Ran ${VFS.base(path)} (${res.kind}, ${Math.round(res.ms)}ms)` : `Run failed: ${(res.err||"").split("\n")[0]}`);
  }
};

function stripTypes(src){
  let s = src;
  s = s.replace(/^\s*(?:export\s+)?(?:interface|type)\s+\w+[\s\S]*?^\}/gm, "");
  s = s.replace(/\binterface\s+\w+\s*(?:extends\s+\w+\s*)?\{[^}]*\}/g, "");
  s = s.replace(/\btype\s+\w+\s*=\s*[^;]+;/g, "");
  s = s.replace(/^\s*import\s+type\b[^\n]*\n/gm, "");
  // `declare` statements are types-only: they have no runtime meaning at all,
  // so the whole line goes rather than trying to strip its annotations.
  s = s.replace(/^\s*declare\s+[^\n]*\n?/gm, "");
  s = s.replace(/\bas\s+const\b/g, "");
  // generic parameter list on an arrow function: <T,>(v) => ... -> (v) => ...
  s = s.replace(/<[A-Za-z_$][\w$<>\[\]|&.,\s]*,?>\s*(?=\()/g, "");
  // variable annotations: const x: number = 5  ->  const x = 5
  s = s.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>\[\]|&., ]*\s*=/g, "$1 $2 =");
  // value-position casts: x as Foo<T> -> x. Lookbehind so `a as B as C` fully strips;
  // `import { a as b }` is unaffected because `{` precedes the keyword.
  s = s.replace(/(?<=[\w$)\]])\s+as\s+[A-Za-z_$][\w$]*(?:<[^<>()]*>)?/g, "");
  // explicit type arguments on calls: foo<number>(x) -> foo(x)
  s = s.replace(/([\w$)\]])<[^<>()]*>(?=\s*\()/g, "$1");
  // return types: `): string {` -> `) {`. Runs BEFORE the parameter rule so the
  // parameter rule cannot chew the closing paren of a signature.
  s = s.replace(/(\))\s*:\s*[A-Za-z_$][\w$<>\[\]|&., ]*(\s*(?:\{|=>))/g, "$1$2");
  // parameter types: anchored to "(" or "," so object literals, ternaries and
  // labels (`{a: 1}`, `x ? a : b`, `case 1:`) are never mistaken for one.
  s = s.replace(/([(,]\s*)([A-Za-z_$][\w$]*)\s*\??\s*:\s*[A-Za-z_$][\w$<>\[\]|&., ]*(?=\s*[,)=])/g, "$1$2");
  s = s.replace(/\b(private|public|protected|readonly)\s+/g, "");
  s = s.replace(/\?\s*:/g, ":");
  s = s.replace(/!\./g, ".");
  return s;
}

function renderMarkdown(src){
  const escH = s => s.replace(/[&<>]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const blocks = [];
  let out = "", i = 0;
  while(i < src.length){
    const fence = /^```([\w-]*)\n([\s\S]*?)^```/m.exec(src.slice(i));
    if(fence){ out += "<pre><code>"+escH(fence[2].replace(/\n$/,""))+"</code></pre>"; i += fence[0].length; continue; }
    out += escH(src[i]); i++;
  }
  out = out
    .replace(/^###### (.*)$/gm, "<h6>$1</h6>").replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>").replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|\W)\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^(\s*)[-*+] /gm, "$1• ")
    .replace(/\n{2,}/g, "</p><p>");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#fff;color:#1b1b22;padding:22px 26px;line-height:1.65;font-size:14px;border-radius:6px;overflow:auto;height:100%">
    <style>.mdx h1{font-size:26px;border-bottom:1px solid #e5e5ea;padding-bottom:8px}
    .mdx h2{font-size:20px;border-bottom:1px solid #eee;padding-bottom:5px}.mdx h3{font-size:16px}
    .mdx code{background:#f2f2f5;padding:1px 5px;border-radius:4px;font-size:12.5px}
    .mdx pre{background:#f6f6f9;padding:10px 12px;border-radius:7px;overflow:auto}
    .mdx pre code{background:none;padding:0}.mdx blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:12px;color:#555}
    .mdx table{border-collapse:collapse}.mdx td,.mdx th{border:1px solid #ddd;padding:5px 9px}</style>
    <div class="mdx">${out}</div></div>`;
}

// ---- the simulated terminal ---------------------------------------------
const StTerm = {
  cwd: "/home/rithvik",
  history: [],
  hi: -1,
  async exec(line, ctx){
    const s = line.trim();
    if(!s) return "";
    this.history.push(s); this.hi = this.history.length;
    const [cmd, ...rest] = s.split(/\s+/);
    const arg = rest.join(" ");
    const echo = (o, cls)=> `<span class="${cls||"d"}">${esc(o)}</span>`;
    const abs = p => VFS.norm(this.cwd, p);
    switch(cmd){
      case "help":
        return echo("Available in this in-browser shell:","i")+"\n"+
          echo("  ls [path]        list a directory")+"\n"+
          echo("  cd <path>        change directory")+"\n"+
          echo("  cat <file>       print a file")+"\n"+
          echo("  tree <path>      show the tree")+"\n"+
          echo("  find <text>      search file names and contents")+"\n"+
          echo("  open <file>      open it in CYRUS Studio")+"\n"+
          echo("  run <file>       run it with the Studio runner")+"\n"+
          echo("  whoami           who you are")+"\n"+
          echo("  policy           the CYRUS permission table")+"\n"+
          echo("  audit            the last audit-log entries")+"\n"+
          echo("  clear            clear this panel")+"\n"+
          echo("Anything else is printed back with the command your terminal would need — CYRUS does not fake a shell it does not have.","d");
      case "ls": {
        const p = arg || this.cwd;
        const n = VFS.node(p);
        if(!n) return echo("ls: "+p+": no such path","e");
        if(n.type==="file") return echo(n.name,"d");
        const keys = Object.keys(n.children).sort();
        if(!keys.length) return echo("(empty)","d");
        return keys.map(k=>{
          const c = n.children[k];
          const tag = LANG.forPath(k).id;
          return c.type==="dir" ? echo("📁 "+k, "g") : echo((["javascript","typescript","python","html","css","json","markdown"].includes(tag)?"· ":"· ")+k, "d");
        }).join("   ");
      }
      case "cd": {
        const p = abs(arg || "/home/rithvik");
        const n = VFS.node(p);
        if(!n || n.type!=="dir") return echo("cd: "+p+": not a directory","e");
        this.cwd = p; return echo("→ "+p,"d");
      }
      case "pwd": return echo(this.cwd,"d");
      case "cat": {
        const p = abs(arg);
        const n = VFS.node(p);
        if(!n || n.type!=="file") return echo("cat: "+arg+": no such file","e");
        return esc(n.content||"");
      }
      case "tree": {
        const p = abs(arg || this.cwd);
        const lines = [esc(p)];
        const walk = (q, d)=>{
          const n = VFS.node(q); if(!n||n.type!=="dir"||d>4) return;
          Object.keys(n.children).sort().forEach(k=>{
            const c = n.children[k];
            lines.push(esc("  ".repeat(d+1)+(c.type==="dir"?"📁 ":"· ")+k));
            if(c.type==="dir") walk(q+"/"+k, d+1);
          });
        };
        walk(p,0);
        return lines.join("\n");
      }
      case "find": {
        if(!arg) return echo("find: what are you looking for?","e");
        const q = arg.toLowerCase(); const hits = [];
        VFS.walk(this.cwd, (p,n)=>{
          if(n.type==="file" && (n.name.toLowerCase().includes(q) || (n.content||"").toLowerCase().includes(q)))
            hits.push(p);
        });
        return hits.length ? hits.slice(0,60).map(esc).join("\n") : echo("no matches","d");
      }
      case "open": {
        const p = abs(arg);
        if(!VFS.node(p)) return echo("open: "+arg+": not found","e");
        if(ctx && ctx.open) ctx.open(p);
        return echo("opened "+p+" in CYRUS Studio","d");
      }
      case "run": {
        const p = abs(arg);
        const n = VFS.node(p);
        if(!n || n.type!=="file") return echo("run: "+arg+": not a file","e");
        if(ctx && ctx.run) await ctx.run(p);
        return echo("running "+VFS.base(p)+"…","d");
      }
      case "whoami": return echo("rithvik — the owner of this CYRUS OS. Every action you take is in the audit log.","d");
      case "policy":
        return echo("low  → run   ·   medium → confirm   ·   high → blocked","i")+"\n"+
               echo("read/write/new/rename/move/copy   → low (run)","d")+"\n"+
               echo("delete one                         → medium (confirm)","d")+"\n"+
               echo("delete many, or a critical path    → high (blocked)","d");
      case "audit":
        return Log.recent(12).map(l=>esc(
          new Date(l.ts*1000).toLocaleTimeString()+"  "+l.risk.padEnd(7)+" "+(l.ok?"ok  ":"FAIL")+"  "+l.message)).join("\n") || echo("(empty)","d");
      case "clear": return "\u0000CLEAR";
      default:
        return echo("$ "+cmd+" "+arg+"  — no such built-in.","i")+"\n"+
               echo("In your real terminal that would run as:", "d")+"\n"+
               "  "+esc(s)+"\n"+
               echo("CYRUS runs commands it understands and names the ones it does not. Try `help`.","d");
    }
  }
};