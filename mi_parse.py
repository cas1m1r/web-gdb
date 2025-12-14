import re

def _split_top(s: str, sep: str = ","):
    out = []
    buf = []
    depth = 0
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            buf.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue

        if ch == '"':
            in_str = True
            buf.append(ch)
            continue

        if ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1

        if ch == sep and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)

    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out

def _unquote(s: str):
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        # MI uses C-like escapes
        return bytes(s[1:-1], "utf-8").decode("unicode_escape")
    return s

def parse_value(v: str):
    v = v.strip()
    if not v:
        return ""

    if v[0] == '"':
        return _unquote(v)

    if v[0] == "{":
        inner = v[1:-1].strip()
        d = {}
        if inner:
            for part in _split_top(inner, ","):
                if "=" in part:
                    k, vv = part.split("=", 1)
                    d[k.strip()] = parse_value(vv)
        return d

    if v[0] == "[":
        inner = v[1:-1].strip()
        if not inner:
            return []
        # list can contain values or k=v style
        items = []
        for part in _split_top(inner, ","):
            part = part.strip()
            if "=" in part and not part.startswith("{"):
                k, vv = part.split("=", 1)
                items.append({k.strip(): parse_value(vv)})
            else:
                items.append(parse_value(part))
        return items

    # barewords/numbers
    return v

_MI_RESULT_RE = re.compile(r'^(?P<prefix>[\^*=~&@])(?P<body>.*)$')

def parse_mi_line(line: str):
    """
    Returns dict like:
      {"kind":"result","cls":"done","payload":{...}}
      {"kind":"async","cls":"stopped","payload":{...}}
      {"kind":"stream","stream":"console","text":"..."}
    or None if unrecognized.
    """
    line = line.strip()
    if not line:
        return None

    m = _MI_RESULT_RE.match(line)
    if not m:
        return None

    prefix = m.group("prefix")
    body = m.group("body")

    # stream records: ~"text", &"log", @"target output"
    if prefix in ("~", "&", "@"):
        return {
            "kind": "stream",
            "stream": {"~": "console", "&": "log", "@": "target"}[prefix],
            "text": _unquote(body) if body.startswith('"') else body,
        }

    # async: *stopped,... or =thread-created,...
    # result: ^done,... or ^running,...
    # notify: =breakpoint-created,...
    if "," in body:
        cls, rest = body.split(",", 1)
    else:
        cls, rest = body, ""

    payload = {}
    rest = rest.strip()
    if rest:
        for part in _split_top(rest, ","):
            if "=" in part:
                k, v = part.split("=", 1)
                payload[k.strip()] = parse_value(v)

    if prefix == "^":
        return {"kind": "result", "cls": cls.strip(), "payload": payload}
    if prefix == "*":
        return {"kind": "async", "cls": cls.strip(), "payload": payload}
    if prefix == "=":
        return {"kind": "notify", "cls": cls.strip(), "payload": payload}

    return None
