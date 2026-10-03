// ---------------------------------------------------------------------------
// PHASE 5 — CYRUS COPILOT
// Three surfaces, one brain: chat with full workspace context, inline
// autocomplete as ghost text, and agentic edits that always arrive as a diff
// you have to accept. The AI never writes a file without showing you first.
// ---------------------------------------------------------------------------
const Diff = (()=>{
  // LCS line diff. Bounded so a huge file degrades to a whole-file replace.
  function lines(a, b, maxRows){
    const A = a.split("\n"), B = b.split("\n");
    if(A.length* B.length > (maxRows||4000000) || A.length>2500 || B.length>2500){
      return [ ...A.map(t=>({t:"del", text:t})), ...B.map(t=>({t:"add", text:t})) ];
    }
    const n = A.length, m = B.length;
    const dp = new Uint32Array((n+1)*(m+1));
    for(let i=n-1;i>=0;i--)
      for(let j=m-1;j>=0;j--)
        dp[i*(m+1)+j] = A[i]===B[j] ? dp[(i+1)*(m+1)+(j+1)]+1 : Math.max(dp[(i+1)*(m+1)+j], dp[i*(m+1)+(j+1)]);
    const out = []; let i=0, j=0;
    while(i<n && j<m){
      if(A[i]===B[j]){ out.push({t:"ctx", text:A[i], a:i+1, b:j+1}); i++; j++; }
      else if(dp[(i+1)*(m+1)+j] >= dp[i*(m+1)+(j+1)]){ out.push({t:"del", text:A[i], a:++i}); }
      else out.push({t:"add", text:B[j], b:++j});
    }
    while(i<n) out.push({t:"del", text:A[i], a:++i});
    while(j<m) out.push({t:"add", text:B[j], b:++j});
    return out;
  }
  // group into hunks with `pad` lines of context
  function hunks(rows, pad){
    pad = pad==null ? 3 : pad;
    const keep = new Array(rows.length).fill(false);
    rows.forEach((r,i)=>{ if(r.t!=="ctx"){ for(let k=Math.max(0,i-pad);k<=Math.min(rows.length-1,i+pad);k++) keep[k]=true; } });
    if(rows.length && keep.every(k=>!k)) keep[0]=keep[rows.length-1]=true;
    const out = []; let cur = null;
    rows.forEach((r,i)=>{
      if(keep[i]){
        if(!cur){ cur = { rows:[] }; out.push(cur); }
        cur.rows.push(r);
      } else cur = null;
    });
    return out;
  }
  const stat = rows => ({ add: rows.filter(r=>r.t==="add").length, del: rows.filter(r=>r.t==="del").length });
  // three-way merge check: did the user change a line the AI also touched?
  // Uses the changed rows themselves, not the padded hunks — padding is for
  // display and would report a conflict for any edit near an AI change.
  function conflicts(base, mine, theirs){
    if(base === mine) return false;
    const d = lines(base, theirs);
    const baseL = base.split("\n"), mineL = mine.split("\n");
    const touched = new Set();
    let lastA = 1;
    for(const r of d){
      if(r.a != null) lastA = r.a;
      if(r.t === "ctx") continue;
      touched.add(r.a != null ? r.a : lastA); // a pure insertion lands after lastA
    }
    if(!touched.size) return false;
    for(const l of touched){
      if(l < 1 || l > baseL.length) continue;
      if(baseL[l-1] !== mineL[l-1]) return true;
    }
    return false;
  }
  return { lines, hunks, stat, conflicts };
})();

