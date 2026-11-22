#!/usr/bin/env python3
"""One run of the goals this repo holds itself to (`goals` in .github/self-merge.json).

A fresh scratch node built from this tree (test-banks/popular-sites/scratch-node.sh) is driven over MCP the way an
agent drives it, on a fixed set of public search tasks from test-banks/popular-sites/search-cases.json. Per task:
the goal on a page the node has never seen, then the same goal with a new value and `browser: never`. It prints one
JSON object on its last line:

  first_reply_s        median seconds to the first answer, page never seen (a still-working reply is followed with
                       its ask until it answers; a task with no answer counts at least 120 s) (lower is better)
  warm_call_ms         median ms to the answer for the same goal with a new value, once the first learn is done; a task
                       with no answer counts at least 30 s, so failing fast never helps (lower)
  footprint_after_mb   the node's physical footprint 20 s after the learns, compressed pages included (lower)
  resident_after_mb    its resident size then, what PERFORMANCE.md measures (lower; budget idle + 20 MB)
  browserless_share    share of tasks whose new value was answered with browser never (higher)
  reply_bytes          median size of the answers an agent reads for a new value (answers only: a refusal is short
                       because it failed, so it never counts toward a smaller number) (lower)
  agent_steps          tasks that needed the agent's hands (how: browse) or had no answer (lower)

Plus `load` (the machine's 1-minute load average at the start: timings under load are slower) and per-task rows.

  NODE=<unbrowse-node> BROWSER_PROGRAM=<agent-browser> python3 scripts/goals/measure.py
Without NODE and BROWSER_PROGRAM it builds both from this tree first. GOAL_SITES overrides the task set (comma list
of search-cases.json `site` values); the default is fixed so runs compare.
"""
import json
import os
import re
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Eight search cases that answered or failed for the engine's own reasons on 2026-11-19, with the ones whose
# sites refused the walk then (allrecipes, etsy, ebay) left out: a refusal sets a task aside, and a goal is only
# met on a run that counts every task.
DEFAULT_SITES = ["pypi.org", "archive.org", "amazon.com", "target.com", "www.google.com", "bestbuy.com",
                 "opentable.sg", "carousell.sg"]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def build():
    env = dict(os.environ, CARGO_INCREMENTAL="0", PATH=f"{Path.home()}/.cargo/bin:{os.environ.get('PATH', '')}")
    vendor = ROOT / "unbrowse-node" / "vendor"
    if not vendor.exists():  # the TLS patch is untracked: take the main checkout's (or UNBROWSE_VENDOR)
        common = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                capture_output=True, text=True).stdout.strip()
        src = Path(os.environ.get("UNBROWSE_VENDOR") or Path(common).parent / "unbrowse-node" / "vendor")
        if src.exists():
            vendor.symlink_to(src)
    for d, args in (("unbrowse-node", ["-p", "unbrowse-node-app", "--bin", "unbrowse-node"]), ("unbrowse-browser/cli", [])):
        log(f"building {d}")
        subprocess.run(["cargo", "build", "-q", *args], cwd=ROOT / d, env=env, check=True)
    return (ROOT / "unbrowse-node/target/debug/unbrowse-node", ROOT / "unbrowse-browser/cli/target/debug/agent-browser")


def node_25():
    """The scratch node runs a page's code under Node's permission model, which
    needs Node 25 or later. Use the first such `node` on PATH or under nvm."""
    cands = [shutil.which("node")] + sorted((str(x) for x in Path.home().glob(".nvm/versions/node/v*/bin/node")),
                                            key=lambda x: [int(n) for n in x.split("/v")[-1].split("/")[0].split(".")],
                                            reverse=True)
    for c in cands:
        if not c:
            continue
        v = subprocess.run([c, "--version"], capture_output=True, text=True).stdout.strip().lstrip("v")
        if v and int(v.split(".")[0]) >= 25:
            return Path(c).parent
    raise SystemExit("no Node 25 or later on PATH or under ~/.nvm: the scratch node needs one to run page code")


def free_port():
    while True:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            p = s.getsockname()[1]
        if 20000 < p < 60000 and p != 7788:
            return p


def resident_mb(pid):
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(out) / 1024 if out else 0.0


def rss_mb(pid):
    """The node's memory. On macOS its physical footprint, which counts pages the system has compressed (resident
    size drops under memory pressure, so it reads lower after work than at idle); elsewhere resident size."""
    if shutil.which("footprint"):
        out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True).stdout
        m = re.search(r"Footprint:\s*([\d.]+)\s*(KB|MB|GB)", out)
        if m:
            return float(m.group(1)) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)]
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(out) / 1024 if out else 0.0


def mcp(port, token, args, timeout=400):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": "unbrowse_do", "arguments": args}}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/mcp", data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "content-type": "application/json",
        "accept": "application/json, text/event-stream"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    secs = time.time() - t0
    msg = None
    try:  # a plain JSON reply, however it is laid out
        msg = json.loads(raw)
    except ValueError:  # an event stream: the data lines of each event, joined
        events, cur = [], []
        for line in raw.splitlines():
            if line.startswith("data:"):
                cur.append(line[5:].lstrip())
            elif not line.strip() and cur:
                events.append("\n".join(cur)); cur = []
        if cur:
            events.append("\n".join(cur))
        for ev in events:
            try:
                m = json.loads(ev)
            except ValueError:
                continue
            if isinstance(m, dict) and ("result" in m or "error" in m):
                msg = m
    reply = {}
    if msg:
        res = msg.get("result") or {}
        reply = res.get("structuredContent") or {}
        if not reply:
            for c in res.get("content") or []:
                if c.get("type") == "text":
                    try:
                        reply = json.loads(c["text"])
                    except ValueError:
                        reply = {"text": c["text"]}
                    break
        if msg.get("error"):
            reply = {"error": msg["error"]}
    return secs, len(raw.encode()), reply


def site_refused(reply):
    """The site, not the node, said no: it answered the walk with a 4xx or a challenge. AGENTS.md: a task the site
    blocks is set aside and counted apart, never a pass and never a fail."""
    text = json.dumps(reply)
    return bool(re.search(r"(site|page) answered (4\d\d)|\bchallenge\b|captcha", text, re.I))


def until_answer(port, token, args, limit=900):
    """The time to an answer, not to a still-working reply: wait the node's longest (wait_ms 300000), and while it
    says it is still working (a learn past the wait), collect with its `ask` until it answers or `limit` seconds."""
    t0 = time.time()
    secs, size, reply = mcp(port, token, dict(args, wait_ms=300000))
    while (reply.get("outcome") == "still_working" or reply.get("how") == "working") and reply.get("ask") \
            and time.time() - t0 < limit:
        secs, size, reply = mcp(port, token, {"ask": reply["ask"], "wait_ms": 300000})
    return time.time() - t0, size, reply


def answered(reply):
    res = reply.get("result") or {}
    data = res.get("data")
    return bool(res.get("ok")) and data not in (None, [], {}, "")


# A task with no answer counts as at least this long, so failing fast never improves a median.
NO_ANSWER_FIRST_S = 120.0
NO_ANSWER_WARM_MS = 30000


def summarize(rows, idle, after, idle_res, after_res):
    """The goal values from one run's rows. No number improves by failing: a task with no answer counts at least
    the floor above in the time medians, and reply size reads answers only."""
    def med(xs):
        return round(statistics.median(xs), 3) if xs else None

    counted = [r for r in rows if not r.get("set_aside")]
    firsts = [r["first_s"] if r.get("first_ok") else max(r["first_s"], NO_ANSWER_FIRST_S)
              for r in counted if "first_s" in r]
    answered = [r for r in counted if r.get("warm_ok") and r.get("warm_how") in ("called", "network", "learned")]
    warms = [r["warm_ms"] if r in answered else max(r["warm_ms"], NO_ANSWER_WARM_MS) for r in counted if "warm_ms" in r]
    return {
        "first_reply_s": med(firsts),
        "warm_call_ms": med(warms),
        "footprint_after_mb": round(after, 1), "footprint_idle_mb": round(idle, 1),
        "resident_after_mb": round(after_res, 1), "resident_idle_mb": round(idle_res, 1),
        "browserless_share": round(len(answered) / len(counted), 3) if counted else 0.0,
        "set_aside": sum(1 for r in rows if r.get("set_aside")),
        "reply_bytes": med([r["warm_bytes"] for r in answered]),
        "agent_steps": sum(1 for r in counted if r.get("error") or r.get("first_how") == "browse"
                           or not r.get("first_ok") or not r.get("warm_ok")),
    }


def main():
    node, program = os.environ.get("NODE"), os.environ.get("BROWSER_PROGRAM")
    if not (node and program):
        node, program = build()
    cases = {c["site"]: c for c in json.loads((ROOT / "test-banks/popular-sites/search-cases.json").read_text())["cases"]}
    sites = [s.strip() for s in os.environ.get("GOAL_SITES", ",".join(DEFAULT_SITES)).split(",") if s.strip()]
    load = os.getloadavg()[0]
    d = Path(tempfile.mkdtemp(prefix="ug", dir="/tmp"))
    port = free_port()
    env = dict(os.environ, NODE=str(node), BROWSER_PROGRAM=str(program), PORT=str(port),
               PATH=f"{node_25()}:{os.environ.get('PATH', '')}")
    starter = subprocess.Popen(["sh", str(ROOT / "test-banks/popular-sites/scratch-node.sh"), str(d)], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    rows = []
    try:
        for _ in range(180):  # up, and its agent key and pid written (they land after the health route answers)
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/health", timeout=2)
                if (d / "token").exists() and (d / "node.pid").exists() and (d / "token").read_text().strip():
                    break
            except OSError:
                pass
            time.sleep(1)
        else:
            raise SystemExit(f"the scratch node never answered on {port}: {starter.stderr.read()[-500:] if starter.poll() is not None else ''}")
        token = (d / "token").read_text().strip()
        pid = int((d / "node.pid").read_text().strip())
        time.sleep(15)  # idle means settled: a node a few seconds old is still starting up
        idle, idle_res = rss_mb(pid), resident_mb(pid)
        for site in sites:
            c = cases[site]
            v0, v1 = c["values"][0], c["values"][1]
            url0 = c["url"].replace("{q}", urllib.request.quote(v0))
            url1 = c["url"].replace("{q}", urllib.request.quote(v1))
            row = {"site": site}
            try:
                s0, b0, r0 = until_answer(port, token, {"goal": c["goal"], "url": url0})
                row.update(first_s=round(s0, 2), first_how=r0.get("how"), first_ok=answered(r0))
                s1, b1, r1 = until_answer(port, token, {"goal": c["goal"], "url": url1, "browser": "never"})
                row.update(warm_ms=round(s1 * 1000), warm_how=r1.get("how"), warm_ok=answered(r1), warm_bytes=b1)
                if not row["first_ok"]:
                    row["first_said"] = json.dumps(r0)[:300]
                    row["set_aside"] = site_refused(r0)
                if not row["warm_ok"]:
                    row["warm_said"] = json.dumps(r1)[:300]  # why it gave no answer, for whoever works the goal
            except Exception as e:  # a task that errors is a row with its error, never a dropped row
                row["error"] = f"{type(e).__name__}: {e}"[:200]
            log(json.dumps(row))
            rows.append(row)
        time.sleep(20)
        after, after_res = rss_mb(pid), resident_mb(pid)
    finally:
        try:
            pid = int((d / "node.pid").read_text().strip())
            os.kill(pid, signal.SIGTERM)
        except (OSError, ValueError):
            pass
        time.sleep(3)
        mine = subprocess.run(["pgrep", "-f", str(d)], capture_output=True, text=True).stdout.split()
        for p in mine:
            try:
                os.kill(int(p), signal.SIGKILL)
            except OSError:
                pass
        starter.kill()
        shutil.rmtree(d, ignore_errors=True)

    out = summarize(rows, idle, after, idle_res, after_res)
    out.update(load=round(load, 1), sites=sites, rows=rows)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
