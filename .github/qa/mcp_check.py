#!/usr/bin/env python3
"""The node's MCP surface, checked without a model (UNB-235).

Starts the shipped MCP program (`unb mcp`, which signs every message for its agent key) and speaks to it over stdio as
any MCP client does. Three parts, each a list of steps with a verdict:

1. contract: the handshake, the tool list (names, descriptions, input schemas, the list's size), an unknown tool and an
   unknown method refused as protocol errors (MCP spec 2025-11-25, server/tools, "Error Handling").
2. refusals: every tool called with input it can't take (a required field left out). The answer must be a refusal, and
   its words must name what was missing: "actionable feedback that language models can use to self-correct". The spec
   files input validation under tool execution errors (`isError: true`); a node that answers with a protocol error
   instead is a known deviation, kept in mcp-baseline.json so a new one fails and a fixed one is said.
3. journey: what a person does through an agent, in order (mcp-journey.json): learn and call a route, find it, call it
   by id, read its steps, open a page that needs hands, refuse what agents may not do, judge, report. A successful
   reply is checked against the schema the node publishes for that tool (unbrowse-node/agent-api.json `returns`).
   Every journey step leaves a picture in <out>/shots: the node's own browser where the step used a session, else the
   page the step read, in Chrome for Testing straight (no profile, nothing signed in).

Every tool the node lists must be called by a journey step with input it takes, or waived in the journey file with a
reason: a tool nothing calls is untested behaviour a person can reach (cf-release-train mcp-coverage.mjs).

    UNBROWSE_AGENT_TOKEN=... python3 .github/qa/mcp_check.py --unb target/debug/unb --node http://127.0.0.1:7788 \\
        --out <folder> [--chrome <path>] [--api unbrowse-node/agent-api.json]

Writes <out>/mcp-check.json, <out>/mcp-check.md and <out>/shots/*.png. Exits 1 when any step failed, 0 otherwise.
Standard library only, but for jsonschema when it can be imported (the output-schema check says so when it can't).
"""
import argparse
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")  # spec: 1-128 characters, letters, digits, _ - .
PNG = b"\x89PNG\r\n\x1a\n"
PNG_END = b"\0\0\0\0IEND\xaeB`\x82"
MAX_LIST_BYTES = 64_000  # a client holds the whole list in every turn's context


class Mcp:
    """One MCP session over a child's stdio, newline-delimited JSON-RPC."""

    def __init__(self, command, env):
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
        self.next_id = 0
        self.buf = b""

    def request(self, method, params=None, timeout=120):
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            line = self._line(deadline)
            if line is None:
                return {"timeout": True}
            try:
                reply = json.loads(line)
            except ValueError:
                continue
            if isinstance(reply, dict) and reply.get("id") == self.next_id:
                return reply

    def notify(self, method, params=None):
        msg = {"jsonrpc": "2.0", "method": method, **({"params": params} if params is not None else {})}
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()

    def _line(self, deadline):
        fd = self.proc.stdout.fileno()
        while b"\n" not in self.buf:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            ready, _, _ = select.select([fd], [], [], left)
            if not ready:
                return None
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                return None
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode(errors="replace")

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def reply_of(result):
    """A tools/call answer as (is_error, the node's JSON reply or its text, the whole text)."""
    content = (result or {}).get("content") or []
    text = "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    try:
        body = json.loads(text)
    except ValueError:
        body = text
    return bool((result or {}).get("isError")), body, text


def at(value, path):
    """`a.b.0.c` into nested dicts and lists; None when it isn't there."""
    for part in path.split(".") if path else []:
        if isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return None
    return value


def fill(value, saved):
    """`{{name}}` in a step's arguments, from what earlier steps saved."""
    if isinstance(value, str):
        return re.sub(r"\{\{(\w+)\}\}", lambda m: str(saved.get(m.group(1), m.group(0))), value)
    if isinstance(value, list):
        return [fill(v, saved) for v in value]
    if isinstance(value, dict):
        return {k: fill(v, saved) for k, v in value.items()}
    return value


def expect_problems(expect, is_error, body, text, protocol_error):
    """What a reply got wrong against a step's `expect`: an empty list is a pass."""
    problems = []
    want = expect.get("result", "ok")
    if want == "ok" and (is_error or protocol_error):
        problems.append(f"wanted an answer, got a refusal: {(protocol_error or text)[:300]}")
    if want == "refused" and not (is_error or protocol_error):
        problems.append(f"wanted a refusal, got an answer: {text[:300]}")
    words = (protocol_error or "") + text
    for path, allowed in (expect.get("in") or {}).items():
        got = at(body, path)
        if got not in allowed:
            problems.append(f"{path} is {json.dumps(got)[:120]}, wanted one of {allowed}")
    for path in expect.get("has") or []:
        got = at(body, path)
        if got in (None, "", [], {}):
            problems.append(f"{path} is empty or missing")
    for needle in expect.get("says") or []:
        if needle.lower() not in words.lower():
            problems.append(f"the reply doesn't say {needle!r}: {words[:300]}")
    for needle in expect.get("never_says") or []:
        if needle.lower() in words.lower():
            problems.append(f"the reply says {needle!r}, which it must not")
    return problems


class Schemas:
    """The schemas the node publishes for each tool's successful reply, `#/types/...` resolved against the document."""

    def __init__(self, api_path, drift=None):
        self.why_not = None
        self.returns = {}
        # Known drift between a tool's replies and its published schema (mcp-baseline.json `reply_schema_drift`): a
        # problem holding one of these words is said, not failed; one never seen again is reported fixed.
        self.drift = {tool: list(words) for tool, words in (drift or {}).items() if not tool.startswith("_")}
        self.seen, self.checked = set(), set()
        try:
            import jsonschema  # noqa: F401
        except ImportError:
            self.why_not = "jsonschema isn't installed, so no reply was checked against its schema"
            return
        if not api_path or not Path(api_path).exists():
            self.why_not = f"no API description at {api_path}"
            return
        self.doc = json.loads(Path(api_path).read_text())
        self.returns = {p["tool"]: p.get("returns") for p in self.doc.get("primitives", []) if p.get("returns")}

    def problems(self, tool, body):
        if self.why_not or tool not in self.returns or not isinstance(body, dict):
            return []
        import jsonschema

        schema = dict(self.returns[tool])
        schema["types"] = self.doc.get("types", {})
        validator = jsonschema.Draft202012Validator(schema)
        self.checked.add(tool)
        new = []
        for problem in (schema_problem(leaf) for e in validator.iter_errors(body) for leaf in leaves(e)):
            known = next((words for words in self.drift.get(tool, []) if words in problem), None)
            if known:
                self.seen.add((tool, known))
            else:
                new.append(problem)
        return new[:3]

    def fixed(self):
        return [f"{tool}'s replies no longer break its schema with \"{words}\": drop it from mcp-baseline.json reply_schema_drift."
                for tool, all_words in self.drift.items() if tool in self.checked
                for words in all_words if (tool, words) not in self.seen]  # fmt: skip


def closest_branch(errors):
    """The errors of the branch the reply meant: not one whose tag (an enum or const a level down, `how`) it
    fails, and of those the one with fewest errors. jsonschema's best_match picks by a general weight, and named a
    `network` branch's missing `entry` for a reply that said `how: learned`."""
    branches = {}
    for e in errors:
        branches.setdefault(e.relative_schema_path[0] if e.relative_schema_path else None, []).append(e)
    meant = [errs for errs in branches.values() if not any(e.validator in ("enum", "const") and len(e.relative_path) <= 1 for e in errs)]
    if not meant:
        return None
    return min(meant, key=len)


def leaves(error):
    """Each separate way a reply leaves its schema, one problem each, so a known one in the baseline hides no other."""
    if not error.context:
        return [error]
    from jsonschema.exceptions import best_match

    branch = closest_branch(error.context) or [best_match(error.context)]
    return [leaf for e in branch for leaf in leaves(e)]


def schema_problem(error):
    """Where a reply leaves its schema and what about it, short. jsonschema's own message opens with the whole value it
    rejects, so a large reply hid the reason past the cut (UNB-235: "reply breaks its schema at /: {'how': ...")."""
    shown = repr(error.instance)
    message = error.message.replace(shown, f"the {type(error.instance).__name__}") if len(shown) > 60 else error.message
    where = "/" + "/".join(map(str, error.absolute_path))
    return f"reply breaks its schema at {where}: {message[:240]} (schema {'/'.join(map(str, error.schema_path))})"


def is_png(path, *, complete=False):
    if not path.is_file():
        return False
    image = path.read_bytes()
    return image.startswith(PNG) and (not complete or image.endswith(PNG_END))


def draw_card(card, title, said, answer):
    """A page that shows a step's input and what came back, for a step with no page of its own."""
    esc = lambda t: str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # noqa: E731
    card.write_text(
        "<!doctype html><meta charset=utf-8><body style='font:14px ui-monospace,Menlo,monospace;margin:24px;background:#fff;color:#111'>"
        f"<h2 style='font-family:system-ui'>{esc(title)}</h2><p>{esc(said)}</p>"
        f"<pre style='white-space:pre-wrap;background:#f4f4f4;padding:12px'>{esc(str(answer)[:6000])}</pre></body>"
    )
    return card.as_uri()


CHROME_HEADLESS_FLAGS = (
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-extensions",
    "--metrics-recording-only",
    "--use-mock-keychain",
)


def _stop_process_group(proc):
    if proc.poll() is not None:
        return
    for sig, wait_s in ((signal.SIGTERM, 0.5), (signal.SIGKILL, 2.0)):
        try:
            os.killpg(proc.pid, sig)
        except OSError:
            try:
                proc.send_signal(sig)
            except OSError:
                return
        try:
            proc.wait(timeout=wait_s)
            return
        except subprocess.TimeoutExpired:
            continue


def _run_chrome_screenshot(command, screenshot, timeout=60):
    """Run headless Chrome and stop it promptly once a complete PNG lands (Chrome on macOS can hang on exit)."""
    proc = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return
            if is_png(screenshot, complete=True):
                try:
                    proc.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    _stop_process_group(proc)
                return
            time.sleep(0.1)
        _stop_process_group(proc)
        raise subprocess.TimeoutExpired(command, timeout)
    finally:
        _stop_process_group(proc)


def chrome_shot(chrome, url, target, profile):
    """A picture of `url` in Chrome for Testing, headless, on a profile of its own (nothing signed in)."""
    if not (chrome and url):
        return False
    # A Linux runner's AppArmor holds Chrome's sandbox back (ci.yml's engine job says the same): said outright there.
    unsandboxed = ["--no-sandbox"] if os.environ.get("QA_CHROME_NO_SANDBOX") == "1" else []
    # Twice: on a busy Mac a headless Chrome now and then exits with no picture of a local page (QA 44915399195,
    # do-data-url's card). A picture is not a verdict, so a second try changes no step's result but its picture.
    target.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as folder:
        for attempt in range(2):
            screenshot = Path(folder) / f"{attempt}.png"
            command = [
                chrome, *CHROME_HEADLESS_FLAGS, "--window-size=1280,900",
                *unsandboxed, f"--user-data-dir={profile}", f"--screenshot={screenshot}", url,
            ]
            try:
                _run_chrome_screenshot(command, screenshot, timeout=60)
            except (subprocess.TimeoutExpired, OSError):
                # Chrome can finish writing the screenshot before it gets stuck exiting.
                pass
            if is_png(screenshot, complete=True):
                screenshot.replace(target)
                return True
    return False


def shoot(mcp, chrome, shots, step, saved):
    """A picture for a journey step: (path or None, where it came from, why not)."""
    spec = step.get("shot") or {"reply": True}
    target = shots / f"{step['n']:02d}-{step['id']}.png"
    if spec.get("reply"):
        # A step with no page of its own is pictured as what it answered: the tool, its input and its reply.
        url = draw_card(shots / f".{step['n']:02d}.html", step["id"], f"{step['tool']} {json.dumps(step.get('sent', {}))}", step.get("answer", ""))
        session = None
    else:
        session = spec.get("session")
        url = fill(spec.get("url"), saved) if spec.get("url") else None
    why = None
    if session:
        target.unlink(missing_ok=True)
        with tempfile.TemporaryDirectory(dir=shots) as folder:
            screenshot = Path(folder) / target.name
            reply = mcp.request("tools/call", {"name": "unbrowse_browse", "arguments": {"do": ["screenshot", str(screenshot)], "session": session}}, timeout=60)
            text = reply_of(reply.get("result"))[2]
            if not is_png(screenshot):
                for found in re.findall(r"(/[^\s\"']+\.png)", text):
                    if is_png(Path(found)):
                        shutil.copyfile(found, screenshot)
                        break
            if is_png(screenshot):
                screenshot.replace(target)
                return target, "the node's browser", None
        if not url:
            got = mcp.request("tools/call", {"name": "unbrowse_browse", "arguments": {"do": ["get", "url"], "session": session}}, timeout=60)
            url = (re.findall(r"https?://[^\s\"'\\]+", reply_of(got.get("result"))[2]) or [None])[0]
        why = f"the node's browser took none ({text[:160]})"
    if chrome_shot(chrome, url, target, shots / ".profile"):
        return target, "the reply, drawn" if spec.get("reply") else "Chrome for Testing, straight", None
    if url and chrome:
        why = (why + "; " if why else "") + "Chrome took none"
    return None, None, why or "no page to picture and no browser"


def contract(mcp, steps):
    init = mcp.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "mcp_check", "version": "1"}})
    info = (init.get("result") or {})
    problems = []
    if not info.get("protocolVersion"):
        problems.append(f"no protocolVersion: {json.dumps(init)[:300]}")
    if (info.get("capabilities") or {}).get("tools") is None:
        problems.append("capabilities name no tools")
    if not (info.get("serverInfo") or {}).get("name"):
        problems.append("no serverInfo.name")
    steps.append({"part": "contract", "id": "initialize", "pass": not problems, "problems": problems, "note": f"{(info.get('serverInfo') or {}).get('name')} {(info.get('serverInfo') or {}).get('version')}, protocol {info.get('protocolVersion')}"})
    mcp.notify("notifications/initialized")

    listed = mcp.request("tools/list")
    tools = (listed.get("result") or {}).get("tools") or []
    raw = len(json.dumps(listed.get("result") or {}))
    problems = []
    if not tools:
        problems.append(f"no tools listed: {json.dumps(listed)[:300]}")
    if raw > MAX_LIST_BYTES:
        problems.append(f"the list is {raw} bytes, over {MAX_LIST_BYTES}: a client carries it in every turn")
    names = [t.get("name", "") for t in tools]
    for dup in sorted({n for n in names if names.count(n) > 1}):
        problems.append(f"{dup} is listed twice")
    for tool in tools:
        name = tool.get("name", "")
        if not NAME.match(name):
            problems.append(f"{name!r}: a name is 1-128 of letters, digits, _ - .")
        if len((tool.get("description") or "").strip()) < 20:
            problems.append(f"{name}: no description an agent can choose by")
        schema = tool.get("inputSchema")
        if not isinstance(schema, dict) or schema.get("type") != "object":
            problems.append(f"{name}: inputSchema isn't a JSON Schema object")
            continue
        props = schema.get("properties", {})
        if not isinstance(props, dict):
            problems.append(f"{name}: properties isn't an object")
            continue
        for req in schema.get("required") or []:
            if req not in props:
                problems.append(f"{name}: requires {req}, which it doesn't describe")
        for prop, spec in props.items():
            if not isinstance(spec, dict) or not any(k in spec for k in ("type", "enum", "anyOf", "oneOf", "$ref", "const")):
                problems.append(f"{name}.{prop}: no type")
    steps.append({"part": "contract", "id": "tools/list", "pass": not problems, "problems": problems, "note": f"{len(tools)} tools, {raw} bytes"})

    unknown = mcp.request("tools/call", {"name": "qa_no_such_tool", "arguments": {}})
    err = unknown.get("error") or {}
    ok = bool(err) and err.get("code") in (-32602, -32601) and "qa_no_such_tool" in (err.get("message") or "")
    steps.append({"part": "contract", "id": "unknown tool", "pass": ok, "problems": [] if ok else [f"wanted a protocol error naming the tool, got {json.dumps(unknown)[:300]}"], "note": err.get("message", "")})

    method = mcp.request("qa/no_such_method")
    err = method.get("error") or {}
    ok = err.get("code") == -32601
    steps.append({"part": "contract", "id": "unknown method", "pass": ok, "problems": [] if ok else [f"wanted -32601, got {json.dumps(method)[:300]}"], "note": err.get("message", "")})
    return tools


def refusals(mcp, tools, steps, baseline):
    deviations = []
    for tool in tools:
        name = tool.get("name", "")
        required = (tool.get("inputSchema") or {}).get("required") or []
        if not required:
            steps.append({"part": "refusals", "id": name, "pass": True, "problems": [], "note": "takes no required input, so no input is missing"})
            continue
        reply = mcp.request("tools/call", {"name": name, "arguments": {}}, timeout=60)
        is_error, body, text = reply_of(reply.get("result"))
        protocol = (reply.get("error") or {}).get("message")
        problems = []
        if reply.get("timeout"):
            problems.append("no answer within 60 s")
        elif not (is_error or protocol):
            problems.append(f"answered without {required}: {text[:200]}")
        elif not any(r in (protocol or text) for r in required):
            problems.append(f"the refusal names none of {required}: {(protocol or text)[:200]}")
        how = "protocol error" if protocol else "isError"
        if protocol:
            deviations.append(name)
        known = name in baseline.get("input_errors_as_protocol_errors", [])
        note = f"{how}: {(protocol or text)[:160]}"
        if protocol and not known:
            problems.append("a missing input is a protocol error, not a tool execution error the model can read (spec, Error Handling); not in mcp-baseline.json")
        elif protocol:
            note += " (known deviation, mcp-baseline.json)"
        steps.append({"part": "refusals", "id": name, "pass": not problems, "problems": problems, "note": note})
    fixed = sorted(set(baseline.get("input_errors_as_protocol_errors", [])) - set(deviations))
    return fixed


def journey(mcp, plan, tools, steps, chrome, shots, schemas):
    saved = {}
    called_ok = set()
    for n, step in enumerate(plan["steps"], 1):
        step = {**step, "n": n}
        method = step.get("method")
        if method:
            # A request that isn't a tool call (resources/list, resources/read): its result is the reply, as JSON.
            step["tool"] = method
            args = fill(step.get("params") or {}, saved)
            started = time.monotonic()
            reply = mcp.request(method, args, timeout=step.get("timeout", 60))
            result = reply.get("result")
            is_error, body, text = False, result, json.dumps(result) if result is not None else ""
        else:
            args = fill(step.get("args") or {}, saved)
            started = time.monotonic()
            reply = mcp.request("tools/call", {"name": step["tool"], "arguments": args}, timeout=step.get("timeout", 180))
            is_error, body, text = reply_of(reply.get("result"))
        ms = int((time.monotonic() - started) * 1000)
        protocol = (reply.get("error") or {}).get("message")
        expect = fill(step.get("expect") or {}, saved)
        problems = ["no answer in time"] if reply.get("timeout") else expect_problems(expect, is_error, body, text, protocol)
        if not method and not is_error and not protocol and not reply.get("timeout"):
            problems += schemas.problems(step["tool"], body)
        # A tool counts as exercised when a step meant to be taken (ok, or either way) got an answer in time.
        if not reply.get("timeout") and expect.get("result", "ok") in ("ok", "any"):
            called_ok.add(step["tool"])
        step["sent"], step["answer"] = args, json.dumps(body, indent=1) if isinstance(body, (dict, list)) else (protocol or text)
        for key, path in (step.get("save") or {}).items():
            value = at(body, path)
            if value is not None:
                saved[key] = value
        shot, source, why = shoot(mcp, chrome, shots, step, saved)
        if step.get("shot") and not shot:
            problems.append(f"no screenshot: {why}")
        steps.append({
            "part": "journey", "id": step["id"], "tool": step["tool"], "pass": not problems, "problems": problems, "ms": ms,
            "note": step.get("what", ""), "reply": text if problems else text[:600], "shot": shot.name if shot else None, "shot_source": source,
        })  # fmt: skip
    listed = {t.get("name") for t in tools}
    waived = plan.get("waived") or {}
    for name in sorted(listed - called_ok):
        why = waived.get(name, "")
        ok = len(why) >= 15
        steps.append({"part": "coverage", "id": name, "pass": ok, "problems": [] if ok else ["no journey step calls it with input it takes, and no waiver says why"], "note": f"waived: {why}" if ok else ""})
    for name in sorted(set(waived) - listed):
        steps.append({"part": "coverage", "id": name, "pass": False, "problems": ["waived, but the node lists no such tool: drop the waiver"], "note": ""})


def report(result):
    parts = {}
    for s in result["steps"]:
        parts.setdefault(s["part"], []).append(s)
    passed = sum(s["pass"] for s in result["steps"])
    out = [f"**MCP check: {'pass' if result['pass'] else 'fail'}.** {passed} of {len(result['steps'])} steps passed, no model in the loop."]
    if result.get("schemas"):
        out.append(f"\n_Output schemas: {result['schemas']}_")
    for fixed in result.get("fixed") or []:
        out.append(f"\n_Fixed: {fixed}_")
    for part, rows in parts.items():
        out += ["", f"#### {part}", "", "| Step | Result | Note |", "| --- | --- | --- |"]
        for s in rows:
            cell = "pass" if s["pass"] else "**fail**: " + "; ".join(s["problems"])
            note = (s.get("note") or "") + (f" ({s['ms']} ms; picture: {s['shot']}, {s['shot_source']})" if s.get("shot") else (f" ({s['ms']} ms)" if "ms" in s else ""))
            out.append(f"| {s['id']} | {cell.replace('|', '/')} | {note.replace('|', '/')[:300]} |")
    return "\n".join(out) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--unb", required=True)
    parser.add_argument("--node", default=os.environ.get("UNBROWSE_NODE") or "http://127.0.0.1:7788")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--chrome", default="")
    parser.add_argument("--api", default=str(HERE.parents[1] / "unbrowse-node/agent-api.json"))
    parser.add_argument("--journey", type=Path, default=HERE / "mcp-journey.json")
    parser.add_argument("--baseline", type=Path, default=HERE / "mcp-baseline.json")
    parser.add_argument("--parts", default="contract,refusals,journey")
    args = parser.parse_args(argv)
    token = os.environ.get("UNBROWSE_AGENT_TOKEN")
    if not token:
        print("UNBROWSE_AGENT_TOKEN is not set: unb mcp signs with it", file=sys.stderr)
        return 2
    shots = args.out / "shots"
    shots.mkdir(parents=True, exist_ok=True)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", str(args.out)), "UNBROWSE_NODE": args.node, "UNBROWSE_AGENT_TOKEN": token}
    mcp = Mcp([args.unb, "mcp"], env)
    steps, fixed = [], []
    baseline = json.loads(args.baseline.read_text())
    schemas = Schemas(args.api, baseline.get("reply_schema_drift"))
    parts = set(args.parts.split(","))
    try:
        tools = contract(mcp, steps)
        if "refusals" in parts:
            fixed = [f"{name} now refuses missing input as a tool error: drop it from mcp-baseline.json."
                     for name in refusals(mcp, tools, steps, baseline)]  # fmt: skip
        if "journey" in parts:
            journey(mcp, json.loads(args.journey.read_text()), tools, steps, args.chrome or None, shots, schemas)
    finally:
        mcp.close()
        shutil.rmtree(shots / ".profile", ignore_errors=True)
        for card in shots.glob(".*.html"):
            card.unlink()
    (args.out / "tools.json").write_text(json.dumps(tools, indent=2) + "\n")
    fixed += schemas.fixed()
    result = {"pass": all(s["pass"] for s in steps), "steps": steps, "fixed": fixed, "schemas": schemas.why_not or "every successful reply checked against agent-api.json"}
    (args.out / "mcp-check.json").write_text(json.dumps(result, indent=2) + "\n")
    (args.out / "mcp-check.md").write_text(report(result))
    print(report(result))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
