// ---- markdown → HTML for chat (safe: escapes first, never injects raw md)
function mdToHtml(src){
  const escH = s => String(s).replace(/[&<>]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const raw = String(src||"");
  let ci = 0;
  const renderText = t => escH(t)
    .replace(/`([^`\n]+)`/g, "<code class='md-em'>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b class='md-b'>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i class='md-em'>$2</i>")
    .replace(/^#{6} (.*)$/gm, "<h6>$1</h6>").replace(/^#{5} (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#{4} (.*)$/gm, "<h4>$1</h4>").replace(/^#{3} (.*)$/gm, "<h3>$1</h3>")
    .replace(/^#{2} (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^&gt; (.*)$/gm, "<blockquote class='md-c'>$1</blockquote>")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "&bull; ")
    .replace(/^[ \t]*(\d+)\.[ \t]+/gm, "$1. ")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
  let out = "", last = 0, m;
  const re = /```([\w+#.-]*)\n([\s\S]*?)(?:```|$)/g;
  while((m = re.exec(raw))){
    if(m.index > last) out += renderText(raw.slice(last, m.index));
    const i = ci++;
    const code = m[2].replace(/\n$/,"");
    out += '<div class="codeblock" data-lang="'+escH(m[1])+'"><div class="cb-h"><span>'+escH(m[1]||"code")+"</span>"+
           '<button data-act="apply" data-i="'+i+'">Apply</button>'+
           '<button data-act="copy" data-i="'+i+'">Copy</button>'+
           '<button data-act="ask" data-i="'+i+'">Ask</button></div>'+
           "<code>"+escH(code)+"</code></div>";
    last = m.index + m[0].length;
  }
  if(last < raw.length) out += renderText(raw.slice(last));
  return out;
}
function mdCodeBlocks(src){
  const out = []; let m;
  const re = /```([\w+#.-]*)\n([\s\S]*?)(?:```|$)/g;
  while((m = re.exec(String(src||"")))) out.push({ lang:m[1], code:m[2].replace(/\n$/,"") });
  return out;
}