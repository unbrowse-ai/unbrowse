#!/usr/bin/env python3
"""The terminal and the window for Claude QA, as an MCP server on stdio (UNB-235).

Claude QA has no shell: it reads pages anyone can write, and a shell would hand it the runner. To walk the journeys a
person walks in a terminal and in the window, it gets two tools here instead, each one call at a time:

  terminal  runs one of the product's own commands (unb, unbrowse-node, or the npm package's unbrowse) with the words
            given, no shell, and only the commands on the list below: what an owner or an agent types, never a
            command that prints a key or reads a file outside the fixtures. It answers with what the command printed
            and its exit code, and pictures the terminal.
  window    opens the node's window on this node and keeps it open, clicks a text in it, presses a key, types, and
            pictures it (now, or a few seconds later while another tool waits).

Every call leaves a picture in <QA_SHOTS>/steps/ and a line in <QA_SHOTS>/steps/steps.jsonl, so the report has a
picture per step without the agent spending a turn on it. Commands run with a bare environment: the node's address,
its home, the agent's token and the path; nothing else this process holds (the model's credential is in it) reaches
them. Anything shaped like a key is scrubbed from what comes back.

Environment (set in the MCP config the workflow writes): QA_PROGRAMS (folder with unbrowse-node and unb), QA_NPM_CLI
(the packed npm package's dist/cli.js), QA_WINDOW (the window program), QA_SHOTS, QA_WORK (a folder the agent may
write to), QA_FIXTURES, QA_CHROME, UNBROWSE_HOME, UNBROWSE_NODE, UNBROWSE_AGENT_TOKEN.

The window never comes in front of anyone and nothing reads the screen: it runs hidden, and each picture is drawn by the
window itself (nanoui's --nanoui-snapshot: the window program runs on this node, does the steps so far as a person does
them, and draws its window to a PNG). So on a person's own Mac QA needs no screen-recording or accessibility
permission, never pictures their screen and never presses a key in their apps.
Standard library only; run with python3 -I.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ENV = os.environ
SHOTS = Path(ENV.get("QA_SHOTS", "qa-shots")) / "steps"
WORK = Path(ENV.get("QA_WORK", "qa-work"))
FIXTURES = Path(ENV.get("QA_FIXTURES", Path(__file__).resolve().parent / "fixtures"))
PNG = b"\x89PNG\r\n\x1a\n"
PNG_END = b"\0\0\0\0IEND\xaeB`\x82"
LOCK = threading.Lock()
STATE = {"seq": 0, "window": None, "script": []}

# What QA's terminal runs: program -> {command: rule}. A rule is a function of the words after the command that says
# what is wrong with them, or None. Anything not here is refused, naming what is.
NONE = lambda rest: None if not rest else "takes no more words here"  # noqa: E731
ANY = lambda rest: None  # noqa: E731


def _under(base):
    def rule(path):
        try:
            real = Path(path).resolve()
        except (OSError, RuntimeError):
            return f"{path} isn't a path"
        return None if real == base.resolve() or base.resolve() in real.parents else f"{path} is outside {base}"
    return rule


def _vault(rest):
    if rest[:1] == ["list"] and len(rest) == 1:
        return None
    if rest[:1] == ["add"] and len(rest) == 4 and rest[3] == "--stored":
        return None
    if rest[:1] == ["remove"] and len(rest) == 3:
        return None
    return "vault takes list, add <site> <account> --stored (the password on stdin) or remove <site> <account> here"


def _session(rest):
    if rest == ["list"]:
        return None
    if rest[:1] == ["forget"] and len(rest) == 2:
        return None
    if rest[:1] == ["import"] and len(rest) == 4 and rest[2] == "--from":
        return _under(FIXTURES)(rest[3])
    return "session takes list, import <host> --from <a file in .github/qa/fixtures> or forget <host> here"


def _agent(rest):
    if rest[:1] == ["new"] and 2 <= len(rest) <= 4 and not rest[1].startswith("-"):
        return None
    return "agent takes new <name> [daily limit] [days] here (agent token prints a key, so QA's terminal doesn't run it)"


def _skill(rest):
    return "skill takes one folder, under the QA work folder" if len(rest) != 1 else _under(WORK)(rest[0])


def _dry(rest):
    return None if "--dry-run" in rest and all(w in ("--dry-run",) or w.isdigit() for w in rest) else "connect runs only with --dry-run here"


ALLOWED = {
    "unb": {**{c: ANY for c in ("whoami", "logins", "search", "inspect", "do", "call", "judge", "report", "walk", "open", "observe")}, "connect": _dry},
    "unbrowse-node": {
        "help": NONE, "--help": NONE, "-h": NONE, "vault": _vault, "session": _session, "agent": _agent,
        "browser": lambda r: None if r in ([], ["status"], ["status", "--json"], ["--json"]) else "browser takes status [--json] here",
        "network": NONE, "telemetry": NONE, "reports": NONE,
        "terms": lambda r: None if r in ([], ["show"]) else "terms takes show here",
        "share": lambda r: None if r in ([], ["status"]) else "share takes status here",
        "update": lambda r: None if r in ([], ["channel"]) else "update takes channel here",
    },
    "unbrowse": {"where": NONE, "help": NONE, "--help": NONE, "-h": NONE, "skill": _skill, "connect": _dry, "whoami": NONE,
                 "vault": lambda r: None if r == ["list"] else "vault takes list here", "session": lambda r: None if r == ["list"] else "session takes list here"},
}  # fmt: skip


def secrets():
    """Values that must never leave in a reply: the agent's token and the owner's."""
    found = [ENV.get("UNBROWSE_AGENT_TOKEN", "")]
    home = ENV.get("UNBROWSE_HOME")
    for name in ("owner.token", "token"):
        try:
            found.append((Path(home) / name).read_text().strip() if home else "")
        except OSError:
            pass
    return [s for s in found if len(s) >= 8]


def scrub(text):
    for s in secrets():
        text = text.replace(s, "[redacted]")
    text = re.sub(r"\bunb_[A-Za-z0-9_.-]+", "[redacted]", text)
    text = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})", "[redacted]", text)
    return re.sub(r"\bsk-ant-[A-Za-z0-9_-]+", "[redacted]", text)


def refused(program, args):
    if program not in ALLOWED:
        return f"QA's terminal runs unb, unbrowse-node and unbrowse, not {program!r}"
    if not isinstance(args, list) or not all(isinstance(a, str) and "\0" not in a and len(a) < 4000 for a in args) or len(args) > 40:
        return "args is a list of words (strings)"
    if not args:
        return f"say which {program} command"
    rule = ALLOWED[program].get(args[0])
    if rule is None:
        return f"QA's terminal doesn't run `{program} {args[0]}`; it runs: {', '.join(sorted(ALLOWED[program]))}"
    return rule(args[1:])


def command_of(program, args):
    if program == "unbrowse":
        cli = ENV.get("QA_NPM_CLI")
        if not cli:
            return None, "the npm package isn't packed on this runner (QA_NPM_CLI is unset)"
        return [shutil.which("node") or "node", cli, *args], None
    path = Path(ENV.get("QA_PROGRAMS", ".")) / program
    if not path.is_file():
        return None, f"{path} isn't built"
    return [str(path), *args], None


def child_env():
    home = WORK / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = {"PATH": ENV.get("PATH", "/usr/bin:/bin"), "HOME": str(home), "LANG": "C.UTF-8"}
    # UNBROWSE_BROWSER: a build unpacked on another runner finds its browser only by name, so `unbrowse-node browser
    # status` said "missing" while the node browsed all run (Claude QA check 23, run 44928507299).
    for name in ("UNBROWSE_HOME", "UNBROWSE_NODE", "UNBROWSE_AGENT_TOKEN", "UNBROWSE_BROWSER"):
        if ENV.get(name):
            env[name] = ENV[name]
    if ENV.get("QA_PROGRAMS"):
        env["UNBROWSE_BIN"] = ENV["QA_PROGRAMS"]
    return env


def step_file(label):
    with LOCK:
        STATE["seq"] += 1
        n = STATE["seq"]
    SHOTS.mkdir(parents=True, exist_ok=True)
    return n, SHOTS / f"{n:03d}-{re.sub(r'[^A-Za-z0-9]+', '-', label).strip('-')[:60]}.png"


def log_step(entry):
    with LOCK, open(SHOTS / "steps.jsonl", "a") as f:
        f.write(json.dumps(entry) + "\n")


def is_png(path, *, complete=False):
    try:
        if not path.is_file() or path.is_symlink():
            return False
        data = path.read_bytes()
        return data.startswith(PNG) and (not complete or data.endswith(PNG_END))
    except OSError:
        return False


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


def draw_terminal(target, title, text):
    """The terminal as a picture: the command and what it printed, drawn by Chrome for Testing, headless."""
    chrome = ENV.get("QA_CHROME")
    if not chrome:
        return False
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # noqa: E731
    page = target.with_suffix(".html")
    page.write_text(
        "<!doctype html><meta charset=utf-8><body style='margin:0;background:#1e1e1e;color:#e6e6e6;font:14px ui-monospace,Menlo,monospace'>"
        f"<div style='background:#333;color:#bbb;padding:6px 12px;font-family:system-ui'>{esc(title)}</div>"
        f"<pre style='white-space:pre-wrap;padding:12px;margin:0'>{esc(text[:12000])}</pre></body>"
    )
    unsandboxed = ["--no-sandbox"] if ENV.get("QA_CHROME_NO_SANDBOX") == "1" else []
    target.unlink(missing_ok=True)
    try:
        with tempfile.TemporaryDirectory(dir=target.parent) as folder:
            screenshot = Path(folder) / "shot.png"
            command = [
                chrome, *CHROME_HEADLESS_FLAGS, "--window-size=1100,800",
                *unsandboxed, f"--user-data-dir={SHOTS / '.profile'}", f"--screenshot={screenshot}", page.as_uri(),
            ]
            proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            deadline = time.monotonic() + 30
            try:
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        break
                    if is_png(screenshot, complete=True):
                        try:
                            proc.wait(timeout=0.5)
                        except subprocess.TimeoutExpired:
                            _stop_process_group(proc)
                        break
                    time.sleep(0.1)
            finally:
                _stop_process_group(proc)
            if is_png(screenshot):
                screenshot.replace(target)
    except OSError:
        pass
    finally:
        page.unlink(missing_ok=True)
    return is_png(target)


def terminal(args):
    program, words, stdin = args.get("program"), args.get("args") or [], args.get("stdin")
    why = refused(program, words)
    if not why and stdin is not None and not (program == "unbrowse-node" and words[:1] == ["vault"] and words[1:2] == ["add"]):
        why = "stdin is only for vault add --stored (the password)"
    if why:
        return True, f"refused: {why}"
    cmd, why = command_of(program, words)
    if why:
        return True, why
    started = time.monotonic()
    try:
        done = subprocess.run(cmd, input=(stdin if stdin is None or stdin.endswith("\n") else stdin + "\n"), capture_output=True,
                              text=True, env=child_env(), cwd=str(WORK), timeout=int(args.get("timeout") or 330))  # fmt: skip
        out, err, code = done.stdout, done.stderr, done.returncode
    except subprocess.TimeoutExpired as e:
        out, err, code = (e.stdout or ""), (e.stderr or "") + "\n(no answer in time: stopped)", "timeout"
        out, err = (out.decode() if isinstance(out, bytes) else out), (err.decode() if isinstance(err, bytes) else err)
    ms = int((time.monotonic() - started) * 1000)
    shown = scrub(f"$ {program} {' '.join(words)}" + (" < (typed in)" if stdin is not None else "") + f"\n{out}" + (f"\n{err}" if err else "") + f"\n[exit {code}, {ms} ms]")
    if stdin:
        shown = shown.replace(stdin.strip(), "[typed in]") if len(stdin.strip()) >= 4 else shown
    n, target = step_file(f"{program}-{'-'.join(words[:2])}")
    pictured = draw_terminal(target, f"step {n}: {program} {' '.join(words[:3])}", shown)
    log_step({"n": n, "tool": "terminal", "program": program, "command": scrub(" ".join(words))[:300], "exit": code, "ms": ms, "picture": target.name if pictured else None})
    reply = shown + (f"\npicture: {target}" if pictured else "\npicture: none (no Chrome to draw the terminal)")
    return False, reply


def owner_home():
    """The owner's home for the window: its .unbrowse is this node's, so the window reads this node's address."""
    owner = WORK / "owner"
    owner.mkdir(parents=True, exist_ok=True)
    link = owner / ".unbrowse"
    if not link.exists() and not link.is_symlink() and ENV.get("UNBROWSE_HOME"):
        link.symlink_to(ENV["UNBROWSE_HOME"])
    return owner


def window_program():
    program = ENV.get("QA_WINDOW")
    return program if program and Path(program).is_file() else None


# A step of the window's own test script (nanoui's --nanoui-script): what a person does in it, one at a time.
KEYS = {"escape", "enter", "tab", "up", "down", "left", "right", "home", "end", "page_up", "page_down", "backspace"}
MAX_STEPS = 40


def step_of(args):
    """The script step for one `click`, `key` or `type`, or why it can't be one."""
    action = args.get("action")
    if action == "key":
        keys = str(args.get("keys") or "").strip().lower()
        return (f"key:{keys}", None) if keys in KEYS else (None, f"refused: {keys!r} isn't a key here ({', '.join(sorted(KEYS))})")
    text = str(args.get("text") or "")
    if not text or len(text) > 200 or ";" in text or "\n" in text:
        return None, f"refused: {action} takes text, one line under 200 characters, without ';'"
    return f"{action}:{text}", None


# The window's sidebar (unbrowse-node/window/src/app.zig screen_labels): a click on one only changes which screen shows.
SCREENS = {"Node", "Live", "Browser", "My routes", "Money", "Vault", "Agents", "Activity", "Leaderboard", "Settings"}


def replay(script):
    """The steps so far, to do again from where the window opens: a sidebar click whose screen the next step leaves for
    another sidebar screen is dropped with its wait, so walking every screen doesn't make each later picture wait for
    the whole walk (check 27's ask was over before its picture was drawn, QA 44912147606)."""
    steps, out = list(script), []
    for i, step in enumerate(steps):
        if step.startswith("live:") and out and out[-1] is None:
            continue
        if step.startswith("click:") and step[6:] in SCREENS:
            rest = [s for s in steps[i + 1:] if not s.startswith("live:")]
            if rest and rest[0].startswith("click:") and rest[0][6:] in SCREENS:
                out.append(None)
                continue
        out.append(step)
    return [s for s in out if s is not None]


def render(target, script, wait):
    """The window as its owner sees it, drawn by the window itself: the program runs hidden on this node for `wait`
    seconds, does the script's steps as a person does them (a click on a text clicks its middle), and draws its window
    to a PNG (nanoui's --nanoui-snapshot, by Metal on a Mac). No screen, no screen-recording or accessibility
    permission, nothing in front of the person whose Mac it is. Returns why it failed, or None."""
    program = window_program()
    if not program:
        return f"the window isn't built on this runner ({ENV.get('QA_WINDOW')})"
    # The window asks the node for a screen's words when it first draws it: a few seconds of its event loop first, so
    # what a person would see after a moment (the terms, the node's numbers) is there before the first step.
    cmd = [program, f"--nanoui-snapshot={target}", f"--nanoui-wait={wait:g}", "--nanoui-script=" + ";".join(["live:3", *script])]
    try:
        done = subprocess.run(cmd, env={**child_env(), "HOME": str(owner_home())}, capture_output=True, text=True,
                              stdin=subprocess.DEVNULL, timeout=wait + 120, check=False)  # fmt: skip
    except subprocess.TimeoutExpired:
        return "the window didn't draw in time"
    except OSError as e:
        return f"the window didn't start: {e}"
    if is_png(target) and target.stat().st_size > 10000:
        return None
    said = [line for line in (done.stderr or "").splitlines() if "error" in line.lower()][:3] or (done.stderr or "").strip().splitlines()[-3:]
    return f"the window drew nothing (exit {done.returncode}): {' | '.join(said)[:400]}"


def window_alive():
    proc = STATE["window"]
    return proc is not None and proc.poll() is None


def wait_for_owner_ask():
    """Use the bundled signer in a child with only the scratch node's address and home."""
    helper = Path(__file__).resolve().with_name("owner_watch.py")
    settings = {key: ENV[key] for key in ("UNBROWSE_HOME", "UNBROWSE_NODE") if key in ENV}
    try:
        done = subprocess.run([sys.executable, "-I", str(helper)], env=settings, text=True, check=False,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=126)
    except subprocess.TimeoutExpired:
        return "no owner ask became pending within 120 seconds"
    except OSError:
        return "the scratch owner watcher could not start"
    return None if done.returncode == 0 else done.stdout.strip() or "the scratch owner watcher failed"


def window(args):
    action = args.get("action")
    label = re.sub(r"[^A-Za-z0-9-]+", "-", str(args.get("name") or action or "window"))[:40]
    wait = min(float(args.get("wait_s") or 4), 60)
    if action == "open":
        if window_alive():
            return True, "the window is already open"
        program = window_program()
        if not program:
            return True, f"the window isn't built on this runner ({ENV.get('QA_WINDOW')})"
        # The window open on this node, as the owner keeps it open: watching the node's events, so an agent's ask
        # reaches it. Hidden: on a person's own Mac nothing comes in front of them. Pictures are drawn apart (render).
        log = open(SHOTS.parent / "window.log", "ab")
        STATE["window"] = subprocess.Popen([program, "--nanoui-hidden"], env={**child_env(), "HOME": str(owner_home())},
                                           stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)  # fmt: skip
        STATE["script"] = []
        time.sleep(min(float(args.get("wait_s") or 8), 60))
        if not window_alive():
            return True, f"the window exited (code {STATE['window'].returncode}); see window.log"
        return shot(label, "window open", wait)
    if action == "close":
        STATE["script"] = []
        if not window_alive():
            return False, "no window was open"
        os.killpg(STATE["window"].pid, signal.SIGTERM)
        STATE["window"].wait(timeout=20)
        return False, "the window is closed"
    if action in ("click", "key", "type"):
        if not window_alive():
            return True, "no window is open: open it first"
        step, why = step_of(args)
        if why:
            return True, why
        script = STATE.setdefault("script", [])
        if len(script) >= MAX_STEPS:
            return True, f"refused: {MAX_STEPS} steps in one window; close it and open it again"
        n, target = step_file(f"window-{label}")
        why = render(target, replay([*script, step, "live:2"]), wait)
        fresh = False
        if why and script:
            # Each picture is a new run of the window from where it opens, the steps so far done again. A step that
            # changed the node (Open my node on the terms) is gone from where it opens now: the new step alone, then.
            fresh = render(target, [step, "live:2"], wait) is None
        failed = why is not None and not fresh
        pictured = not failed
        if failed and action == "click" and "TextNotFound" in why:
            pictured = picture_now(target, list(script), wait) is None
        log_step({"n": n, "tool": "window", "action": f"{action} {step.split(':', 1)[1]}", "name": label, "alive": window_alive(),
                  "picture": target.name if pictured else None, "why": why if failed else None})
        if failed:
            return True, f"{action} didn't happen: {why}" + (f"; current picture: {target}" if pictured else "")
        if fresh:
            script.clear()
        script.extend([step, "live:2"])
        return False, f"done: {step}" + (" (from the window as it opens now: the earlier steps changed the node)" if fresh else "") + f"; picture: {target}"
    if action == "shot":
        if args.get("when_owner_asks"):
            if not window_alive():
                return True, "no window is open: open it first"
            n, target = step_file(f"window-{label}")

            def while_asked():
                why = wait_for_owner_ask()
                if why is None:
                    why = render(target, [], wait)
                log_step({"n": n, "tool": "window", "action": "shot while owner asked", "name": label,
                          "alive": window_alive(), "picture": None if why else target.name, "why": why})

            threading.Thread(target=while_asked, daemon=True).start()
            return False, f"the window will be pictured when an owner ask is pending, at {target}"
        after = min(float(args.get("after_s") or 0), 120)
        if after > 0:
            # Drawn `after` seconds from now by a window that opens now and watches the node all along, so what reaches
            # it meanwhile (an agent's ask: a note naming the agent and the site, a count by Browser) is in the picture.
            # The steps so far are not done again: done again they took longer than the ask lasted, and when one no
            # longer applied the window started over later still (check 27, PR #792's run 44921378042).
            n, target = step_file(f"window-{label}")
            def later():
                why = render(target, [f"live:{max(after - 3, 1):g}"], 0)
                log_step({"n": n, "tool": "window", "action": "shot", "name": label, "alive": window_alive(), "picture": None if why else target.name, "why": why})
            threading.Thread(target=later, daemon=True).start()
            return False, f"the window will be pictured in {after:g} s, at {target}: carry on, then read that path's name in your note"
        return shot(label, "now", wait)
    return True, "action is open, click, key, type, shot or close"


def picture_now(target, script, wait):
    """The window as it is now: the steps so far done again, or, when they no longer apply (a step changed the node),
    the window as it opens now, and the steps so far are dropped."""
    why = render(target, replay(script), wait)
    tail = [s for s in script[-1:] if s.startswith("live:")]
    if why and script and render(target, tail, wait) is None:
        STATE["script"] = []
        return None
    return why


def shot(label, what, wait):
    n, target = step_file(f"window-{label}")
    why = picture_now(target, list(STATE.get("script") or []), wait)
    log_step({"n": n, "tool": "window", "action": what, "name": label, "alive": window_alive(), "picture": None if why else target.name})
    if why:
        return True, f"the window couldn't be pictured ({what}): {why}; the window is {'open' if window_alive() else 'not open'}"
    return False, f"the window is {'open' if window_alive() else 'not open'}; picture ({what}): {target}"


TOOLS = [
    {"name": "terminal", "description": "Run one of Unbrowse's own commands in a terminal, as its owner or an agent types it: program unb, unbrowse-node or unbrowse (the npm package), and the words after it. No shell: one command, its words as given. Answers with what it printed, its exit code and a picture of the terminal. stdin only for `unbrowse-node vault add <site> <account> --stored`, the password.",
     "inputSchema": {"type": "object", "properties": {"program": {"type": "string", "enum": ["unb", "unbrowse-node", "unbrowse"]}, "args": {"type": "array", "items": {"type": "string"}}, "stdin": {"type": "string"}, "timeout": {"type": "integer"}}, "required": ["program", "args"]}},
    {"name": "window", "description": "The node's window, as its owner sees it. action open: start it on this node (it stays open, watching the node, so an agent's ask reaches it) and picture it. click: click the text given in `text` (a screen's name in the sidebar, a button's label: the exact words drawn) and picture what follows. key: press a key (escape, enter, tab, up, down, left, right, home, end, page_up, page_down, backspace) and picture it. type: type `text` into what has the keys. shot: picture it now, or with after_s a few seconds later while you call another tool, or with when_owner_asks to picture a pending owner request (the path comes back at once). close: quit it. Every picture is drawn by the window itself.",
     "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["open", "click", "key", "type", "shot", "close"]}, "text": {"type": "string"}, "keys": {"type": "string"}, "after_s": {"type": "number"}, "when_owner_asks": {"type": "boolean"}, "name": {"type": "string"}, "wait_s": {"type": "number"}}, "required": ["action"]}},
]  # fmt: skip


def handle(msg):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": (msg.get("params") or {}).get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "qa", "version": "1"}}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params") or {}
        name, arguments = params.get("name"), params.get("arguments") or {}
        try:
            is_error, text = {"terminal": terminal, "window": window}[name](arguments)
        except KeyError:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"no tool {name}"}}
        except Exception as e:  # noqa: BLE001: the agent reads what broke instead of the server dying
            is_error, text = True, f"the QA tool broke: {type(e).__name__}: {e}"
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": scrub(text)}], "isError": is_error}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"no method {method}"}}


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        reply = handle(msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()
    if window_alive():
        os.killpg(STATE["window"].pid, signal.SIGTERM)


if __name__ == "__main__":
    # `qa_tools.py --picture <png> [script]`: the same picture for a workflow step (the MCP check's window).
    if sys.argv[1:2] == ["--picture"] and len(sys.argv) in (3, 4):
        why = render(Path(sys.argv[2]).resolve(), [s for s in sys.argv[3].split(";") if s] if len(sys.argv) == 4 else [], float(ENV.get("QA_WINDOW_WAIT") or 8))
        print(why or f"pictured: {sys.argv[2]}")
        sys.exit(1 if why else 0)
    main()
