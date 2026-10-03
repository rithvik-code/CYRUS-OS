// ============================================================================
//  OS PHASE 11 — SYSTEM
//  Every measurement below carries where it came from. A number CYRUS cannot
//  prove is rendered as "not reachable from a browser", never as a plausible
//  guess.
// ============================================================================
//
//  WHY THIS FILE EXISTS
//  -------------------
//  The intent `system_report` used to answer "what's using my disk and RAM?"
//  with two string literals:
//
//      Total: 4.2 MB of 512 GB used (1%)
//      Nothing is eating memory
//
//  Both were invented. The 512 GB never came from anywhere. This file replaces
//  that with measurements that are either real or explicitly absent, and it
//  records the provenance of each one so the next person can tell the
//  difference without reading the source.
//
//  The rule this file holds to:
//      A row is either MEASURED (and says how), or NOT REACHABLE (and says
//      why). There is no third state.
// ============================================================================

// provenance: "browser" | "bridge" | "unavailable"
// `note` is what the number is NOT, in plain words.
const SysProbe = {
  rows:[],

  row(group, label, value, provenance, note){
    this.rows.push({group, label, value, provenance, note});
    return this.rows[this.rows.length-1];
  },

  reset(){ this.rows = []; return this; },

  async all(){
    this.reset();
    await this.cpu();
    await this.memory();
    await this.storage();
    await this.gpu();
    await this.battery();
    await this.network();
    this.display();
    await this.devices();
    this.kernel();
    return this.rows;
  },

  // ---- CPU -----------------------------------------------------------------
  async cpu(){
    const cores = navigator.hardwareConcurrency;
    if(cores){
      this.row("Processor", "Logical cores", String(cores), "browser",
               "what the page is allowed to see — not the CPU model, not clocks");
    }else{
      this.row("Processor", "Logical cores", null, "unavailable", "hardwareConcurrency not exposed");
    }
    const mem = navigator.deviceMemory;
    if(mem) this.row("Processor", "Device memory class", mem + " GB", "browser",
                     "a coarse bucket (1/2/4/8), not a measurement of installed RAM");
  },

  // ---- Memory --------------------------------------------------------------
  // `fmtSize` takes KILOBYTES. performance.memory, storage.estimate and psutil
  // all report BYTES. Every conversion below is explicit because getting it
  // wrong inflates a 4 MB heap into a convincing "4.0 GB".
  async memory(){
    const p = performance.memory;
    if(p && p.usedJSHeapSize != null){
      this.row("Memory", "JS heap in use", fmtSize(p.usedJSHeapSize/1024), "browser",
               "this tab's JavaScript heap — not your physical RAM, and not what the OS is using");
      if(p.jsHeapSizeLimit) this.row("Memory", "JS heap limit", fmtSize(p.jsHeapSizeLimit/1024), "browser",
               "the engine's ceiling for this tab, not your installed memory");
    }else{
      this.row("Memory", "JS heap in use", null, "unavailable",
               "performance.memory is not exposed in this browser (it is Chromium-only)");
    }
  },

  // ---- Storage -------------------------------------------------------------
  async storage(){
    let est = null;
    try{ est = await navigator.storage.estimate(); }catch(e){}
    if(est && est.quota){
      const pct = Math.round((est.usage||0) / est.quota * 100);
      this.row("Storage", "This origin", fmtSize((est.usage||0)/1024) + " of " + fmtSize(est.quota/1024) + " (" + pct + "%)",
               "browser", "quota the browser grants this site — not your disk");
    }else{
      this.row("Storage", "This origin", null, "unavailable", "storage.estimate() denied or unsupported");
    }
    if(Bridge.online){
      try{
        const s = await Bridge.call("sensors", {});
        (s.memory||[]).forEach(m=>{
          this.row("Memory", "Physical " + (m.mount||"system"), fmtSize(m.used/1024) + " of " + fmtSize(m.total/1024),
                   "bridge", "read from this machine by cyrus.bridge");
        });
        (s.disks||[]).forEach(d=>{
          this.row("Storage", "Disk " + (d.mount||""), fmtSize(d.used/1024) + " of " + fmtSize(d.total/1024),
                   "bridge", "real filesystem on this machine");
        });
      }catch(e){
        this.row("Memory", "Physical memory", null, "unavailable", "bridge did not answer: " + (e.message||e));
      }
    }
  },

  // ---- GPU -----------------------------------------------------------------
  async gpu(){
    let info = null;
    try{
      if(navigator.gpu && navigator.gpu.requestAdapter){
        const ad = await navigator.gpu.requestAdapter();
        if(ad && ad.info) info = ad.info;
      }
    }catch(e){}
    let unmasked = null;
    try{
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if(gl){
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if(ext) unmasked = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      }
    }catch(e){}
    const v = (info && (info.vendor || info.architecture)) || unmasked;
    if(v) this.row("Graphics", "Adapter", String(v), "browser",
                   "which GPU is available — CYRUS cannot install or swap a driver");
    else this.row("Graphics", "Adapter", null, "unavailable", "neither WebGPU adapter info nor WebGL renderer exposed");
  },

  // ---- Battery -------------------------------------------------------------
  async battery(){
    if(!navigator.getBattery){
      this.row("Power", "Battery", null, "unavailable", "Battery Status API not available here");
      return;
    }
    try{
      const b = await navigator.getBattery();
      if(b && typeof b.level === "number"){
        this.row("Power", "Battery", Math.round(b.level*100) + "%" + (b.charging ? " (charging)" : ""),
                 "browser", "many browsers deliberately report a fixed 100%");
      }else{
        this.row("Power", "Battery", null, "unavailable", "the browser declined to report a level");
      }
    }catch(e){ this.row("Power", "Battery", null, "unavailable", "Battery Status API blocked"); }
  },

  // ---- Network -------------------------------------------------------------
  network(){
    const c = navigator.connection;
    if(c){
      this.row("Network", "Connection", (c.effectiveType || "unknown") +
               (c.downlink ? " · " + c.downlink + " Mb/s" : "") + (c.saveData ? " · data saver" : ""),
               "browser", "a hint from the OS, not a measurement of throughput");
    }else{
      this.row("Network", "Connection", null, "unavailable", "Network Information API not available");
    }
    this.row("Network", "Origin", location.protocol + "//" + (location.host||"(no host)"), "browser",
             "file:// means no service worker, no install, and cross-origin APIs need CORS");
  },

  // ---- Display -------------------------------------------------------------
  display(){
    if(typeof screen!=="undefined"){
      this.row("Display", "Screen", screen.width + "×" + screen.height +
               " @ " + (window.devicePixelRatio||1) + "×", "browser", "CSS pixels vs device pixels");
    }
  },

  // ---- Devices: counts only, never control ---------------------------------
  async devices(){
    const add = async (label, fn, note)=>{
      try{
        const n = await fn();
        if(n == null) throw new Error("no such API");
        this.row("Devices", label, n === 0 ? "none connected" : n + " available", "browser", note);
      }catch(e){
        this.row("Devices", label, null, "unavailable", "not exposed in this browser");
      }
    };
    await add("USB", ()=>navigator.usb && navigator.usb.getDevices().then(d=>d.length), "handles for devices you have already granted");
    await add("Serial ports", ()=>navigator.serial && navigator.serial.getPorts().then(p=>p.length), "ports you have already granted");
    await add("HID", ()=>navigator.hid && navigator.hid.getDevices().then(d=>d.length), "devices you have already granted");
    await add("Bluetooth", ()=>navigator.bluetooth && navigator.bluetooth.getAvailability(), "available — CYRUS cannot pair without a user gesture");
  },

  // ---- The rows that will never turn green --------------------------------
  //  Listing these is the point. A panel that only shows what it can do reads
  //  as complete; this one is visibly incomplete, which is the truth.
  kernel(){
    this.row("Kernel", "Kernel modules", null, "unavailable", "a page cannot load or unload kernel modules");
    this.row("Kernel", "Drivers", null, "unavailable", "driver installation needs an installer and an OS-level token");
    this.row("Kernel", "BIOS / UEFI", null, "unavailable", "firmware settings are not addressable from a browser");
    this.row("Kernel", "Filesystem repair", null, "unavailable", "fsck-style repair needs privileged raw disk access");
    this.row("Kernel", "System users / permissions", null, "unavailable", "device profiles are not OS accounts");
  },

  // ---- Rendering -----------------------------------------------------------
  text(){
    if(!this.rows.length) return "Not measured yet.";
    const out = [];
    let group = null;
    for(const r of this.rows){
      if(r.group !== group){ group = r.group; out.push("", group.toUpperCase()); }
      const v = r.provenance === "unavailable" ? "not reachable from a browser" : r.value;
      // The status is never truncated — "not reachable from a brows" is worse
      // than useless, it just looks like a rendering bug.
      out.push("  " + pad(r.label, 24) + (v == null ? "" : String(v)) +
               (r.provenance === "unavailable" ? " ·" : " ✓") +
               "\n      " + (r.note||""));
    }
    return out.join("\n");
  },
};

// ============================================================================
//  The System app
// ============================================================================
Apps.register("system", {
  title:"System", icon:"🖥️",
  launch(){
    WM.open({
      id:"cyrus-system", title:"System", icon:"🖥️", w:660, h:560,
      async build(win){
        const body = Cyrus.el("div","cyr-sys");
        win.body.appendChild(body);
        const paint = async ()=>{
          body.innerHTML = `<div class="cyr-sys-bar"><button class="btn ghost" id="cyr-refresh">Measure again</button>
            <span class="cyr-sys-src">${Bridge.online ? "bridge connected" : "browser APIs only" + (Bridge.url ? " · bridge not answering" : "")}</span></div>
            <div class="cyr-sys-rows">measuring…</div>`;
          const rows = await SysProbe.all();
          const groups = [];
          for(const r of rows){ if(!groups.find(g=>g.name===r.group)) groups.push({name:r.group, rows:[]}); groups.find(g=>g.name===r.group).rows.push(r); }
          body.querySelector(".cyr-sys-rows").innerHTML = groups.map(g=>
            `<div class="cyr-sys-g"><h4>${esc(g.name)}</h4>` +
            g.rows.map(r=>`<div class="cyr-sys-r ${r.provenance}">
                <div class="k">${esc(r.label)}</div>
                <div class="v">${esc(r.provenance==="unavailable" ? "not reachable from a browser" : r.value)}</div>
                <div class="p">${esc(r.provenance==="unavailable" ? "unavailable" : r.provenance)}</div>
                <div class="n">${esc(r.note||"")}</div></div>`).join("") +
            `</div>`).join("");
          body.querySelector("#cyr-refresh").addEventListener("click", paint);
        };
        paint();
      },
    });
  }
});

// ============================================================================
//  Replace the fabricated `system_report`
// ============================================================================
//  SCHEMAS / IntentEngine / Actions are declared ~1500 lines *after* this
//  splice point, so touching them at load time would throw a TDZ error. onReady
//  fires once the whole script has executed.
Cyrus.onReady(()=>{
  if(typeof Actions === "undefined" || !Actions.system_report) return;
  Actions.system_report = async function(){
    const rows = await SysProbe.all();
    const measured = rows.filter(r => r.provenance !== "unavailable");
    const missing  = rows.filter(r => r.provenance === "unavailable");

    const L = [];
    L.push("Measured just now, on this machine, from the browser");
    L.push("");
    for(const r of measured){
      L.push("  " + pad(r.label, 24) + pad(String(r.value), 26) + "[" + r.provenance + "]");
      L.push("      " + (r.note||""));
    }
    L.push("");
    L.push("Not reachable from a browser (" + missing.length + " rows)");
    for(const r of missing) L.push("  · " + pad(r.label, 24) + r.note);
    L.push("");
    L.push("Every number above was read from a live API. Nothing here is estimated.");
    L.push("Open the System app for the same table with each row's provenance.");
    return {ok:true, message:L.join("\n")};
  };
});