// Regression tests for OS Phase 11 — the System panel.
//
// This suite exists because of one specific lie. `Actions.system_report` used
// to return the string "of 512 GB used (1%)" and "Nothing is eating memory"
// as literals. A test that only checks the new panel works would pass again the
// day someone reintroduced a fabricated number, so the load-bearing assertions
// here are the negative ones: no invented figure may survive anywhere in the
// output, and every row must be able to say where it came from.
const { ok, eq, report, makeCtx, loadOS } = require("./os_stub.js");

async function main() {

  // ---- a browser that exposes nothing optional ----------------------------
  // The honest default: most of these APIs are absent in some browser, and the
  // panel has to cope rather than throwing.
  {
    const ctx = makeCtx({ performance: {} });
    loadOS(ctx);
    const rows = await ctx.SysProbe.all();

    ok(rows.length > 10, "the probe produces a substantial table", rows.length + " rows");
    for (const r of rows) {
      ok(["browser", "bridge", "unavailable"].indexOf(r.provenance) >= 0,
         "every row carries a provenance: " + r.label, r.provenance);
      ok(typeof r.note === "string" && r.note.length > 0,
         "every row explains itself: " + r.label, r.note);
      if (r.provenance === "unavailable") {
        eq(r.value, null, "an unavailable row has no value: " + r.label);
      } else {
        ok(r.value !== null && r.value !== undefined, "a measured row has a value: " + r.label);
      }
    }

    // The five rows that will never turn green, and the reason that is the point.
    const byLabel = {};
    for (const r of rows) byLabel[r.label] = r;
    for (const label of ["Kernel modules", "Drivers", "BIOS / UEFI", "Filesystem repair", "System users / permissions"]) {
      ok(!!byLabel[label], "the panel lists the honest gap: " + label);
      eq(byLabel[label] && byLabel[label].provenance, "unavailable", label + " is marked unavailable");
      ok(byLabel[label] && byLabel[label].note.length > 10, label + " says why it is out of reach");
    }

    // A browser with no performance.memory must not invent a heap number.
    ok(!byLabel["JS heap in use"] || byLabel["JS heap in use"].provenance === "unavailable",
       "with no performance.memory the heap row is unavailable, not guessed");

    const text = ctx.SysProbe.text();
    ok(!/512\s*GB/.test(text), "the rendered table contains no invented 512 GB", text.slice(0, 200));
    ok(!/Nothing is eating memory/.test(text), "the old 'Nothing is eating memory' line is gone");
    ok(/not reachable from a browser/.test(text), "unavailable rows say so in the rendered text");
  }

  // ---- a browser that exposes the common APIs -----------------------------
  {
    const ctx = makeCtx({
      performance: { memory: { usedJSHeapSize: 4194304, jsHeapSizeLimit: 268435456 } },
    });
    loadOS(ctx);
    const rows = await ctx.SysProbe.all();
    const byLabel = {};
    for (const r of rows) byLabel[r.label] = r;

    eq(byLabel["Logical cores"].value, "8", "logical cores are read from hardwareConcurrency");
    eq(byLabel["Logical cores"].provenance, "browser", "and are attributed to the browser, not to a core-detection claim");
    eq(byLabel["JS heap in use"].value, "4.0 MB", "the JS heap is measured, not estimated");
    eq(byLabel["JS heap in use"].provenance, "browser", "the heap reading is attributed to the browser");
    ok(/not your physical RAM|not.*physical/i.test(byLabel["JS heap in use"].note),
       "the heap row warns it is not system RAM", byLabel["JS heap in use"].note);

    ok(byLabel["This origin"] && /browser/.test(byLabel["This origin"].provenance),
       "storage is attributed to storage.estimate()");
    ok(!/512/.test(byLabel["This origin"].value), "the storage figure is the real quota", byLabel["This origin"].value);

    // Kernel rows must stay unavailable even when everything else works.
    eq(byLabel["Drivers"].provenance, "unavailable",
       "a capable browser still cannot install a driver — and does not claim to");
  }

  // ---- the intent itself ---------------------------------------------------
  // The single most important assertion in the repository.
  {
    const ctx = makeCtx();
    // Actions/IntentEngine/SCHEMAS are declared after the splice point in the
    // real page, so they are absent until Cyrus.fireReady() runs. Staging them
    // here reproduces that ordering exactly rather than assuming it away.
    vm_actions(ctx);
    loadOS(ctx);
    ctx.Cyrus.fireReady();

    ok(typeof ctx.Actions === "object" && typeof ctx.Actions.system_report === "function",
       "Actions.system_report is patched by the phase");
    const res = await ctx.Actions.system_report();
    ok(res && res.ok, "system_report succeeds");
    const msg = res.message;

    ok(!/512\s*GB/.test(msg), "system_report output contains no invented capacity", msg.slice(0, 300));
    ok(!/Nothing is eating memory/.test(msg), "system_report no longer claims nothing is using memory");
    ok(!/\b512\b/.test(msg), "system_report contains no bare 512 anywhere");
    ok(/Measured just now/.test(msg), "system_report leads with the fact that these were measured");
    ok(/Not reachable from a browser/.test(msg), "system_report lists what it cannot see");
    ok(/nothing here is estimated/i.test(msg), "system_report states plainly that nothing is estimated");
    ok(/\[browser\]/.test(msg), "at least one row is attributed to a source");
    ok(/open memory/.test(msg) === false, "the old pointer to a nonexistent 'open memory' action is gone");
  }

  // ---- df must not invent a disk either ------------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const df = await ctx.DiskUsage.report();
    ok(!/512/.test(df), "df contains no invented capacity", df);
    ok(/browser storage\.estimate/.test(df), "df names storage.estimate() as its source");
  }

  process.exit(report("system tests"));
}

// Reproduce the real load order: Actions is declared after the chunk, and the
// chunk patches it from Cyrus.onReady. Installing the *old* implementation here
// means the test fails loudly if the patch silently stops firing.
function vm_actions(ctx) {
  ctx.Actions = { system_report: function () {
    return { ok: true, message: "Total: 1 of 512 GB used (1%)\nNothing is eating memory — ask “open memory”." };
  } };
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });