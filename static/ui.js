// static/ui.js (backward-compatible)

async function postJSON(url, data) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {}),
  });
  return r.json();
}

async function getJSON(url) {
  const r = await fetch(url);
  return r.json();
}

function setStatus(s) {
  const el = document.getElementById("status");
  if (el) el.textContent = s;
}

function normHex(x) {
  if (!x) return "";
  let s = String(x).trim();
  if (!s) return "";
  try {
    if (!s.startsWith("0x") && /^[0-9a-fA-F]+$/.test(s)) s = "0x" + s;
    const v = BigInt(s);
    return "0x" + v.toString(16);
  } catch {
    return String(x).trim();
  }
}

function fmtRegs(regs) {
  const keys = [
    "rip","rsp","rbp",
    "rax","rbx","rcx","rdx","rsi","rdi",
    "r8","r9","r10","r11","r12","r13","r14","r15",
    "eflags"
  ];
  let out = "";
  for (const k of keys) {
    if (regs[k] !== undefined) out += `${k.padEnd(6)} ${regs[k]}\n`;
  }
  const extras = Object.keys(regs).filter(k => !keys.includes(k)).slice(0, 20);
  if (extras.length) out += "\n";
  for (const k of extras) out += `${k.padEnd(6)} ${regs[k]}\n`;
  return out.trimEnd();
}

function fmtFrames(frames) {
  if (!Array.isArray(frames)) return "";
  return frames.map(f => {
    const fr = f.frame || f;
    const lvl  = fr.level ?? "?";
    const func = fr.func ?? "?";
    const addr = fr.addr ?? "?";
    const file = fr.file ? ` ${fr.file}:${fr.line ?? "?"}` : "";
    return `#${lvl} ${func} ${addr}${file}`;
  }).join("\n");
}

function fmtStack(stack, regs) {
  const rsp = normHex(regs.rsp);
  const rbp = normHex(regs.rbp);
  let out = "";
  for (const row of (stack || [])) {
    const a = normHex(row.addr);
    let tag = "";
    if (rsp && a === rsp) tag += " <== RSP";
    if (rbp && a === rbp) tag += " <== RBP";
    out += `${row.addr}  ${String(row.qword).padEnd(18)}  ${row.ascii}${tag}\n`;
  }
  return out.trimEnd();
}

function renderDisasm(container, disasm, regs, breakpoints) {
  if (!container) return;
  container.innerHTML = "";

  const ripNorm = normHex(regs.rip);
  const bpAddrs = new Set((breakpoints || []).map(b => normHex(b.addr)).filter(Boolean));

  for (const entry of (disasm || [])) {
    const insn = entry.asm_insn || entry;
    const addrRaw = insn.address || insn.addr || "";
    const addrNorm = normHex(addrRaw);

    const asm = insn.inst || insn.asm || "";
    const bytes = insn.opcodes ? `${insn.opcodes}  ` : "";

    const line = document.createElement("div");
    line.className = "dis-line";

    if (addrNorm && ripNorm && addrNorm === ripNorm) line.classList.add("cur");
    if (addrNorm && bpAddrs.has(addrNorm)) line.classList.add("bp");

    line.innerHTML = `
      <div class="addr">${addrRaw}</div>
      <div class="mono">${bytes}${asm}</div>
    `;

    line.addEventListener("click", async () => {
      if (!addrNorm) return;
      const res = await postJSON("/api/break/toggle", { addr: addrNorm });
      if (res.ok) applyState(res.state);
      else setStatus(res.error || "break toggle failed");
    });

    container.appendChild(line);
  }
}

function applyState(state) {
  const regs = state.registers || {};

  const regsEl = document.getElementById("regs");
  if (regsEl) regsEl.textContent = fmtRegs(regs);

  const framesEl = document.getElementById("frames");
  if (framesEl) framesEl.textContent = fmtFrames(state.frames || []);

  const stackEl = document.getElementById("stack");
  if (stackEl) stackEl.textContent = fmtStack(state.stack || [], regs);

  renderDisasm(
    document.getElementById("disasm"),
    state.disasm || [],
    regs,
    state.breakpoints || []
  );

  const reason = (state.stop && state.stop.reason) ? state.stop.reason : state.status;
  setStatus(`${state.status} (${reason})`);
}

async function refresh() {
  const res = await getJSON("/api/state");
  if (res.ok) applyState(res.state);
  else setStatus(res.error || "no session");
}

async function ctrl(action) {
  const res = await postJSON("/api/ctrl", { action });
  if (res.ok) applyState(res.state);
  else setStatus(res.error || "ctrl failed");
}

function parseArgs(argStr) {
  const s = (argStr || "").trim();
  return s ? s.split(/\s+/) : [];
}

/**
 * Best-effort target support:
 * - If /api/targets exists AND #targetSelect exists -> populate dropdown and start with {target,args}
 * - Otherwise -> start with legacy {program,args} pointing at ./targets/demo
 */
async function initTargets() {
  const sel = document.getElementById("targetSelect");
  if (!sel) return { mode: "legacy" };

  try {
    const res = await getJSON("/api/targets");
    if (!res.ok || !Array.isArray(res.targets)) return { mode: "legacy" };

    sel.innerHTML = "";
    for (const t of res.targets) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
    if (res.targets.includes("demo")) sel.value = "demo";
    return { mode: "targets" };
  } catch {
    return { mode: "legacy" };
  }
}

// Wire buttons (guarded so missing elements won’t crash)
const btnStart = document.getElementById("btnStart");
const btnRun = document.getElementById("btnRun");
const btnCont = document.getElementById("btnCont");
const btnStep = document.getElementById("btnStep");
const btnNext = document.getElementById("btnNext");
const btnStepi = document.getElementById("btnStepi");
const btnNexti = document.getElementById("btnNexti");
const btnFinish = document.getElementById("btnFinish");
const btnStop = document.getElementById("btnStop");

let startMode = "legacy";

(async () => {
  const init = await initTargets();
  startMode = init.mode;
})();

if (btnStart) {
  btnStart.onclick = async () => {
    setStatus("starting...");

    const argsEl = document.getElementById("targetArgs");
    const args = parseArgs(argsEl ? argsEl.value : "");

    // New mode: {target,args}
    if (startMode === "targets") {
      const sel = document.getElementById("targetSelect");
      const target = sel ? sel.value : "demo";
      const res = await postJSON("/api/start", { target, args });
      if (res.ok) await refresh();
      else setStatus(res.error || "start failed");
      return;
    }

    // Legacy mode: {program,args}
    // (works with your original /api/start)
    const res = await postJSON("/api/start", { program: "./targets/demo", args });
    if (res.ok) await refresh();
    else setStatus(res.error || "start failed");
  };
}

if (btnRun) btnRun.onclick = () => ctrl("run");
if (btnCont) btnCont.onclick = () => ctrl("continue");
if (btnStep) btnStep.onclick = () => ctrl("step");
if (btnNext) btnNext.onclick = () => ctrl("next");
if (btnStepi) btnStepi.onclick = () => ctrl("stepi");
if (btnNexti) btnNexti.onclick = () => ctrl("nexti");
if (btnFinish) btnFinish.onclick = () => ctrl("finish");

if (btnStop) {
  btnStop.onclick = async () => {
    await postJSON("/api/stop", {});
    setStatus("stopped");
  };
}
