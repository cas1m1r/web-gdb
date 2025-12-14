from flask import Flask, request, jsonify, send_from_directory
from pathlib import Path
import os

from gdbmi import GdbMiSession

app = Flask(__name__, static_folder="static")

SESSION = None

TARGETS_DIR = Path("./targets").resolve()

def safe_target_path(name: str) -> str:
    """
    Only allow selecting files inside ./targets by filename (no slashes).
    Returns absolute path string if valid.
    """
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("Invalid target name")

    p = (TARGETS_DIR / name).resolve()
    if not str(p).startswith(str(TARGETS_DIR)):
        raise ValueError("Target must be inside ./targets")

    if not p.exists() or not p.is_file():
        raise ValueError("Target does not exist")

    # Optional: require executable bit
    if not os.access(str(p), os.X_OK):
        raise ValueError("Target is not executable")

    return str(p)


@app.get("/")
def index():
    return send_from_directory("static", "index.html")

@app.get("/static/<path:p>")
def stat(p):
    return send_from_directory("static", p)

@app.post("/api/start")
def api_start():
    global SESSION
    data = request.get_json(force=True, silent=True) or {}

    target = data.get("target") or "demo"   # <-- filename in targets/
    args = data.get("args") or []

    if SESSION:
        try: SESSION.stop()
        except Exception: pass
        SESSION = None

    try:
        program = safe_target_path(target)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    SESSION = GdbMiSession(program=program, args=args)
    SESSION.start()

    SESSION.break_insert("main")
    SESSION.run()

    return jsonify({"ok": True})


@app.post("/api/ctrl")
def api_ctrl():
    global SESSION
    if not SESSION:
        return jsonify({"ok": False, "error": "No session. Call /api/start first."}), 400

    data = request.get_json(force=True, silent=True) or {}
    action = (data.get("action") or "").lower()

    try:
        if action == "run":
            SESSION.run()
        elif action == "continue":
            SESSION.cont()
        elif action == "stepi":
            SESSION.stepi()
        elif action == "nexti":
            SESSION.nexti()
        elif action == "step":
            SESSION.step()
        elif action == "next":
            SESSION.next()
        elif action == "finish":
            SESSION.finish()
        else:
            return jsonify({"ok": False, "error": f"Unknown action: {action}"}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True, "state": SESSION.snapshot()})

@app.get("/api/state")
def api_state():
    global SESSION
    if not SESSION:
        return jsonify({"ok": False, "error": "No session."}), 400
    return jsonify({"ok": True, "state": SESSION.snapshot()})

@app.post("/api/break/toggle")
def api_break_toggle():
    global SESSION
    if not SESSION:
        return jsonify({"ok": False, "error": "No session."}), 400

    data = request.get_json(force=True, silent=True) or {}
    addr = data.get("addr")
    if not addr:
        return jsonify({"ok": False, "error": "Missing addr"}), 400

    # normalize the clicked address
    try:
        want = int(addr, 16)
    except ValueError:
        return jsonify({"ok": False, "error": f"Bad addr: {addr}"}), 400

    bps = SESSION.list_breakpoints()
    for bp in bps:
        bp_addr = bp.get("addr")
        if not bp_addr:
            continue
        try:
            have = int(bp_addr, 16)
        except ValueError:
            continue

        if have == want:
            SESSION.break_delete(bp.get("number"))
            return jsonify({"ok": True, "state": SESSION.snapshot()})

    # insert using normalized hex (no leading zeros)
    SESSION.break_insert(f"*{hex(want)}")
    return jsonify({"ok": True, "state": SESSION.snapshot()})


@app.post("/api/break/add")
def api_break_add():
    global SESSION
    if not SESSION:
        return jsonify({"ok": False, "error": "No session."}), 400

    data = request.get_json(force=True, silent=True) or {}
    spec = (data.get("spec") or "").strip()
    cond = (data.get("condition") or "").strip()

    if not spec:
        return jsonify({"ok": False, "error": "Missing spec"}), 400

    # allow entering raw hex like "0x401000" (convert to "*0x401000")
    if spec.startswith("0x") or all(c in "0123456789abcdefABCDEF" for c in spec):
        if not spec.startswith("*"):
            if not spec.startswith("0x"):
                spec = "0x" + spec
            spec = "*" + spec

    # If you extended break_insert to accept condition, use it:
    # SESSION.break_insert(spec, condition=cond or None)
    # Otherwise: simplest MVP: ignore condition for now.
    SESSION.break_insert(spec)

    # If you want condition now, add this to gdbmi.py: break_insert(spec, condition=None)
    # and call it above.

    return jsonify({"ok": True, "state": SESSION.snapshot()})


@app.post("/api/break/clear_all")
def api_break_clear_all():
    global SESSION
    if not SESSION:
        return jsonify({"ok": False, "error": "No session."}), 400

    for bp in SESSION.list_breakpoints():
        n = bp.get("number")
        if n:
            SESSION.break_delete(str(n))

    return jsonify({"ok": True, "state": SESSION.snapshot()})


@app.post("/api/stop")
def api_stop():
    global SESSION
    if SESSION:
        SESSION.stop()
        SESSION = None
    return jsonify({"ok": True})


@app.get("/api/targets")
def api_targets():
    if not TARGETS_DIR.exists():
        return jsonify({"ok": True, "targets": []})

    items = []
    for p in TARGETS_DIR.iterdir():
        if p.is_file() and os.access(str(p), os.X_OK):
            items.append(p.name)

    items.sort()
    return jsonify({"ok": True, "targets": items})




if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
