async function postJSON(url, data) {
  const r = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(data || {})
  });
  return r.json();
}

async function getJSON(url) {
  const r = await fetch(url);
  return r.json();
}

function fmtRegs(regs) {
  const keys = ["rip","rsp","rbp","rax","rbx","rcx","rdx","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15","eflags"];
  let out = "";
  for (const k of keys) {
    if (regs[k] !== undefined) out += `${k.padEnd(6)} ${regs[k]}\n`;
  }
  out += "\n";
  // also show any extras (short list)
  const extras = Object.keys(regs).filter(k => !keys.includes(k)).slice(0, 20);
  for (const k of extras) out += `${k.padEnd(6)} ${regs[k]}\n`;
  return out.trimEnd();
}

function fmtFrames(frames) {
  if (!Array.isArray(frames)) return "";
  return frames.map(f => {
    const fr = f.frame || f; // MI often wraps as {frame:{...}}
    const lvl = fr.level ?? "?";
    const func = fr.func ?? "?";
    const addr = fr.addr ?? "?";
    const file = fr.file ? ` ${fr.file}:${fr.line ?? "?"}` : "";
    return `#${lvl} ${func} ${addr}${file}`;
  }).join("\n");
}

function fmtStack(stack, regs) {
  const rsp = regs.rsp;
  const rbp = regs.rbp;
  let out = "";
  for (const row of (stack || [])) {
    let tag = "";
    if (rsp && row.addr === rsp) tag += " <== RSP";
    if (rbp && row.addr === rbp) tag += " <== RBP";
    out += `${row.addr}  ${row.qword.padEnd(18)}  ${row.ascii}${tag}\n`;
  }
  return out.trimEnd();
}

function renderDisasm(container, disasm, regs, breakpoints) {
  container.innerHTML = "";
  const rip = regs.rip;

  const bpAddrs = new Set((breakpoints || []).map(b => b.addr).filter(Boolean));

  for (const entry of (disasm || [])) {
    const insn = entry.asm_insn || entry; // depends on MI payload shape
    const addr = insn.address || insn.addr || "";
    const asm = insn.inst || insn.asm || "";
    const bytes = insn.opcodes ? `${insn.opcodes}  ` : "";

    const line = document.createElement("div");
    line.className = "dis-line";

    if (addr && rip && addr === rip) line.classList.add("cur");
    if (addr && bpAddrs.has(addr)) line.classList.add("bp");

    line.innerHTML = `
      <div class="addr">${addr}</div>
      <div class="mono">${bytes}${asm}</div>
    `;

    line.addEventListener("click", async () => {
      if (!addr) return;
      const res = await postJSON("/api/break/toggle", {addr});
      if (res.ok) applyState(res.state);
      else setStatus(res.error || "break toggle failed");
    });

    container.appendChild(line);
  }
}

function setStatus(s) {
  document.getElementById("status").textContent = s;
}

function applyState(state) {
  const regs = state.registers || {};
  document.getElementById("regs").textContent = fmtRegs(regs);
  document.getElementById("frames").textContent = fmtFrames(state.frames || []);
  document.getElementById("stack").textContent = fmtStack(state.stack || [], regs);
  renderDisasm(document.getElementById("disasm"), state.disasm || [], regs, state.breakpoints || []);

  const reason = (state.stop && state.stop.reason) ? state.stop.reason : state.status;
  setStatus(`${state.status} (${reason})`);
}

async function refresh() {
  const res = await getJSON("/api/state");
  if (res.ok) applyState(res.state);
  else setStatus(res.error || "no session");
}

async function ctrl(action) {
  const res = await postJSON("/api/ctrl", {action});
  if (res.ok) applyState(res.state);
  else setStatus(res.error || "ctrl failed");
}

document.getElementById("btnStart").onclick = async () => {
  setStatus("starting...");
  const target = document.getElementById("targetSelect").value;
  const argsStr = document.getElementById("targetArgs").value.trim();
  const args = argsStr ? argsStr.split(/\s+/) : [];

  const res = await postJSON("/api/start", { target, args });
  if (res.ok) await refresh();
  else setStatus(res.error || "start failed");
};


document.getElementById("btnRun").onclick = () => ctrl("run");
document.getElementById("btnCont").onclick = () => ctrl("continue");
document.getElementById("btnStep").onclick = () => ctrl("step");
document.getElementById("btnNext").onclick = () => ctrl("next");
document.getElementById("btnStepi").onclick = () => ctrl("stepi");
document.getElementById("btnNexti").onclick = () => ctrl("nexti");
document.getElementById("btnFinish").onclick = () => ctrl("finish");

document.getElementById("btnStop").onclick = async () => {
  await postJSON("/api/stop", {});
  setStatus("stopped");
};

async function loadTargets() {
  const res = await getJSON("/api/targets");
  if (!res.ok) {
    setStatus(res.error || "failed to load targets");
    return;
  }
  const sel = document.getElementById("targetSelect");
  sel.innerHTML = "";
  for (const t of res.targets) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  }
  if (res.targets.includes("demo")) sel.value = "demo";
}

loadTargets();
