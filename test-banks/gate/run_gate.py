"""Run the UNB-208 gate bank through a node's MCP, with a real model as the client and as the judge.

  python3 run_gate.py run   --mcp mcp.json --out results.jsonl [--claude claude] [--model sonnet] [--judge-model sonnet]
                            [--jobs 3] [--ids a,b | --slice slice.json] [--limit N] [--timeout 1200] [--build TEXT]
                            [--node-pid-file node.pid [--rss-cap-mb 2560] [--rss-every 2]]
  python3 run_gate.py score --out results.jsonl [--md summary.md] [--slice slice.json]
  python3 run_gate.py left  --out results.jsonl [--slice slice.json]     (tasks not run yet)
  python3 run_gate.py prepare --dir D --mcp m0.json [--mcp m1.json ...] [--per 12] [--slice slice.json]
  python3 run_gate.py judges  --dir D            then   python3 run_gate.py collect --dir D --out results.jsonl
      (CI: the models run between these, in steps that hold the credential and run no script; see below)

Per task, two model runs (AGENTS.md, "The task gate and the 13 November rule": the agent calls and judges; no script
decides what is right):
  1. The client. `claude -p` with the unbrowse6 harness prompt (prompt.md) and only the node's MCP tools: no shell, no
     web of its own, no files, no other MCP server, no user settings or hooks, an empty working folder. It ends with a
     JSON block: status answered | gate | failed.
  2. The judge, for an answer. `claude -p` with no tools (judge.md): it reads the task's check and the answer, and
     says whether the answer meets the check and whether the agent finished the task.
This script only starts them and writes down what they said.

Outcomes, one per task:
  right               the agent answered, the judge found the check met and the task finished
  set_aside           the agent reported a wall (bot/login/paywall/geo): the site blocked it; never a pass
  confidently_wrong   the agent said "answered" and the judge found the check unmet
  unfinished          the answer meets the check but the page needed clicks the agent did not finish
  honest_fail         the agent said "failed"
  error               no final JSON block (timeout, crash, turn limit); or the node was killed at its memory cap
                      while the task ran on it (fail_reason "memory"): a fail, never rerun as infra
  infra               the MCP server never connected, or the judge gave no verdict: rerun, never scored
needed_hands (a flag): an unbrowse_do reply in the trace said the page needs clicks or typing (how: browse).
node_peak_rss_mb: with --node-pid-file, the most the node held while the task ran (sampled every --rss-every seconds;
  tasks run side by side share the node, so each records the node's peak over its own run). A node over --rss-cap-mb
  (2.5 GB: a node walking sites stays under it, UNB-208 B11) is killed, and no task starts after it.

`run` resumes: a task already in results.jsonl is skipped unless its outcome is infra. promotion_gate.py check reads
the results; `score` prints a table for people.
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bench import tasks as taskmod  # noqa: E402  (unbrowse6 docs/qa/benchmark-harness 8b7ff88: dates in task text)

with open(os.path.join(HERE, "prompt.md")) as _f:
    PROMPT = _f.read()
with open(os.path.join(HERE, "judge.md")) as _f:
    JUDGE = _f.read()
SYSTEM = ("You are a careful web research agent in a benchmark. Follow the user's rules exactly and end "
          "with the requested JSON block. If three attempts to access the same site fail with DNS, "
          "connection, or request-timeout errors, stop retrying that site. Changing its path, country, "
          "render mode or browsing tool does not reset those failures. Use another authoritative source "
          "only if the task permits it; otherwise return status failed and explain the observed access "
          "failure. An unavailable site is not a bot, login, paywall or geo gate. Never invent an answer "
          "to finish, and do not treat invalid inputs or missing parameters as site unavailability.")
JUDGE_SYSTEM = ("You judge one answer from a benchmark of real website tasks. You have no tools. Read the check as "
                "written and apply it to the answer exactly; do not use your own knowledge of the right answer.")
BLOCKED = "Bash,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch,Agent,Task,Glob,Grep,Skill,TodoWrite"
JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.S)
SECRET = re.compile(r"(unb_[A-Za-z0-9_.-]{8,}|sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,})")
HANDS = re.compile(r'(?i)"how"\s*:\s*"browse"|needs (clicks|hands)|needs clicks or typing')
NO_SERVER = re.compile(r"(?i)not (available|connected)|failed to connect|no .*tool")
LOCK = threading.Lock()
RSS_CAP_MB = 2560
CHECK_KINDS = {
    "regex": "the answer text or one of its items matches the regular expression {arg}",
    "contains": "the answer text or one of its items contains {arg!r} (any case)",
    "items_match": "at least {n} of the listed items each match the regular expression {arg}",
    "count": "the answer lists at least {n} items of the kind asked ({arg})",
}


def describe_check(rule):
    """The check in words, for the judge. Alternatives joined by | : any one met is enough."""
    alts = re.split(r"\|(?=(?:contains|regex|count>=\d+|items_match>=\d+):)", rule)
    out = []
    for alt in alts:
        kind, _, arg = alt.partition(":")
        n = ""
        if ">=" in kind:
            kind, n = kind.split(">=")
        out.append(CHECK_KINDS.get(kind, "{kind}: {arg}").format(arg=arg, n=n, kind=kind))
    return " OR ".join(out)


def claude_cmd(args, prompt, system, model, mcp=None):
    cmd = [args.claude, "-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose",
           "--strict-mcp-config", "--disallowedTools", BLOCKED, "--no-session-persistence",
           "--setting-sources", "project", "--system-prompt", system]
    if mcp:
        cmd += ["--mcp-config", mcp, "--allowedTools", "mcp__unbrowse", "--max-turns", str(args.max_turns)]
    else:
        cmd += ["--max-turns", "2"]
    return cmd


def run_claude(cmd, timeout):
    with tempfile.TemporaryDirectory(prefix="gate-") as cwd:
        try:
            p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
            return p.stdout.splitlines(), p.stderr[-1500:], False
        except subprocess.TimeoutExpired as e:
            out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
            return out.splitlines(), "timeout", True


def parse_stream(lines):
    calls, pending, final, meta = [], {}, None, {}
    for line in lines:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = ev.get("message") or {}
        if ev.get("type") == "assistant":
            for b in msg.get("content") or []:
                if b.get("type") == "tool_use":
                    pending[b["id"]] = {"tool": b["name"], "input": b.get("input")}
        elif ev.get("type") == "user":
            for b in msg.get("content") or []:
                if b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                    c = pending.pop(b["tool_use_id"])
                    content = b.get("content")
                    text = content if isinstance(content, str) else " ".join(
                        x.get("text", "") for x in (content or []) if isinstance(x, dict))
                    c.update(is_error=bool(b.get("is_error")), result=SECRET.sub("[REDACTED]", text)[:4000])
                    calls.append(c)
        elif ev.get("type") == "result":
            final = ev.get("result") or ""
            meta = {k: ev.get(k) for k in ("duration_ms", "num_turns", "total_cost_usd", "is_error", "subtype")}
    return calls, final, meta


def last_json(text):
    for raw in reversed(JSON_BLOCK.findall(text or "")):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            continue
    return None


def judge_prompt(task, res):
    seen = "\n---\n".join(f"{c['tool']}: {c.get('result', '')[:1500]}" for c in res["trace"][-6:])
    return JUDGE.format(task=taskmod.fill_dates(task["task"]), url=task["url"], check=task["check"],
                        check_words=describe_check(task["check"]), answer=json.dumps(res["answer"], indent=1),
                        seen=seen[-9000:] or "(no tool results)", needed_hands="yes" if res["needed_hands"] else "no")


def read_verdict(lines):
    """The judge's verdict from its output: {"meets_check": bool, "finished": bool, "why": str}, or None."""
    _, final, meta = parse_stream(lines)
    verdict = last_json(final)
    if not isinstance(verdict, dict) or not isinstance(verdict.get("meets_check"), bool):
        return None, meta
    verdict.setdefault("finished", True)
    return verdict, meta


def first_outcome(res):
    """The outcome the client's run alone settles, or None when the answer goes to the judge."""
    ans, calls = res.get("answer"), res.get("trace") or []
    unb = [c for c in calls if c["tool"].startswith("mcp__unbrowse")]
    res["needed_hands"] = any(c["tool"].endswith("unbrowse_do") and HANDS.search(c.get("result") or "") for c in unb)
    res["browsed"] = any(c["tool"].endswith("unbrowse_browse") for c in unb)
    if not unb and NO_SERVER.search(res.get("final_text") or ""):
        return "infra"
    if not isinstance(ans, dict) or ans.get("status") not in ("answered", "gate", "failed"):
        return "error"
    if ans["status"] == "gate":
        return "set_aside"
    if ans["status"] == "failed":
        return "honest_fail"
    return None


def judged_outcome(res, verdict, meta):
    res["judge"], res["judge_meta"] = verdict, meta
    if verdict is None:
        return "infra"
    if not verdict["meets_check"]:
        return "confidently_wrong"
    if res["needed_hands"] and not verdict.get("finished", True):
        return "unfinished"
    return "right"


def client_argv(args, task, mcp):
    prompt = PROMPT.format(task=taskmod.fill_dates(task["task"]), url=task["url"],
                           today=taskmod.today_sgt().isoformat(), max_steps=args.max_steps)
    return claude_cmd(args, prompt, SYSTEM, args.model, mcp=mcp)[1:]


def judge_argv(args, task, res):
    return claude_cmd(args, judge_prompt(task, res), JUDGE_SYSTEM, args.judge_model)[1:]


def client_result(task, args, lines, err, timed_out, wall_s):
    calls, final, meta = parse_stream(lines)
    if wall_s is None and meta.get("duration_ms"):
        wall_s = meta["duration_ms"] / 1000
    return {"id": task["id"], "source": task["source"], "check": task["check"], "model": args.model,
            "judge_model": args.judge_model, "node_build": args.build, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "wall_s": round(wall_s or 0, 1), "timed_out": timed_out, "meta": meta,
            "final_text": SECRET.sub("[REDACTED]", final or "")[-4000:], "answer": last_json(final),
            "stderr": SECRET.sub("[REDACTED]", err or ""), "tool_calls": len(calls), "trace": calls}


def write_result(res, out):
    with LOCK, open(out, "a") as f:
        f.write(json.dumps(res) + "\n")
    print(f"{res['outcome']:18} {res['id']:45} {res['wall_s']:7.1f}s calls={res['tool_calls']} "
          f"hands={res['needed_hands']} cost={res['meta'].get('total_cost_usd')}", flush=True)


def rss_mb(pid):
    """What process `pid` holds now, in MB, or None once it is gone. `ps` reads it alike on Linux and macOS."""
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    return int(out) // 1024 if out.isdigit() else None


class NodeWatch:
    """The node's memory while tasks run on it: each task's peak, and the cap. A node over the cap is killed, as an
    owner's machine would be out of memory; each task running on it then is a fail for memory, and none starts after."""

    def __init__(self, pid, cap_mb, every):
        self.pid, self.cap, self.every = pid, cap_mb, every
        self.running, self.killed, self.dead = {}, set(), False
        self.lock, self.done = threading.Lock(), threading.Event()
        threading.Thread(target=self._watch, daemon=True).start()

    def _watch(self):
        while not self.done.is_set():
            self.sample()
            self.done.wait(self.every)

    def sample(self):
        mb = rss_mb(self.pid)
        with self.lock:
            if mb is None:
                return
            for tid in self.running:
                self.running[tid] = max(self.running[tid], mb)
            if mb > self.cap and not self.dead:
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except OSError:
                    pass
                self.dead = True
                self.killed |= set(self.running)
                print(f"node {self.pid} killed at {mb} MB (cap {self.cap} MB): its running tasks fail for memory, "
                      "and no task starts after", flush=True)

    def start(self, tid):
        with self.lock:
            self.running[tid] = 0
        self.sample()

    def end(self, tid):
        """The task's peak on the node, and whether the node was killed at its cap while the task ran."""
        self.sample()
        with self.lock:
            return self.running.pop(tid, 0), tid in self.killed


def run_one(task, args, watch=None):
    t0 = time.time()
    if watch:
        watch.start(task["id"])
    lines, err, timed_out = run_claude([args.claude] + client_argv(args, task, args.mcp), args.timeout)
    res = client_result(task, args, lines, err, timed_out, time.time() - t0)
    if watch:
        res["node_peak_rss_mb"], killed = watch.end(task["id"])
        if killed:
            res["outcome"], res["fail_reason"], res["needed_hands"] = "error", "memory", False
            write_result(res, args.out)
            return res
    res["outcome"] = first_outcome(res)
    if res["outcome"] is None:
        jlines, _, _ = run_claude([args.claude] + judge_argv(args, task, res), 300)
        res["outcome"] = judged_outcome(res, *read_verdict(jlines))
    write_result(res, args.out)
    return res


# CI runs the two models in steps of their own, where the model's credential is and no script of this repository
# runs (.github/scripts/test/test_workflow_security.py): `prepare` writes each client run's arguments, a step with the
# credential runs the locked CLI on each file, `judges` reads what the clients said and writes each judge run's
# arguments, the credential's step runs those, and `collect` writes the results. An .args file holds the CLI's
# arguments separated by NUL bytes; the run's output goes beside it as .out.


def _write_args(path, argv):
    with open(path, "wb") as f:
        f.write(b"\0".join(a.encode() for a in argv))


def cmd_prepare(args):
    done = load_results(args.out) if args.out else {}
    todo = [t for t in bank_tasks(args) if t["id"] not in done or done[t["id"]]["outcome"] == "infra"]
    rounds = [todo[i:i + args.per] for i in range(0, len(todo), args.per)]
    if len(rounds) > len(args.mcp):
        raise SystemExit(f"{len(rounds)} rounds of {args.per} need {len(rounds)} nodes; {len(args.mcp)} given")
    for r, tasks in enumerate(rounds):
        folder = os.path.join(args.dir, f"round-{r}")
        os.makedirs(folder, exist_ok=True)
        for k, t in enumerate(tasks):
            _write_args(os.path.join(folder, f"{k:03}.args"), client_argv(args, t, args.mcp[r]))
            with open(os.path.join(folder, f"{k:03}.task.json"), "w") as f:
                json.dump(t, f)
    print(len(rounds))
    return 0


def _read_lines(path):
    if not os.path.exists(path):
        return []
    with open(path, errors="replace") as f:
        return f.read().splitlines()


def cmd_judges(args):
    os.makedirs(os.path.join(args.dir, "judge"), exist_ok=True)
    n = 0
    for folder in sorted(d for d in os.listdir(args.dir) if d.startswith("round-")):
        base = os.path.join(args.dir, folder)
        for name in sorted(f for f in os.listdir(base) if f.endswith(".task.json")):
            stem = os.path.join(base, name[:-len(".task.json")])
            with open(stem + ".task.json") as f:
                task = json.load(f)
            err = "".join(_read_lines(stem + ".err"))[-1500:]
            lines = _read_lines(stem + ".out")
            res = client_result(task, args, lines, err, not any('"type": "result"' in l or '"type":"result"' in l
                                                                for l in lines), None)
            res["outcome"] = first_outcome(res)
            with open(stem + ".res.json", "w") as f:
                json.dump(res, f)
            if res["outcome"] is None:
                _write_args(os.path.join(args.dir, "judge", f"{folder}-{name[:-len('.task.json')]}.args"),
                            judge_argv(args, task, res))
                n += 1
    print(n)
    return 0


def cmd_collect(args):
    for folder in sorted(d for d in os.listdir(args.dir) if d.startswith("round-")):
        base = os.path.join(args.dir, folder)
        for name in sorted(f for f in os.listdir(base) if f.endswith(".res.json")):
            with open(os.path.join(base, name)) as f:
                res = json.load(f)
            if res["outcome"] is None:
                out = os.path.join(args.dir, "judge", f"{folder}-{name[:-len('.res.json')]}.out")
                res["outcome"] = judged_outcome(res, *read_verdict(_read_lines(out)))
            write_result(res, args.out)
    return 0


def load_results(path):
    done = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    done[r["id"]] = r  # the last line for a task wins
    return done


def bank_tasks(args):
    with open(args.bank) as f:
        tasks = json.load(f)["tasks"]
    ids = None
    if getattr(args, "slice", None):
        with open(args.slice) as f:
            ids = set(json.load(f)["ids"])
    elif getattr(args, "ids", None):
        ids = set(args.ids.split(","))
    return [t for t in tasks if ids is None or t["id"] in ids]


def cmd_run(args):
    done = load_results(args.out)
    todo = [t for t in bank_tasks(args) if t["id"] not in done or done[t["id"]]["outcome"] == "infra"]
    if args.limit:
        todo = todo[:args.limit]
    if args.stop_file and os.path.exists(args.stop_file):
        print("stop file present; not starting")
        return 0
    print(f"{len(todo)} to run, {len(done)} already in {args.out}", flush=True)
    watch = None
    if args.node_pid_file:
        with open(args.node_pid_file) as f:
            watch = NodeWatch(int(f.read().strip()), args.rss_cap_mb, args.rss_every)
    with cf.ThreadPoolExecutor(args.jobs) as ex:
        futs = [ex.submit(lambda t=t: None if (args.stop_file and os.path.exists(args.stop_file)) or (watch and watch.dead)
                          else run_one(t, args, watch)) for t in todo]
        for f in cf.as_completed(futs):
            f.result()
    if watch:
        watch.done.set()
    return 0


def cmd_score(args):
    tasks = bank_tasks(args)
    res = load_results(args.out)
    rows = [res[t["id"]] for t in tasks if t["id"] in res]
    by = {}
    for r in rows:
        by[r["outcome"]] = by.get(r["outcome"], 0) + 1
    counted = sum(v for k, v in by.items() if k not in ("infra", "set_aside"))
    lines = [f"tasks {len(tasks)}; run {len(rows)}; not run {len(tasks) - len(rows)}",
             f"right {by.get('right', 0)} of {counted} counted; " + "; ".join(
                 f"{k.replace('_', ' ')} {v}" for k, v in sorted(by.items()) if k != "right"),
             "", "| task | outcome | hands | calls | s | judge | answer (cut) |", "|---|---|---|---|---|---|---|"]
    for r in sorted(rows, key=lambda r: (r["outcome"] == "right", r["id"])):
        a = r.get("answer") or {}
        txt = str(a.get("answer") or (a.get("gate") or {}).get("evidence") or r.get("final_text", "")[-120:])
        why = str((r.get("judge") or {}).get("why", "") or r.get("fail_reason", ""))[:80]
        lines.append(f"| {r['id']} | {r['outcome']} | {'y' if r.get('needed_hands') else ''} | {r['tool_calls']} | "
                     f"{r['wall_s']:.0f} | {why.replace('|', '/')} | "
                     f"{txt[:110].replace('|', '/').replace(chr(10), ' ')} |")
    text = "\n".join(lines)
    print(text)
    if args.md:
        with open(args.md, "w") as f:
            f.write(text + "\n")
    return 0


def cmd_left(args):
    done = load_results(args.out)
    print(sum(1 for t in bank_tasks(args) if t["id"] not in done or done[t["id"]]["outcome"] == "infra"))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--mcp", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--jobs", type=int, default=3)
    r.add_argument("--ids")
    r.add_argument("--slice")
    r.add_argument("--limit", type=int)
    r.add_argument("--timeout", type=int, default=1200)
    r.add_argument("--stop-file", help="if this file exists, start no new task")
    r.add_argument("--node-pid-file", help="the node's pid (scratch-node.sh's node.pid): record each task's peak node "
                   "memory, and kill the node over --rss-cap-mb")
    r.add_argument("--rss-cap-mb", type=int, default=RSS_CAP_MB)
    r.add_argument("--rss-every", type=float, default=2.0, help="seconds between samples of the node's memory")
    s = sub.add_parser("score")
    s.add_argument("--out", required=True)
    s.add_argument("--md")
    s.add_argument("--slice")
    pr = sub.add_parser("prepare", help="write each client run's arguments, a round of --per tasks per node")
    pr.add_argument("--dir", required=True)
    pr.add_argument("--mcp", action="append", required=True, help="one per round, in order")
    pr.add_argument("--per", type=int, default=12)
    pr.add_argument("--out", help="results so far: their tasks are not prepared again (but infra)")
    pr.add_argument("--ids")
    pr.add_argument("--slice")
    jd = sub.add_parser("judges", help="read the clients' runs, write each judge run's arguments")
    jd.add_argument("--dir", required=True)
    co = sub.add_parser("collect", help="read the judges' runs, append every task's result")
    co.add_argument("--dir", required=True)
    co.add_argument("--out", required=True)
    left = sub.add_parser("left", help="how many tasks are not run yet (or only into infrastructure trouble)")
    left.add_argument("--out", required=True)
    left.add_argument("--slice")
    for p in (r, s, left, pr):
        p.add_argument("--bank", default=os.path.join(HERE, "bank.json"))
    for p in (r, pr, jd, co):
        p.add_argument("--claude", default="claude")
        p.add_argument("--model", default="sonnet")
        p.add_argument("--judge-model", default="sonnet")
        p.add_argument("--max-steps", type=int, default=25)
        p.add_argument("--max-turns", type=int, default=40)
        p.add_argument("--build", default="")
    a = ap.parse_args(argv)
    return {"run": cmd_run, "score": cmd_score, "left": cmd_left, "prepare": cmd_prepare, "judges": cmd_judges,
            "collect": cmd_collect}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
