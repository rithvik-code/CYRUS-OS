// Regression tests for OS Phase 15 — full-content search.
//
// The bug this phase fixes is one no unit test of the old code would have
// caught: search scored FILENAMES. So the first assertion here is the important
// one — a term that appears only inside a file's body, and nowhere in its name,
// must be findable. Everything after that guards the properties that make the
// result usable rather than merely present.
const { ok, eq, report, makeCtx, loadOS } = require("./os_stub.js");

async function main() {

  // ---- tokenizer -----------------------------------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const S = ctx.SearchIndex;

    eq(S.tokenize("Recursion")[0], "recurs", "a single word is tokenized and stemmed");
    ok(S.tokenize("the a of and").length === 0, "stopwords alone produce no terms");
    eq(S.tokenize("the quick brown fox").join(","), "quick,brown,fox",
       "stopwords are dropped and content words are kept");
    ok(S.tokenize("a b c").length === 0, "one-letter fragments are discarded");
    ok(S.tokenize("").length === 0, "an empty string is not a crash");
    ok(S.tokenize(null).length === 0, "null is not a crash");

    // The stemmer's actual job: make word forms collide.
    eq(S.stem("recursion"), "recurs", "recursion -> recurs");
    eq(S.stem("recursion"), S.stem("recursing"), "recursion and recursing collide");
    eq(S.stem("classes"), "class", "a plural s is stripped");
    eq(S.stem("class"), "class", "but a word already ending in ss is left alone");
    eq(S.stem("studies"), "study", "ies -> y");
  }

  // ---- the actual gap: content, not names ----------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const { SearchIndex: S, VFS } = ctx;

    // A file whose NAME says nothing about its contents.
    VFS.writeFile("/home/rithvik/Documents/scratch.txt", "the function calls itself at every level");
    VFS.writeFile("/home/rithvik/Documents/other.txt", "completely unrelated text about cooking");
    await S.build();

    const hits = S.query("calls");
    ok(hits.length > 0, "a term inside a file body is findable — the bug this fixes");
    eq(hits[0].path, "/home/rithvik/Documents/scratch.txt", "and it resolves to the right file");
    ok(!hits.some(h => h.path.endsWith("other.txt")), "a file without the term is not returned");

    // Stemmed form: "recursion" is not in the query, "recursive" is not in the
    // file. They must still collide.
    VFS.writeFile("/home/rithvik/Documents/tree.md", "binary recursion on a sorted list");
    await S.build();
    const r1 = S.query("recursive");
    ok(r1.some(h => h.path.endsWith("tree.md")), "querying 'recursive' finds a file containing 'recursion'");
    const r2 = S.query("recursion");
    ok(r2.some(h => h.path.endsWith("tree.md")), "and the reverse also collides");
  }

  // ---- BM25 actually ranks --------------------------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const { SearchIndex: S, VFS } = ctx;

    // "widget" appears in many files (low information); "quokka" in one (high).
    for(let i = 0; i < 8; i++) VFS.writeFile(`/home/rithvik/Documents/noise${i}.txt`, "widget " + "filler ".repeat(40));
    VFS.writeFile("/home/rithvik/Documents/rare.txt", "quokka appears once here");
    await S.build();

    const hits = S.query("widget");
    ok(hits.length === 8, "a common term matches every file containing it");
    ok(hits.length > 1, "there is more than one hit, so ranking is meaningful");
    ok(hits[0].score > 0, "hits carry a real positive score");

    // Two files, same term, different counts: the denser one wins.
    VFS.writeFile("/home/rithvik/Documents/one.txt", "zebra");
    VFS.writeFile("/home/rithvik/Documents/many.txt", "zebra " + "zebra ".repeat(9));
    await S.build();
    const z = S.query("zebra");
    eq(z[0].path, "/home/rithvik/Documents/many.txt", "the file repeating the term ranks above the one that mentions it once");

    // A term in EVERY document must not produce a negative score that cancels
    // a genuine match — this is what the +1 in the IDF guards against.
    const common = S.query("filler");
    ok(common.every(h => h.score > 0), "a term present in every document still scores positive");
  }

  // ---- filters -------------------------------------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const { SearchIndex: S, VFS } = ctx;
    const now = Date.now();

    VFS.writeFile("/home/rithvik/Documents/new.py", "syntax highlighting token");
    VFS.node("/home/rithvik/Documents/new.py").mtime = now;
    VFS.writeFile("/home/rithvik/Documents/old.py", "syntax highlighting token");
    VFS.node("/home/rithvik/Documents/old.py").mtime = now - 90 * 86400000;
    VFS.writeFile("/home/rithvik/Documents/recent.md", "syntax highlighting token");
    VFS.node("/home/rithvik/Documents/recent.md").mtime = now - 2 * 86400000;
    await S.build();

    const all = S.query("syntax highlighting");
    eq(all.length, 3, "without filters every match is returned");

    const py = S.query("syntax", {ext:"py"});
    eq(py.length, 2, "an extension filter keeps only that type");
    ok(py.every(h => h.doc.ext === "py"), "and nothing else leaks through");

    eq(S.query("syntax", {ext:"PY"}).length, 2, "the extension filter is case-insensitive");
    eq(S.query("syntax", {ext:".py"}).length, 2, "a leading dot is tolerated");

    const recent = S.query("syntax", {sinceDays:30});
    eq(recent.length, 2, "a date filter drops files older than the window");
    ok(!recent.some(h => h.path.endsWith("old.py")), "and the old file is the one dropped");
    ok(recent.some(h => h.path.endsWith("new.py")), "while the recent one survives");

    const scoped = S.query("syntax", {path:"/home/rithvik/Documents/recent"});
    eq(scoped.length, 1, "a path prefix narrows the search");
  }

  // ---- quoted phrase -------------------------------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const { SearchIndex: S, VFS } = ctx;

    VFS.writeFile("/home/rithvik/Documents/a.txt", "this is the end of the line");
    VFS.writeFile("/home/rithvik/Documents/b.txt", "line noise at the end of nothing here");
    await S.build();

    const loose = S.query("end line");
    ok(loose.length >= 2, "loosely, both files contain the words end and line");

    const exact = S.query("end line", {phrase:"end of the line"});
    eq(exact.length, 1, "a quoted phrase requires the literal text");
    eq(exact[0].path, "/home/rithvik/Documents/a.txt", "and picks the file that actually contains it");
  }

  // ---- incremental: the property that keeps the OS responsive -------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const { SearchIndex: S, VFS } = ctx;

    for(let i = 0; i < 5; i++) VFS.writeFile(`/home/rithvik/Documents/f${i}.txt`, "content number " + i);
    await S.build();
    // The stub seeds a couple of files, so count from the seed rather than
    // asserting an absolute that silently depends on seed data.
    const seed = S.stats().docs - 5;
    ok(seed >= 1, "the stub's seeded files are indexed too", seed + " seeded");
    eq(S.stats().docs - seed, 5, "the first build indexes every file this block created");
    ok(S.stats().terms > 0, "and produces terms");

    // Rebuilding with nothing changed must read nothing.
    const auditBefore = ctx.__log.length;
    await S.build(true);
    const fullAudit = ctx.__log.slice(auditBefore).find(l => l[1] === "search_index");
    ok(fullAudit, "a forced reindex is audit-logged");
    ok(JSON.parse(fullAudit[2]).changed === S.stats().docs,
       "a forced reindex re-reads every file", JSON.stringify(fullAudit[2]));

    // An automatic rebuild (not forced) with nothing changed must read nothing.
    S.invalidate();
    const audit2 = ctx.__log.length;
    await S.build();
    const auto = ctx.__log.slice(audit2).find(l => l[1] === "search_index");
    ok(auto, "an automatic rebuild is audit-logged");
    eq(JSON.parse(auto[2]).changed, 0, "but an unchanged filesystem re-reads zero files — this is the whole point of the fingerprint");

    // Edit exactly one file: exactly one re-read.
    VFS.writeFile("/home/rithvik/Documents/f2.txt", "content number two, now different");
    S.invalidate();
    const audit3 = ctx.__log.length;
    await S.build();
    const one = ctx.__log.slice(audit3).find(l => l[1] === "search_index");
    eq(JSON.parse(one[2]).changed, 1, "editing one file re-reads exactly one file");

    // And the new text is searchable.
    ok(S.query("different").some(h => h.path.endsWith("f2.txt")), "the edited content is searchable straight away");

    // A deleted file must leave the index.
    VFS.remove("/home/rithvik/Documents/f2.txt");
    S.invalidate();
    await S.build();
    eq(S.stats().docs, seed + 4, "a deleted file is dropped from the index");
    ok(!S.query("different").some(h => h.path.endsWith("f2.txt")), "and its content is no longer findable");
    ok(!S.terms.has("different"), "its postings are purged from every term, not just left dangling");
  }

  // ---- snippets ------------------------------------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const { SearchIndex: S, VFS } = ctx;
    const body = ["intro line", "nothing here", "the quokka appears here", "more filler", "end of file"].join("\n");
    VFS.writeFile("/home/rithvik/Documents/deep.txt", body);
    await S.build();
    const s = S.snippet("/home/rithvik/Documents/deep.txt", "quokka", 1);
    ok(s.includes("quokka"), "the snippet shows the line that actually matched");
    ok(!s.startsWith("intro line"), "and it is the densest window, not the first line of the file");
    eq(S.snippet("/home/rithvik/Documents/nope.txt", "x"), "", "a snippet for a missing file is empty, not a crash");
  }

  // ---- honesty -------------------------------------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const S = ctx.SearchIndex;
    eq(S.stats().engine, "BM25 (lexical, offline)", "the engine names itself as lexical, not semantic");
    ok(!/semantic/i.test(S.stats().engine), "it does not call itself semantic");
  }

  // ---- the intent ----------------------------------------------------------
  {
    const ctx = makeCtx();
    ctx.Actions = { search_files: function(){ return {ok:true, message:"legacy filename-only answer"}; } };
    loadOS(ctx);
    await ctx.Cyrus.fireReady();
    // The onReady callback is async (it awaits the index restore), so the patch
    // lands a microtask or two later. Without this flush the test would call
    // the *old* implementation and report a failure that was really a race.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    ctx.VFS.writeFile("/home/rithvik/Documents/essay.md", "a paragraph about recursion and tree walks");
    const res = await ctx.Actions.search_files({query:"recursion"});
    ok(res.ok, "the search_files intent runs");
    ok(/essay\.md/.test(res.message), "and now finds content the old implementation could not", res.message);
    ok(!/legacy filename-only/.test(res.message), "the legacy implementation was actually replaced");

    const miss = await ctx.Actions.search_files({query:"zzzznotpresent"});
    ok(/lexical/.test(miss.message), "the no-match answer says the search is lexical, not semantic");
    ok(!/semantic/i.test(miss.message), "and never implies meaning-based matching");
  }

  process.exit(report("search tests"));
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });