import subprocess
import threading
import queue
import time
from typing import Optional, Dict, Any, List

from mi_parse import parse_mi_line

class GdbMiSession:
    def __init__(self, program: str, args: Optional[List[str]] = None):
        self.program = program
        self.args = args or []
        self.proc = None
        self.q = queue.Queue()
        self.reader_t = None

        self.reg_names: List[str] = []
        self.last_stop: Dict[str, Any] = {}
        self.running = False

    def start(self):
        if self.proc:
            return

        self.proc = subprocess.Popen(
            ["gdb", "--interpreter=mi2", "--quiet", "--nx"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        self.reader_t = threading.Thread(target=self._reader_loop, daemon=True)
        self.reader_t.start()

        # Basic init
        self.cmd(f'-gdb-set disassembly-flavor intel', wait_for="done")
        self.cmd(f'-file-exec-and-symbols {self.program}', wait_for="done")

        if self.args:
            # join args safely-ish (MI parsing is touchy; keep simple)
            joined = " ".join(self.args)
            self.cmd(f'-exec-arguments {joined}', wait_for="done")

        # Collect register names once
        res = self.cmd('-data-list-register-names', wait_for="done")
        names = res.get("payload", {}).get("register-names", [])
        # names comes as list of strings
        self.reg_names = [n if isinstance(n, str) else "" for n in names]

    def stop(self):
        if not self.proc:
            return
        try:
            self.cmd("-gdb-exit", wait_for=None)
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass
        self.proc = None

    def _reader_loop(self):
        assert self.proc and self.proc.stdout
        for raw in self.proc.stdout:
            line = raw.rstrip("\n")
            rec = parse_mi_line(line)
            if rec:
                self.q.put(rec)

    def _write(self, line: str):
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def cmd(self, mi_cmd: str, wait_for: Optional[str] = "done", timeout: float = 2.0) -> Dict[str, Any]:
        """
        Send MI command and optionally wait for a result record (^done/^running/^error).
        Returns the last seen result record if wait_for is set, else {}.
        """
        if not self.proc:
            raise RuntimeError("GDB session not started")

        self._write(mi_cmd)

        if wait_for is None:
            return {}

        deadline = time.time() + timeout
        last_result = {}
        while time.time() < deadline:
            try:
                rec = self.q.get(timeout=0.05)
            except queue.Empty:
                continue

            if rec["kind"] == "async":
                # track stop events
                if rec["cls"] == "stopped":
                    self.last_stop = rec["payload"]
                    self.running = False
            elif rec["kind"] == "result":
                last_result = rec
                if wait_for == rec["cls"]:
                    return rec

                # Often we accept anything result-like
                if wait_for == "any":
                    return rec

        # If we timed out, return whatever we saw
        return last_result

    def run(self):
        self.running = True
        self.cmd("-exec-run", wait_for="running", timeout=2.0)
        self._wait_for_stop(timeout=5.0)

    def cont(self):
        self.running = True
        self.cmd("-exec-continue", wait_for="running", timeout=2.0)
        self._wait_for_stop(timeout=5.0)

    def stepi(self):
        self.running = True
        self.cmd("-exec-step-instruction", wait_for="running", timeout=2.0)
        self._wait_for_stop(timeout=5.0)

    def nexti(self):
        self.running = True
        self.cmd("-exec-next-instruction", wait_for="running", timeout=2.0)
        self._wait_for_stop(timeout=5.0)

    def step(self):
        self.running = True
        self.cmd("-exec-step", wait_for="running", timeout=2.0)
        self._wait_for_stop(timeout=5.0)

    def next(self):
        self.running = True
        self.cmd("-exec-next", wait_for="running", timeout=2.0)
        self._wait_for_stop(timeout=5.0)

    def finish(self):
        self.running = True
        self.cmd("-exec-finish", wait_for="running", timeout=2.0)
        self._wait_for_stop(timeout=5.0)

    def _wait_for_stop(self, timeout: float = 5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                rec = self.q.get(timeout=0.05)
            except queue.Empty:
                continue
            if rec["kind"] == "async" and rec["cls"] == "stopped":
                self.last_stop = rec["payload"]
                self.running = False
                return
        # If the program exited, you may not get stopped — that's fine.

    def break_insert(self, spec: str):
        # spec can be "main" or "*0x401000" or "file:line"
        self.cmd(f"-break-insert {spec}", wait_for="done", timeout=2.0)

    def break_delete(self, bpnum: str):
        self.cmd(f"-break-delete {bpnum}", wait_for="done", timeout=2.0)

    def list_breakpoints(self) -> List[Dict[str, Any]]:
        res = self.cmd("-break-list", wait_for="done", timeout=2.0)
        bpt = res.get("payload", {}).get("BreakpointTable", {})
        body = bpt.get("body", [])
        out = []
        for row in body:
            if isinstance(row, dict) and "bkpt" in row:
                out.append(row["bkpt"])
        return out

    def snapshot(self) -> Dict[str, Any]:
        # registers (all)
        regs = self.cmd("-data-list-register-values x", wait_for="done", timeout=2.0)
        regvals = regs.get("payload", {}).get("register-values", [])
        regmap = {}
        for rv in regvals:
            if not isinstance(rv, dict):
                continue
            num = int(rv.get("number", "-1"))
            val = rv.get("value", "")
            name = self.reg_names[num] if 0 <= num < len(self.reg_names) else f"r{num}"
            if name:
                regmap[name] = val

        # frames
        fr = self.cmd("-stack-list-frames", wait_for="done", timeout=2.0)
        frames = fr.get("payload", {}).get("stack", [])

        # disasm around $pc
        dis = self.cmd("-data-disassemble -s $pc-64 -e $pc+64 -- 0", wait_for="done", timeout=2.0)
        asm = dis.get("payload", {}).get("asm_insns", [])

        # stack bytes
        # read 256 bytes from rsp; if rsp missing, skip
        stack_view = []
        rsp = regmap.get("rsp")
        if rsp:
            mem = self.cmd(f"-data-read-memory-bytes {rsp} 256", wait_for="done", timeout=2.0)
            mm = mem.get("payload", {}).get("memory", [])
            if mm and isinstance(mm, list) and isinstance(mm[0], dict):
                contents_hex = mm[0].get("contents", "")
                # contents_hex is hex string, two chars per byte
                raw = bytes.fromhex(contents_hex) if contents_hex else b""
                base = int(rsp, 16)
                # format as 8-byte words
                for i in range(0, min(len(raw), 256), 8):
                    chunk = raw[i:i+8]
                    qword = int.from_bytes(chunk, "little")
                    ascii_ = "".join(chr(b) if 32 <= b <= 126 else "." for b in chunk)
                    stack_view.append({
                        "addr": hex(base + i),
                        "qword": hex(qword),
                        "ascii": ascii_,
                    })

        # breakpoints
        bps = self.list_breakpoints()

        return {
            "status": "running" if self.running else "stopped",
            "stop": self.last_stop,
            "registers": regmap,
            "frames": frames,
            "disasm": asm,
            "stack": stack_view,
            "breakpoints": bps,
        }
    
    def break_insert(self, spec: str, condition: str | None = None, temporary: bool = False):
        # spec can be: main, file:line, *0x401000
        cmd = "-break-insert"
        if temporary:
            cmd += " -t"
        if condition:
            # MI uses: -break-insert -c "COND" SPEC
            cmd += f' -c "{condition}"'
        cmd += f" {spec}"
        self.cmd(cmd, wait_for="done", timeout=2.0)

    def break_enable(self, bpnum: str):
        self.cmd(f"-break-enable {bpnum}", wait_for="done", timeout=2.0)

    def break_disable(self, bpnum: str):
        self.cmd(f"-break-disable {bpnum}", wait_for="done", timeout=2.0)

    def break_clear_all(self):
        bps = self.list_breakpoints()
        for bp in bps:
            n = bp.get("number")
            if n:
                self.break_delete(n)

