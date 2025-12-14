// static/ui.js — robust init + target loading + breakpoint toggle normalization

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status} for ${url}`);
  return j;
}

async function postJSON(url, data) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status} for ${url}`);
  return j;
}

function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
  console.log("[WebDbg]", msg);
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
    return s;
  }
}

function parseArgs(argStr) {
  const s = (argStr || "").trim();
  return s ? s.split(/\s+/) : [];
}

function fmtRegs(regs) {
  const keys = [
    "rip","rsp","rbp","rax","rbx","rcx","rdx","rsi","rdi",
    "r8","r9","r10","r11","r12","r13","r14","r15","eflags"
  ];
  let out = "";
  for (const k of keys) if (regs[k] !== undefined) out += `${k.padEnd(6)} ${regs[k]}\n`;
  return out.trimEnd();
}

function fmtFrames(frames) {
  if (!Array.isArray(frames)) return "";
  return frames.map(f => {
    const fr = f.frame || f;
    const lvl = fr.level ?? "?";
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

  const rip = normHex(regs.rip);
  const bpAddrs = new Set((breakpoints || []).map(b => normHex(b.addr)).filter(Boolean));

  for (const entry of (disasm || [])) {
    const insn = entry.asm_insn || entry;
    const addrRaw = insn.address || insn.addr || "";
    const addr = normHex(addrRaw);

    const asm = insn.inst || insn.asm || "";
    const bytes = insn.opcodes ? `${insn.opcodes}  ` : "";

    const line = document.createElement("div");
    line.className = "dis-line";
    if (addr && rip && addr === rip) line.classList.add("cur");
    if (addr && bpAddrs.has(addr)) line.classList.add("bp");

    line.innerHTML = `
      <div class="addr">${addrRaw}</div>
      <div class="mono">${bytes}${asm}</div>
    `;

    line.addEventListener("click", async () => {
      if (!addr) return;
      try {
        const res = await postJSON("/api/break/toggle", { addr });
        applyState(res.state);
      } catch (e) {
        setStatus(`break toggle failed: ${e.message}`);
      }
    });

    container.appendChild(line);
  }
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
  try {
    const res = await getJSON("/api/state");
    applyState(res.state);
  } catch (e) {
    setStatus(`no session yet (${e.message})`);
  }
}

async function loadTargets() {
  const sel = document.getElementById("targetSelect");
  if (!sel) {
    setStatus("missing #targetSelect in HTML");
    return;
  }

  sel.innerHTML = `<option value="">(loading...)</option>`;

  try {
    const res = await getJSON("/api/targets");
    const targets = Array.isArray(res.targets) ? res.targets : [];

    console.log("[WebDbg] /api/targets returned:", targets);

    sel.innerHTML = "";
    if (targets.length === 0) {
      sel.innerHTML = `<option value="">(no executables in ./targets)</option>`;
      setStatus("targets list is empty — check ./targets files are executable");
      return;
    }

    for (const t of targets) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }

    if (targets.includes("demo")) sel.value = "demo";
    setStatus(`loaded ${targets.length} targets`);
  } catch (e) {
    sel.innerHTML = `<option value="">(failed to load)</option>`;
    setStatus(`failed to load targets: ${e.message}`);
  }
}

async function startSession() {
  const sel = document.getElementById("targetSelect");
  const argsEl = document.getElementById("targetArgs");

  const target = sel ? sel.value : "demo";
  const args = parseArgs(argsEl ? argsEl.value : "");

  try {
    await postJSON("/api/start", { target, args });
    await refresh();
  } catch (e) {
    setStatus(`start failed: ${e.message}`);
  }
}

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", fn);
}

window.addEventListener("DOMContentLoaded", async () => {
  setStatus("init...");
  await loadTargets();

  bind("btnStart", startSession);
  bind("btnRun",    () => postJSON("/api/ctrl", { action: "run"    }).then(r => applyState(r.state)).catch(e => setStatus(e.message)));
  bind("btnCont",   () => postJSON("/api/ctrl", { action: "continue" }).then(r => applyState(r.state)).catch(e => setStatus(e.message)));
  bind("btnStep",   () => postJSON("/api/ctrl", { action: "step"   }).then(r => applyState(r.state)).catch(e => setStatus(e.message)));
  bind("btnNext",   () => postJSON("/api/ctrl", { action: "next"   }).then(r => applyState(r.state)).catch(e => setStatus(e.message)));
  bind("btnStepi",  () => postJSON("/api/ctrl", { action: "stepi"  }).then(r => applyState(r.state)).catch(e => setStatus(e.message)));
  bind("btnNexti",  () => postJSON("/api/ctrl", { action: "nexti"  }).then(r => applyState(r.state)).catch(e => setStatus(e.message)));
  bind("btnFinish", () => postJSON("/api/ctrl", { action: "finish" }).then(r => applyState(r.state)).catch(e => setStatus(e.message)));
  bind("btnStop",   () => postJSON("/api/stop", {}).then(() => setStatus("stopped")).catch(e => setStatus(e.message)));

  // optional: try to show state if already running
  await refresh();
});
