// ---- the language table. One row per language; families supply the syntax,
// keywords/builtins/types supply meaning. Adding a language = adding a row.
const LANGS = [
  // id            name            ext                              fam    sym   kw     bi     ty    run
  ["javascript",  "JavaScript",   "js mjs cjs jsx",                 "c",   "js",  "js",  "js",  "js",  "js"],
  ["typescript",  "TypeScript",   "ts tsx mts cts",                 "c",   "ts",  "ts",  "js",  "ts",  "ts"],
  ["python",      "Python",       "py pyw pyi ipynb",               "h",   "py",  "py",  "py",  "py",  "py"],
  ["java",        "Java",         "java",                           "c",   "jvm", "java","java","java","java"],
  ["kotlin",      "Kotlin",       "kt kts",                         "c",   "kt",  "kt",  "",    "kt",  "kotlin"],
  ["scala",       "Scala",        "scala sc",                       "c",   "scala","scala","",  "",    "scala"],
  ["groovy",      "Groovy",       "groovy gvy",                     "c",   "groovy","php","",  "",    "groovy"],
  ["c",           "C",            "c h",                            "c",   "c",   "c",   "c",   "c",   "gcc"],
  ["cpp",         "C++",          "cpp cxx cc hpp hxx ipp",         "c",   "c",   "cpp", "cpp", "cpp", "g++"],
  ["csharp",      "C#",           "cs csx",                         "c",   "cs",   "cs",  "",    "cs",  "dotnet"],
  ["fsharp",      "F#",           "fs fsi fsx",                     "c",   "txt",  "txt",  "",    "",    "dotnet"],
  ["vb",          "Visual Basic", "vb vbs",                         "vb",  "txt",  "vb",  "",    "",    ""],
  ["objectivec",  "Objective-C",  "m mm",                           "c",   "objc", "objc","",    "",    ""],
  ["dart",        "Dart",         "dart",                           "c",   "dart", "dart","",    "",    "dart"],
  ["swift",       "Swift",        "swift",                          "c",   "swift","swift","",   "swift","swift"],
  ["go",          "Go",           "go",                             "c",   "go",   "go",  "go",  "go",  "go"],
  ["rust",        "Rust",         "rs",                             "c",   "rust", "rust","rust","rust","cargo"],
  ["zig",         "Zig",          "zig",                            "c",   "zig",  "zig", "",    "",    "zig"],
  ["julia",       "Julia",        "jl",                             "h",   "jul",  "jl",  "jl",  "",    "julia"],
  ["r",           "R",            "r rmd R",                        "h",   "r",    "r",   "r",   "",    "Rscript"],
  ["matlab",      "MATLAB",       "m mat",                          "h",   "mat",  "txt", "",    "",    "matlab"],
  ["octave",      "Octave",       "oct",                            "h",   "mat",  "txt", "",    "",    "octave"],
  ["ruby",        "Ruby",         "rb rake gemfile gemspec",        "h",   "rb",   "rb",  "rb",  "rb",  "ruby"],
  ["perl",        "Perl",         "pl pm t",                        "h",   "txt",  "txt", "",    "",    "perl"],
  ["raku",        "Raku",         "raku rakumod p6",                "h",   "txt",  "raku","",    "",    "raku"],
  ["php",         "PHP",          "php php3 php4 php5 phtml",       "c",   "php",  "php", "php", "",    "php"],
  ["lua",         "Lua",          "lua",                            "lua", "lua",  "lua", "lua", "",    "lua"],
  ["tcl",         "Tcl",          "tcl tk",                         "h",   "txt",  "txt", "",    "",    "tclsh"],
  ["bash",        "Bash",         "sh bash zsh ksh",                "h",   "sh",   "sh",  "sh",  "",    "bash"],
  ["fish",        "Fish",         "fish",                           "h",   "sh",   "sh",  "sh",  "",    "fish"],
  ["powershell",  "PowerShell",   "ps1 psm1 psd1",                  "h",   "txt",  "powershell","", "", "pwsh"],
  ["batch",       "Batch",        "bat cmd",                        "vb",  "txt",  "batch","",  "",    ""],
  ["sql",         "SQL",          "sql ddl dml",                    "sql", "txt",  "sql", "sql", "",    ""],
  ["html",        "HTML",         "html htm xhtml",                 "m",   "txt",  "",    "",    "",    "html"],
  ["xml",         "XML",          "xml svg xaml plist rss atom",    "m",   "txt",  "",    "",    "",    "xml"],
  ["vue",         "Vue",          "vue",                            "m",   "txt",  "js",  "js",  "js",  "js"],
  ["svelte",      "Svelte",       "svelte",                         "m",   "txt",  "js",  "js",  "js",  "js"],
  ["css",         "CSS",          "css scss sass less styl",        "c",   "txt",  "css", "css", "",    "css"],
  ["json",        "JSON",         "json jsonc json5 geojson",       "c",   "json", "",    "",    "",    "json"],
  ["json5",       "JSON5",        "",                               "c",   "json", "",    "",    "",    "json"],
  ["yaml",        "YAML",         "yml yaml",                       "h",   "yaml", "yaml","yaml","",    ""],
  ["toml",       "TOML",         "toml",                           "h",   "txt",  "toml","",    "",    ""],
  ["ini",         "INI",          "ini cfg conf properties editorconfig", "h", "txt", "txt", "", "", ""],
  ["env",         "Dotenv",       "env",                            "h",   "txt",  "",    "",    "",    ""],
  ["markdown",    "Markdown",     "md markdown mdx rst adoc",        "md",  "md",   "",    "",    "",    "md"],
  ["tex",         "LaTeX",        "tex latex sty cls bib",          "pct", "txt",  "tex", "",    "",    "latex"],
  ["rst",         "reStructured", "rst",                            "pct", "txt",  "",    "",    "",    ""],
  ["asm",         "Assembly",     "asm s S nasm",                   "pct", "asm",  "asm", "asm", "",    ""],
  ["wat",         "WebAssembly",  "wat wasm",                       "lisp","txt",  "",    "",    "",    ""],
  ["lisp",        "Lisp",         "lisp lisp scm el cl ss rkt",     "lisp","clj",  "lisp","",    "",    ""],
  ["clojure",     "Clojure",      "clj cljs cljc edn",              "lisp","clj",  "clj", "",    "",    ""],
  ["scheme",      "Scheme",       "scm ss",                         "lisp","txt",  "lisp","",    "",    ""],
  ["racket",      "Racket",       "rkt",                            "lisp","txt",  "lisp","",    "",    ""],
  ["haskell",     "Haskell",      "hs lhs",                         "hs",  "hs",   "hs",  "hs",  "",    ""],
  ["purescript",  "PureScript",   "purs",                           "hs",  "hs",   "hs",  "hs",  "",    ""],
  ["elm",         "Elm",          "elm",                            "hs",  "elm",  "",    "",    "",    ""],
  ["ocaml",       "OCaml",        "ml mli",                         "hs",  "ocaml","txt", "",    "",    ""],
  ["fsharp2",     "F#",           "",                               "hs",  "txt",  "txt", "",    "",    ""],
  ["reason",      "ReasonML",     "re rei",                         "hs",  "txt",  "txt", "",    "",    ""],
  ["erlang",      "Erlang",       "erl hrl escript",                "pct", "erl",  "erl", "",    "",    "escript"],
  ["elixir",      "Elixir",       "ex exs eex leex heex",           "h",   "ex",   "ex",  "ex",  "",    "mix"],
  ["nim",         "Nim",          "nim nims",                       "h",   "nim",  "nim", "",    "",    "nim"],
  ["crystal",     "Crystal",      "cr",                             "h",   "rb",   "rb",  "rb",  "",    "crystal"],
  ["solidity",    "Solidity",     "sol",                            "c",   "sol",  "sol", "",    "",    ""],
  ["move",        "Move",         "move",                           "c",   "txt",  "txt", "",    "",    ""],
  ["cairo",       "Cairo",        "cairo",                          "c",   "txt",  "txt", "",    "",    ""],
  ["zig2",        "Zig",          "",                               "c",   "zig",  "zig", "",    "",    ""],
  ["vbnet",       "VB.NET",       "",                               "vb",  "txt",  "txt", "",    "",    ""],
  ["pascal",      "Pascal",       "pas dpr lpr pp",                 "pct", "pas",  "pas", "pas", "",    ""],
  ["fortran",     "Fortran",      "f90 f95 f03 f08 for",            "scm", "for",  "for", "for", "",    ""],
  ["cobol",       "COBOL",        "cob cbl cpy",                    "scm", "cob",  "cob", "cob", "",    ""],
  ["ada",         "Ada",          "adb ads",                        "h",   "adb",  "adb", "adb", "",    ""],
  ["vhdl",        "VHDL",         "vhd vhdl",                       "lisp","vhdl", "vhdl","vhdl","",    ""],
  ["verilog",     "Verilog",      "v sv svh",                       "c",   "verilog","verilog","","", ""],
  ["systemverilog","SystemVerilog","svh",                           "c",   "verilog","verilog","","", ""],
  ["tla",         "TLA+",         "tla cfg",                        "pct", "txt",  "",    "",    "",    ""],
  ["abap",        "ABAP",         "abap",                           "scm", "abap", "abap","",    "",    ""],
  ["apex",        "Apex",         "cls trigger",                    "c",   "txt",  "jvm", "jvm", "",    ""],
  ["make",        "Makefile",     "mk mak makefile",                "h",   "txt",  "make","",    "",    "make"],
  ["cmake",       "CMake",        "cmake",                          "h",   "txt",  "cmake","",   "",    "cmake"],
  ["dockerfile",  "Dockerfile",   "dockerfile containerfile",       "h",   "txt",  "sh",  "sh",  "",    "docker"],
  ["nginx",       "Nginx",        "nginx conf",                     "h",   "txt",  "",    "",    "",    ""],
  ["apache",      "Apache",       "htaccess htpasswd",              "h",   "txt",  "",    "",    "",    ""],
  ["graphql",     "GraphQL",      "graphql gql",                    "h",   "txt",  "sql", "",    "",    ""],
  ["proto",       "Protocol Buf", "proto",                          "c",   "txt",  "java","java","java",""],
  ["thrift",      "Thrift",       "thrift",                         "c",   "txt",  "txt", "",    "",    ""],
  ["capnp",       "Cap'n Proto",  "capnp",                          "c",   "txt",  "",    "",    "",    ""],
  ["regex",       "RegExp",       "regex regexp",                   "pct", "txt",  "",    "",    "",    ""],
  ["diff",        "Diff",         "diff patch",                     "scm", "txt",  "",    "",    "",    ""],
  ["log",         "Log",          "log",                            "h",   "txt",  "",    "",    "",    ""],
  ["csv",         "CSV / Data",   "csv tsv",                        "h",   "txt",  "",    "",    "",    ""],
  ["key",         "Key file",     "key crt pem pub",                "h",   "txt",  "",    "",    "",    ""],
  ["tex2",        "TeX",          "",                               "pct", "txt",  "tex", "",    "",    ""],
  ["asm2",        "ASM",          "",                               "pct", "asm",  "asm", "asm", "",    ""],
  ["swiftui",     "SwiftUI",      "",                               "c",   "swift","swift","",   "swift",""],
  ["plain",       "Plain Text",   "txt text log me",                "plain","txt","",  "",    "",    ""],
];

// ---------------------------------------------------------------------------
//  LANG — the engine every other phase reads from
// ---------------------------------------------------------------------------
const LANG = (()=>{
  const byId = new Map(), byExt = new Map();

  function build(row){
    const [id,name,exts,fam,sym,kw,bi,ty,run] = row;
    const f = FAM[fam] || FAM.plain;
    const spec = {
      id, name,
      exts: String(exts||"").split(/\s+/).filter(Boolean),
      fam,
      line:f.line||[], block:f.block||[], str:f.str||[], esc:!!f.esc, raw:f.raw||null,
      pairs: f.pairs||{}, indent: f.ind||2,
      xml: !!f.xml, markdown: !!f.markdown, regexp: !!f.regexp,
      openers: OPENERS.filter(o=> o==='"'||o==="'" ? f.str.length : !!f.pairs[o]),
      kw:   K(KW[kw]||""),
      bi:   K(BUILTINS[bi]||""),
      ty:   K(TYPES[ty]||""),
      con:  K(CONSTS[kw]||""),
      sym:  (SYM[sym]||[]).reduce((acc,r)=>{
        try{ const [kind,src,g]=r; acc.push({kind, re:new RegExp(src,"gm"), g:g||1}); }
        catch(e){ console.warn("[cyrus-studio] bad symbol rule for "+id+": "+e.message); }
        return acc;
      }, []),
      run,
    };
    byId.set(id,spec);
    spec.exts.forEach(e=>{ if(!byExt.has(e)) byExt.set(e,spec); });
    return spec;
  }
  LANGS.forEach(build);
  // names/aliases that map onto existing specs
  [["node","javascript"],["ts","typescript"],["py","python"],["jsx","javascript"],
   ["sh","bash"],["shell","bash"],["zsh","bash"],["yml","yaml"],["rs","rust"],
   ["golang","go"],["rb","ruby"],["kt","kotlin"],["cs","csharp"],["c#","csharp"],
   ["c++","cpp"],["h","c"],["hpp","cpp"],["pl","perl"],["lua51","lua"],
   ["objective-c","objectivec"],["asm","asm"],["batchfile","batch"],
   ["tf","hcl"],["hcl","hcl"],["proto3","proto"],["docker","dockerfile"]
  ].forEach(([alias,id])=>{ if(byId.has(id)){ const s=byId.get(id); if(!s.exts.includes(alias)){ s.exts.push(alias); byExt.set(alias,s); } } });
  // Terraform — worth its own row so hcl gets real syntax
  build(["hcl","Terraform / HCL","tf hcl tfvars nomad vault","h","txt","sh","sh","",  "terraform"]);
  build(["jsonc","JSON with comments","jsonc jsonl ndjson geojson","c","json","","","","json"]);

  function byName(n){ return byId.get(String(n||"").toLowerCase()) || null; }

  function forPath(path, content){
    const base = String(path||"").split("/").pop()||"";
    const lname = base.toLowerCase();
    // exact filename wins (Dockerfile, Makefile, CMakeLists.txt)
    const exact = {"dockerfile":1,"makefile":1,"cmakelists.txt":1,"rakefile":1,"gemfile":1,"procfile":1,"vagrantfile":1,
      "requirements.txt":1,"cargo.toml":1,"go.mod":1,"package.json":1,"pyproject.toml":1,"build.gradle":1,
      ".gitignore":1,".env":1,"license":1,"readme":1,"todo":1,"hosts":1,"passwd":1,"fstab":1};
    if(exact[lname]){
      if(/^dockerfile/.test(lname)) return byId.get("dockerfile");
      if(/^makefile/.test(lname)) return byId.get("make");
      if(lname==="cmakelists.txt") return byId.get("cmake");
      if(lname==="rakefile"||lname==="gemfile") return byId.get("ruby");
      if(/^requirements|^pyproject/.test(lname)) return byId.get("toml");
      if(/^cargo\.toml/.test(lname)) return byId.get("toml");
      if(/^go\.mod/.test(lname)) return byId.get("toml");
      if(/^package\.json$/.test(lname)) return byId.get("json");
      if(/^build\.gradle/.test(lname)) return byId.get("jvm");
      if(lname.startsWith(".")) return derive(lname);
    }
    const dot = lname.lastIndexOf(".");
    if(dot>0){
      const ext = lname.slice(dot+1);
      const hit = byExt.get(ext);
      if(hit) return hit;
      return derive(ext, content);
    }
    // shebang detection
    if(content){
      const m = String(content).slice(0,120).match(/^#!\s*(\S+)(?:\s+(\S+))?/);
      if(m){
        const sh=[/bash/,/sh$/,/zsh/,/ksh/,/python/,/node/,/ruby/,/perl/,/php/,/lua/,/rscript/,/julia/,/R/,/awk/,/sed/];
        for(const r of sh) if(r.test(m[1])){ const n=r.source.replace(/[\\^$]/g,""); }
        const map={bash:"bash",sh:"bash",zsh:"bash",ksh:"bash",python:"python",python3:"python",node:"javascript",
                   ruby:"ruby",perl:"perl",php:"php",lua:"lua",rscript:"r",julia:"julia",R:"r",awk:"sh",env:"sh"};
        const key=map[m[1].split("/").pop()]|| (m[2]&&map[m[2].split("/").pop()]);
        if(key&&byId.has(key)) return byId.get(key);
      }
    }
    return byId.get("plain");
  }

  // Unknown extension → derive a workable spec from the extension itself so a
  // brand-new language still highlights and still gets diagnostics.
  const derived = new Map();
  function derive(ext, content){
    ext = String(ext||"").toLowerCase();
    if(derived.has(ext)) return derived.get(ext);
    let fam = "plain";
    if(content){
      const s = String(content).slice(0,4000);
      if(/\n\s*(def |class )|\n\s*import \w|\nfrom \w+ import/.test(s)) fam="h";
      else if(/\/\*[\s\S]*?\*\/|\n\s*(function|class|const|let) /.test(s)) fam="c";
      else if(/\n#|\n--|\bSECTION\b/.test(s)) fam="h";
    }
    const spec = {
      id:"~"+ext, name: ext.toUpperCase()+" (derived)", exts:[ext], fam,
      line:FAM[fam].line||[], block:FAM[fam].block||[], str:FAM[fam].str||[], esc:!!FAM[fam].esc, raw:null,
      pairs: FAM[fam].pairs||{}, indent:FAM[fam].ind||2, xml:false, markdown:false, regexp:false,
      openers: OPENERS.filter(o=> o==='"'||o==="'" ? FAM[fam].str.length : !!FAM[fam].pairs[o]),
      kw:new Set(), bi:new Set(), ty:new Set(), con:new Set(), sym:[], run:"", derived:true,
    };
    derived.set(ext,spec);
    return spec;
  }

  // ---- tokenizer ---------------------------------------------------------
  // Emits [{s,e,t}]. Single pass. Used by the highlighter, the diagnostics
  // engine and the AI context builder.
  function tokenize(src, spec){
    const out = []; const n = src.length; let i = 0;
    const kw = spec.kw, bi = spec.bi, ty = spec.ty, con = spec.con;
    const push = (s,e,t)=>{ if(e>s) out.push({s:s,e:e,t:t}); };
    let prev = "";                 // last significant token text
    let prevType = "";
    const isWordStart = c => /[A-Za-z_$]/.test(c);
    const isWord = c => /[A-Za-z0-9_$]/.test(c);
    const OPS = ["===","!==","...","**=","<<=",">>=","&&=","||=","??=",">>>","=>","->","::","++","--","+=","-=","*=","/=","%=","&&","||","??","?.","==","!=","<=",">=","<<",">>","**","+","-","*","/","%","=","<",">","!","&","|","^","~","?","@","#","$"];

    while(i<n){
      const c = src[i];

      // whitespace — skip, renderer fills the gaps as plain text
      if(c===" "||c==="\t"||c==="\n"||c==="\r"){ i++; continue; }

      // ---- markup
      if(spec.xml && c==="<"){
        const m = /^<\?([\s\S]*?)\?>/.exec(src.slice(i));
        if(m){ push(i,i+m[0].length,"dec"); i+=m[0].length; continue; }
        const cm = /^<!--[\s\S]*?(?:-->|$)/.exec(src.slice(i));
        if(cm){ push(i,i+cm[0].length,"cmt"); i+=cm[0].length; prev=""; continue; }
        const cl = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(src.slice(i));
        if(cl){ push(i,i+cl[0].length,"str"); i+=cl[0].length; continue; }
        const dt = /^<![A-Za-z]+/.exec(src.slice(i));
        if(dt){ const gt=src.indexOf(">",i); push(i, gt<0?n:gt+1, "tag"); i=(gt<0?n:gt+1); continue; }
        const tg = /^<\/?[A-Za-z][\w:.-]*/.exec(src.slice(i));
        if(tg){
          push(i, i+tg[0].length, "tag"); i+=tg[0].length;
          // attributes until '>' or '/>'
          while(i<n && src[i]!==">"){
            if(src[i]===" "||src[i]==="\t"||src[i]==="\n"){ i++; continue; }
            if(spec.esc && src[i]==="\\"){ push(i,i+2,"esc"); i+=2; continue; }
            if(src[i]==='"'||src[i]==="'"){ const s0=i, q=src[i]; i++;
              while(i<n && src[i]!==q){ if(src[i]==="\n")break; i++; }
              if(src[i]===q) i++;
              push(s0,i,"str"); continue; }
            if(src[i]==="/"||src[i]==="="){ push(i,i+1,"op"); i++; continue; }
            const at = /^[A-Za-z_:@#][\w:.@-]*/.exec(src.slice(i));
            if(at){ push(i,i+at[0].length,"attr"); i+=at[0].length; continue; }
            i++;
          }
          if(i<n){ push(i,i+1,"tag"); i++; }
          prev=">"; prevType="tag";
          continue;
        }
      }

      // ---- markdown
      if(spec.markdown){
        const rest = src.slice(i);
        const h = /^#{1,6}[^\n]*/.exec(rest);
        if(h){ push(i,i+h[0].length,"kw"); i+=h[0].length; continue; }
        const b = /^(?:```|~~~)[^\n]*\n?/.exec(rest);
        if(b){ push(i,i+b[0].length,"str"); i+=b[0].length; continue; }
        const bl = /^(?:[-*+]|\d+\.)\s/.exec(rest);
        if(bl){ push(i,i+bl[0].length,"kw"); i+=bl[0].length; continue; }
        const lk = /^\[[^\]\n]*\]\([^)\n]*\)/.exec(rest);
        if(lk){ push(i,i+lk[0].length,"fn"); i+=lk[0].length; continue; }
        const bt = /^`[^`\n]*`/.exec(rest);
        if(bt){ push(i,i+bt[0].length,"str"); i+=bt[0].length; continue; }
      }

      // ---- block comment
      let matched = false;
      for(const b of (spec.block||[])){
        if(src.startsWith(b[0],i)){
          const e = src.indexOf(b[1], i+b[0].length);
          const end = e<0 ? n : e+b[1].length;
          push(i,end,"cmt"); i=end; matched=true; break;
        }
      }
      if(matched){ prev=""; continue; }

      // ---- line comment
      for(const l of (spec.line||[])){
        if(src.startsWith(l,i)){
          let e=i; while(e<n && src[e]!=="\n") e++;
          push(i,e,"cmt"); i=e; prev=""; matched=true; break;
        }
      }
      if(matched) continue;

      // ---- string
      for(const s of (spec.str||[])){
        if(src.startsWith(s[0],i)){
          const raw = spec.raw && spec.raw.indexOf(s[0])>=0;
          let j = i+s[0].length;
          while(j<n){
            if(!raw && spec.esc && src[j]==="\\"){ j+=2; continue; }
            if(src.startsWith(s[1],j)){ j+=s[1].length; break; }
            if(s[1].length===1 && src[j]==="\n") break;     // unterminated single-line
            j++;
          }
          push(i,j,"str"); i=j; prev="str"; prevType="str"; matched=true; break;
        }
      }
      if(matched) continue;

      // ---- number
      if(/[0-9]/.test(c) || (c==="." && /[0-9]/.test(src[i+1]||""))){
        const m = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)(?:[eE][+-]?\d+)?[a-zA-Z_]*n?|[0-9][a-zA-Z_]*/.exec(src.slice(i));
        if(m){ push(i,i+m[0].length,"num"); i+=m[0].length; prev=m[0]; prevType="num"; continue; }
      }

      // ---- regexp literal (c-family heuristic)
      if(spec.regexp && c==="/" && (prevType==="op"||prevType==="kw"||prevType==="pun"||prev==="("||prev===","||prev===""||prev==="["||prev==="return"||prev===";")){
        let j=i+1, ok=false, inClass=false;
        while(j<n && src[j]!=="\n"){
          if(src[j]==="\\"){ j+=2; continue; }
          if(src[j]==="[") inClass=true;
          else if(src[j]==="]") inClass=false;
          else if(src[j]==="/" && !inClass){ ok=true; j++; break; }
          j++;
        }
        if(ok){ let k=j; while(k<n && /[a-z]/.test(src[k])) k++;
          push(i,k,"regexp"); i=k; prev=""; prevType="regexp"; continue; }
      }

      // ---- word
      if(isWordStart(c)){
        let j=i; while(j<n && isWord(src[j])) j++;
        const w = src.slice(i,j);
        let t = "";
        if(kw.has(w)) t="kw";
        else if(con.has(w)) t="num";
        else if(bi.has(w)) t="bi";
        else if(ty.has(w)) t="ty";
        else {
          let k=j; while(k<n && (src[k]===" "||src[k]==="\t")) k++;
          if(src[k]==="(") t="fn";
          else if(spec.pairs["{"] && src[j]==="{" && /^\s*\{/.test(src.slice(j))) t="cls";
          else if(/^[A-Z][A-Z0-9_]{1,}$/.test(w)) t="var";
          else if(/^[A-Z]/.test(w)) t="cls";
          else if(/^[@$][A-Za-z_]/.test(w)) t="ty";
        }
        push(i,j,t||""); i=j; prev=w; prevType=t||"word";
        continue;
      }

      // ---- operator / punctuation
      const op = OPS.find(o=>src.startsWith(o,i));
      if(op){ push(i,i+op.length,"op"); i+=op.length; prev=op; prevType="op"; continue; }
      push(i,i+1,"pun"); i++; prev=c; prevType="pun";
    }
    return out;
  }

  return { byId, byExt, LANGS, forPath, byName, derive, tokenize,
           count: byId.size, extCount: byExt.size };
})();