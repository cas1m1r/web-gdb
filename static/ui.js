// static/ui.js

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
  document.getElementById("status").textContent = s;
}

/**
 * Normalize a hex-ish address string to canonical "0x<lowercase>" form.
 * Handles:
 *  - "0x40113a"
 *  - "0x000000000040113a"
 *  - (if GDB ever returns) "40113a"
 */
function normHex(x) {
  if (!x) return "";
  let s = String(x).trim();
  if (!s) return "";

  // BigInt() supports 0x... directly.
  // If missing 0x, try prefixing.
  try {
    if (!s.startsWith("0x") && /^[0-9a-fA-F]+$/.test(s)) {
      s = "0x" + s;
    }
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

  // show a small set of extras (helps on other archs / gdb versions)
  const extras = Object.keys(regs).filter(k => !keys.includes(k)).slice(0, 20);
  if (extras.length) out += "\n";
  for (const k of extras) out += `${k.padEnd(6)} ${regs[k]}\n`;

  return out.trimEnd();
}

function fmtFrames(frames) {
  if (!Array.isArray(frames)) return "";
  return frames.map(f => {
    const fr = f.frame || f; // MI often wraps as {frame:{...}}
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
  container.innerHTML = "";

  const ripNorm = normHex(regs.rip);

  // Normalize bp addresses into a set for reliable highlighting
  const bpAddrs = new Set(
    (breakpoints || [])
      .map(b => normHex(b.addr))
      .filter(Boolean)
  );

  for (const entry of (disasm || [])) {
    // MI shape can vary:
    // - {address,inst,opcodes}
    // - {asm_insn:{address,inst,opcodes}}
    const insn = entry.asm_insn || entry;

    const addrRaw = insn.address || insn.addr || "";
    const addrNorm = normHex(addrRaw);

    const asm = insn.inst || insn.asm || "";
    const bytes = insn.opcodes ? `${insn.opcodes}  ` : "";

    const line = document.createElement("div");
    line.className = "dis-line";

    if (addrNorm && ripNorm && addrNorm === ripNorm) line.classList.add("cur");
    if (addrNorm && bpAddrs.has(addrNorm)) line.classList.add("bp");

    // Display the *raw* address (nice to see what gdb reports),
    // but logic uses normalized addresses.
    line.innerHTML = `
      <div class="addr">${addrRaw}</div>
      <div class="mono">${bytes}${asm}</div>
    `;

    line.addEventListener("click", async () => {
      if (!addrNorm) return;
      // Send normalized form so backend can match consistently too
      const res = await postJSON("/api/break/toggle", { addr: addrNorm });
      if (res.ok) applyState(res.state);
      else setStatus(res.error || "break toggle failed");
    });

    container.appendChild(line);
  }
}

function applyState(state) {
  const regs = state.registers || {};
  document.getElementById("regs").textContent = fmtRegs(regs);
  document.getElementById("frames").textContent = fmtFrames(state.frames || []);
  document.getElementById("stack").textContent = fmtStack(state.stack || [], regs);

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

async function loadTargets() {
  const res = await getJSON("/api/targets");
  if (!res.ok) {
    setStatus(res.error || "failed to load targets");
    return;
  }

  const sel = document.getElementById("targetSelect");
  sel.innerHTML = "";

  for (const t of (res.targets || [])) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  }

  // Prefer demo if present
  if ((res.targets || []).includes("demo")) sel.value = "demo";
}

function parseArgs(argStr) {
  // MVP: split on whitespace. (Later you can do shell-like quoting.)
  const s = (argStr || "").trim();
  return s ? s.split(/\s+/) : [];
}

// Wire buttons
document.getElementById("btnStart").onclick = async () => {
  setStatus("starting...");

  const target = document.getElementById("targetSelect").value;
  const argsStr = document.getElementById("targetArgs").value;
  const args = parseArgs(argsStr);

  const res = await postJSON("/api/start", { target, args });
  if (res.ok) await refresh();
  else setStatus(res.error || "start failed");
};

document.getElementById("btnRun").onclick    = () => ctrl("run");
document.getElementById("btnCont").onclick   = () => ctrl("continue");
document.getElementById("btnStep").onclick   = () => ctrl("step");
document.getElementById("btnNext").onclick   = () => ctrl("next");
document.getElementById("btnStepi").onclick  = () => ctrl("stepi");
document.getElementById("btnNexti").onclick  = () => ctrl("nexti");
document.getElementById("btnFinish").onclick = () => ctrl("finish");

document.getElementById("btnStop").onclick = async () => {
  await postJSON("/api/stop", {});
  setStatus("stopped");
};

// Init
loadTargets().then(() => {
  // optional: auto-refresh if a session already exists
  // refresh();
});
