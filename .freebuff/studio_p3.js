// ---------------------------------------------------------------------------
// PHASE 3 — cyrus.project.json
// The "perfectly defined workspace": Studio reads the project instead of
// guessing. One file declares roots, entry points, run configs, env, the
// folders extensions may touch, and the instructions the AI is held to.
// ---------------------------------------------------------------------------
const MANIFEST = "cyrus.project.json";

const StProject = {
  MANIFEST,
  markers: ["cyrus.project.json","package.json","pyproject.toml","Cargo.toml","go.mod",
            "pom.xml","build.gradle","requirements.txt","setup.py","Makefile",".git","deno.json","composer.json"],

  // walk up from a folder looking for a project marker
  detect(from){
    let p = VFS.norm("/", from||"/");
    let guard = 0;
    while(guard++ < 40){
      for(const m of this.markers){
        if(VFS.node(p+"/"+m)) return { root:p, marker:m, manifest: m===MANIFEST ? p+"/"+m : null };
      }
      if(p==="/" || p==="") break;
      p = VFS.parent(p);
    }
    return null;
  },
  path(root){ return VFS.norm(root||"/", MANIFEST); },

  read(root){
    const p = this.path(root);
    const n = VFS.node(p);
    if(!n || n.type!=="file") return null;
    try{
      const j = JSON.parse(n.content);
      return j && typeof j==="object" ? j : null;
    }catch(e){ return { __error: e.message }; }
  },
  write(root, obj){
    const p = this.path(root);
    const text = JSON.stringify(obj, null, 2);
    if(!VFS.writeFile(p, text)) return { ok:false, err:"Cannot write "+p };
    Log.record("studio: save "+MANIFEST, "studio_project", {root}, "low", false, true, "Workspace manifest updated");
    return { ok:true, path:p };
  },

  scaffold(root, name, kind){
    const obj = {
      name: name || VFS.base(root),
      version: "0.1.0",
      description: "",
      roots: ["."],
      exclude: ["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", "target", ".next"],
      entry: "",
      runs: [],
      env: {},
      ai: { instructions: "" },
      extensions: []
    };
    const presets = {
      node: { entry:"src/index.js", runs:[{name:"start", command:"node src/index.js", watch:["src"]},
                {name:"test", command:"npm test"}],
              extensions:["javascript","git"] },
      python:{ entry:"main.py", runs:[{name:"start", command:"python main.py", watch:["."]},
                {name:"test", command:"python -m pytest -q"}], extensions:["python","git"] },
      rust:  { entry:"src/main.rs", runs:[{name:"build", command:"cargo build"},
                {name:"run", command:"cargo run"}, {name:"test", command:"cargo test"}], extensions:["rust","git"] },
      go:    { entry:"main.go", runs:[{name:"build", command:"go build ./..."},
                {name:"run", command:"go run ."}, {name:"test", command:"go test ./..."}], extensions:["go","git"] },
      static:{ entry:"index.html", runs:[{name:"preview", command:"open index.html"}], extensions:["html","css"] },
      blank: { }
    };
    Object.assign(obj, presets[kind||"blank"]||{});
    if(kind==="node") obj.dependencies = { "dependencies": {} };
    if(kind==="python") obj.dependencies = { "requires": ["python>=3.9"] };
    if(kind==="rust") obj.dependencies = { "crate": "", "edition": "2021" };
    if(kind==="go") obj.dependencies = { "module": (name||"app").replace(/[^a-z0-9]/gi,"").toLowerCase() };
    const r = this.write(root, obj);
    if(r.ok){
      if(kind==="node" && !VFS.node(root+"/src")){ VFS.mkdirp(root+"/src"); VFS.writeFile(root+"/src/index.js", "console.log('hello from "+obj.name+"');\n"); }
      if(kind==="python" && !VFS.node(root+"/main.py")) VFS.writeFile(root+"/main.py", 'def main():\n    print("hello from '+obj.name+'")\n\n\nif __name__ == "__main__":\n    main()\n');
      if(kind==="go" && !VFS.node(root+"/main.go")) VFS.writeFile(root+"/main.go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello from '+obj.name+'")\n}\n');
      if(kind==="rust"){ if(!VFS.node(root+"/src")) VFS.mkdirp(root+"/src");
        if(!VFS.node(root+"/Cargo.toml")) VFS.writeFile(root+"/Cargo.toml", '[package]\nname = "'+obj.name+'"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n');
        if(!VFS.node(root+"/src/main.rs")) VFS.writeFile(root+"/src/main.rs", 'fn main() {\n    println!("hello from '+obj.name+'");\n}\n'); }
      if(kind==="static" && !VFS.node(root+"/index.html")) VFS.writeFile(root+"/index.html", '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>'+obj.name+'</title></head>\n<body><h1>'+obj.name+'</h1></body>\n</html>\n');
    }
    return r;
  },

  // ---- what the manifest means to the rest of Studio --------------------
  resolved(root){
    const m = this.read(root) || {};
    const roots = Array.isArray(m.roots) && m.roots.length ? m.roots : ["."];
    const exclude = Array.isArray(m.exclude) ? m.exclude : ["node_modules",".git","__pycache__"];
    return {
      raw:m, roots, exclude,
      name: m.name || VFS.base(root),
      entry: m.entry || "",
      runs: Array.isArray(m.runs) ? m.runs : [],
      env: m.env || {},
      ai: m.ai || {},
      extensions: Array.isArray(m.extensions) ? m.extensions : [],
      deps: m.dependencies || {},
      error: m.__error || null
    };
  },
  inProject(root, path){
    const r = this.resolved(root);
    const rel = path.replace(root, "").replace(/^\//,"");
    const first = rel.split("/")[0];
    if(r.exclude.includes(first)) return false;
    if(r.roots.includes(".") || r.roots.includes("*")) return true;
    return r.roots.some(x=> rel===x || rel.startsWith(x+"/"));
  },
  // every source file the project declares
  files(root){
    const out = [];
    const walk = (p)=>{
      const n = VFS.node(p); if(!n) return;
      if(n.type==="file"){
        const ext = LANG.forPath(p);
        if(!["plain","json","csv","log","md"].includes(ext.id) || /\.(json|md)$/i.test(p)) out.push(p);
        return;
      }
      for(const name of Object.keys(n.children)) walk(p+"/"+name);
    };
    walk(root);
    return out.filter(p=>this.inProject(root,p)).sort();
  },
  // how the project actually writes code — learned, not declared
  learn(root){
    const files = this.files(root).slice(0,60);
    const stats = { indent:{2:0,4:0,tab:0}, quotes:{d:0,s:0}, semi:{on:0,off:0}, langs:{} };
    for(const p of files){
      const n = VFS.node(p); if(!n||n.type!=="file") continue;
      const spec = LANG.forPath(p, n.content);
      stats.langs[spec.name] = (stats.langs[spec.name]||0)+1;
      if(spec.markdown) continue;
      const lines = (n.content||"").split("\n").slice(0,400);
      for(const l of lines){
        const m = /^[ \t]+/.exec(l);
        if(!m) continue;
        if(m[0].includes("\t")) stats.indent.tab++;
        else if(m[0].length % 4 === 0) stats.indent[4]++;
        else stats.indent[2]++;
        if(/;\s*$/.test(l.trim())) stats.semi.on++;
        if(/;/.test(l) && !/for\s*\(/.test(l)) stats.semi.off++;
      }
      const dq = (n.content.match(/"/g)||[]).length, sq = (n.content.match(/'/g)||[]).length;
      if(spec.id==="python"){} else if(dq>=sq) stats.quotes.d+=dq; else stats.quotes.s+=sq;
    }
    const top = (o)=> Object.entries(o).sort((a,b)=>b[1]-a[1])[0]||["",0];
    const ind = top(stats.indent), q = top(stats.quotes);
    const langs = Object.entries(stats.langs).sort((a,b)=>b[1]-a[1]).slice(0,4).map(x=>x[0]+" "+Math.round(x[1]/files.length*100)+"%");
    return {
      indent: ind[0]==="tab" ? "tabs" : (ind[0]==="4" ? "4 spaces" : "2 spaces"),
      quotes: q[0]==="s" ? "single" : "double",
      semicolons: stats.semi.on >= stats.semi.off ? "yes" : "no",
      langs, files: files.length,
      summary: `${files.length} source files · ${ind[0]==="tab"?"tabs":ind[0]+"-space"} indent · ${q[0]==="s"?"single":"double"} quotes`
    };
  },
  // the prompt fragment every AI call in this workspace receives
  aiContext(root){
    const r = this.resolved(root);
    const s = this.learn(root);
    const lines = [];
    lines.push(`Workspace: ${r.name} (root ${root})`);
    if(r.entry) lines.push(`Entry point: ${r.entry}`);
    if(r.roots.length && r.roots[0]!==".") lines.push(`Source roots: ${r.roots.join(", ")}`);
    if(r.deps && Object.keys(r.deps).length) lines.push(`Dependencies: ${JSON.stringify(r.deps)}`);
    lines.push(`Observed style: ${s.summary}`);
    if(r.runs.length) lines.push(`Run configs: ${r.runs.map(x=>x.name+" = "+x.command).join(" | ")}`);
    if(r.ai.instructions) lines.push("Project instructions: " + r.ai.instructions);
    return lines.join("\n");
  },
  runFor(root, path){
    const r = this.resolved(root);
    if(!r.runs.length) return null;
    if(r.entry && path && (path===r.entry || path.startsWith(r.entry.split("/").slice(0,-1).join("/"))))
      return r.runs[0];
    const ext = LANG.forPath(path||"").id;
    const byLang = { javascript:["node","node"], typescript:["ts-node","tsc"], python:["python","python"], go:["go run","go"], rust:["cargo run","cargo"] };
    const pref = byLang[ext];
    if(!pref) return r.runs[0];
    return r.runs.find(x=> (x.command||"").startsWith(pref[0])) || r.runs[0];
  },
  suggestExports(root){
    // conventional entry files a project probably has
    const want = ["main.py","app.py","index.js","index.ts","src/index.js","src/main.rs","main.go","cmd/*/main.go",
                  "index.html","README.md","requirements.txt","package.json","Cargo.toml","go.mod"];
    const found = want.filter(w=>!w.includes("*") && VFS.node(root+"/"+w));
    return found;
  }
};