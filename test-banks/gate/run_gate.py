"""Run the UNB-208 gate bank through a node's MCP, with a real model as the client and as the judge.

  python3 run_gate.py run   --mcp mcp.json --out results.jsonl [--claude claude] [--model sonnet] [--judge-model sonnet]
                            [--jobs 3] [--ids a,b | --slice slice.json] [--limit N] [--timeout 1200] [--build TEXT]
                            [--node-pid-file node.pid [--rss-cap-mb 2560] [--rss-every 2]]
  python3 run_gate.py score --out results.jsonl [--md summary.md] [--slice slice.json]
  python3 run_gate.py left  --out results.jsonl [--slice slice.json]     (tasks not run yet)
  python3 run_gate.py prepare --dir D --mcp m0.json [--mcp m1.json ...] [--per 12] [--slice slice.json]
  python3 run_gate.py judges  --dir D            then   python3 run_gate.py collect --dir D --out results.jsonl
      (CI: the models run between these, in steps that hold the credential and run no script; see below)
  python3 run_gate.py tasks --bank ../popular-sites/top-1000.json [--first N] [--shard i/n] [--write tasks.json]
  python3 run_gate.py again --out results.jsonl [--floor promoted-1k.json] --write again.ids   (what to run once more)
      then  left/prepare --again again.ids   (those tasks, run again whatever results.jsonl holds)

The bench (UNB-307): `--bank` may name a site list instead of a bank (test-banks/popular-sites/top-1000.json, its
`cases`); its tasks are made from it by one rule for every site (`bench_tasks`), never written by hand: a search case
asks its goal with its first value (cold) and then its second (warm, judged against the cold answer, browserless or it
fails); a read case reads the front page for its goal (cold) and then asks the same read again (warm: answered by the
route the cold ask learned, no browser). `--first N` keeps the first N sites in the list's order (rank order for the
bench), `--shard i/n` (i from 0) the sites at positions i, i+n, i+2n...: every task in exactly one shard, a warm twin
always beside its cold task. Every result records its cost (`cost`: the client's and the judge's dollars and seconds),
and `score` sums them.

Run once more (UNB-307, Lewis, 25 Nov 2026: "a changed verdict is rerun once before it counts"): `again` names each task
run once whose outcome measured nothing (infra, error) or differs from the floor's verdict for it (promoted-1k.json),
with its twin, since a warm ask only means something on the node its cold ask just taught. `prepare --again` runs exactly
those on fresh nodes, and `collect` appends their results: the last line for a task is its verdict, and the gate reads
the first beside it (promotion_gate.py check --top1k-results).

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
  infra               the MCP server never connected, the judge gave no verdict, or the answer was not the node's
                      (fail_reason "off_node": a tool other than the node's ran, or it answered with no call to
                      the node): rerun, never scored
needed_hands (a flag): the task requires an authenticated interaction, or an unbrowse_do reply said the page needs clicks or typing.
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
import secrets
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
# A task of the authed phase signs up with the node's vault and reads what only the account sees (Lewis, 25 Nov 2026:
# the slice tests cold, warm and authed calls on sites with heavy anti-bot); the plain prompt forbids an account.
with open(os.path.join(HERE, "prompt-authed.md")) as _f:
    PROMPT_AUTHED = _f.read()
with open(os.path.join(HERE, "judge.md")) as _f:
    JUDGE = _f.read()
# A warm twin is judged against its cold twin's answer, not its check alone (judge-warm.md).
with open(os.path.join(HERE, "judge-warm.md")) as _f:
    JUDGE_WARM = _f.read()
# A bench read's warm twin asks the same read again: no value to change, so it is judged for the same page's content.
with open(os.path.join(HERE, "judge-warm-read.md")) as _f:
    JUDGE_WARM_READ = _f.read()
TOP1K = os.path.join(os.path.dirname(HERE), "popular-sites", "top-1000.json")
READ_LINKS = (
    '- If a required link appears in a snapshot without its URL, read the href using its actual reference. '
    'For example, send ["get", "attr", "@e2", "href"] to unbrowse_browse. Resolve relative URLs against the page.\n'
)
COLD_RULES = (
    '- If the tool offers a one-call path, start with the Start page as url and the full Task text as goal. '
    'If it offers a browser, use the site\'s own search, filters and pagination.\n'
    + READ_LINKS +
    '- After completing a read by hand, if the node did not return a saved route for that read, close the tab with '
    'unbrowse_browse using do: ["close"], the browser site, and the full Task text as goal. This finishes learning '
    'from the traffic you already read. Close only after you have collected the evidence.\n'
    '- If a bot check or CAPTCHA stops you, pass it through the node itself using unbrowse_challenge until it '
    'no longer asks, then go on. Report a gate only when the node could not pass it. Never get around a paywall or a login.'
)
PAIRED_COLD_RULES = (
    '- This is the browserful half of a cold and warm pair. Start one session using unbrowse_browse with the browser '
    'site, the full Task text as goal, and do: ["open", "<Start page>"]. Collect the requested data in that session '
    'using the site’s search page and controls. Keep the session through any visible interaction and use it for any '
    'normal verification the site asks you to complete. If access is blocked in this session, report what the site showed.\n'
    + READ_LINKS +
    '- After you have read the requested data, close that session with unbrowse_browse, do: ["close"], the same browser '
    'site and the full Task text as goal. This saves the route the warm ask will use. Confirm the close reply recorded '
    'the route before reporting the answer.'
)
WARM_RULES = (
    '- This warm task measures replay of a route learned by the preceding task on this node. '
    'Start with unbrowse_do using the Start page as url, the full Task text as goal, and browser: "never". '
    'If the node is still working, collect the same ask by its ID.\n'
    '- If replay meets a person check (the reply says a challenge, or next: unbrowse_challenge), pass it through the '
    'node before giving up: unbrowse_challenge (look, then click, drag, hold or type as its picture shows) until it no '
    'longer asks, then replay the same ask. That is the only browser step a warm ask may take; report a gate only when '
    'the node could not pass it.\n'
    '- If goal lookup misses, use unbrowse_search with an empty query to list local routes. Inspect a saved route '
    'for the same site and operation, then use unbrowse_call with browser: "never" and the current task\'s values.\n'
    '- Use the order and fields of the site records returned by replay. Use the saved route for any additional '
    'fields you need. Keep the requested search values in any follow-up calls. Do not open a browser to confirm the '
    'results, learn the route again, or use a remote route. If replay does not supply the requested data, report the failure and its evidence.'
)
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
LOADS_TOOLS = {"ToolSearch"}
# A model subscription that has spent its window, or a key that was refused, says so in its own words and says the same
# thing to every task behind it. That is the run's infrastructure, never the site's verdict: on 26 Nov 2026 the bench
# wrote 1,970 task "errors" in one run whose every ask was "ChatGPT usage limit reached", and the gate read them as sites
# the node failed. The phrases are the providers' own, not a site's: no page's answer reaches here (this is read only
# where the client gave no answer at all).
CREDENTIAL_REFUSAL = re.compile(
    r"(?i)(usage|weekly|monthly) limit (?:reached|hit|exceeded)"
    r"|credit balance is too low|insufficient[_ ]quota|exceeded your current quota|insufficient balance"
    r"|out of credits|insufficient credits?|add credits to keep going|top up at"
    r"|invalid (?:api key|x-api-key)|incorrect api key"
    r"|credential (?:was )?refused|no (?:claude |model |opencode )?credential"
    r"|oauth token (?:expired|revoked)|not (?:logged|signed) in to opencode|reconnect opencode")
# The one refusal that answers later by itself. A rate limit is waited out and asked again, each wait twice the last
# (UNB-307, Lewis 26 Nov 2026: "do retries exponential for rate limit"); a spent window or a refused key is not waited
# for, because no wait brings it back.
RATE_LIMIT = re.compile(r"(?i)rate limit|too many requests|\b429\b|overloaded|try again in \d+\s*(?:ms|s|sec|seconds)"
                        r"|temporarily unavailable")
RETRY_TRIES_DEFAULT = 4
RETRY_BASE_S_DEFAULT = 5.0
RETRY_CAP_S = 300.0
# Set when the credential refuses an ask: the wave in flight stops starting tasks, so one dead window costs one ask, not
# every task behind it. A run that resumes retries each of them (infra).
CREDENTIAL_STOP = threading.Event()
# What the node said answered an ask: a route it called (`called`), or the page learned, walked or handed over.
HOW = re.compile(r'"how"\s*:\s*"([a-z_]+)"')
BROWSER_USED = re.compile(r'"browser"\s*:\s*true')
TRACE_RESULT_LIMIT = 8_000
JUDGE_TRACE_LIMIT = 20_000


def reply_says(text):
    """What one node reply says about how it was answered: its `how`s, whether the browser ran, whether the page needs
    hands. Read from the whole reply before the trace cuts it: the node writes `browser` last, and
    a fresh verifier of #935 (25 Nov 2026) found a 6 KB warm reply that used the browser scored right."""
    try:
        reply = json.loads(text)
    except json.JSONDecodeError:
        return {"how": [], "browser": False, "hands": bool(HANDS.search(text))}
    if not isinstance(reply, dict):
        return {"how": [], "browser": False, "hands": False}
    how = reply.get("how")
    result = reply.get("result")
    meta = [reply, result] if isinstance(result, dict) else [reply]
    pages = reply.get("pages")
    page_replies = [page for page in pages if isinstance(page, dict)] if how == "pages" and isinstance(pages, list) else []
    parts = meta + page_replies
    modes = [how]
    if page_replies:
        modes = []
        for page in page_replies:
            mode = page.get("how")
            if mode == "error" and page.get("outcome") == "browser_declined":
                continue
            modes.append(mode if isinstance(mode, str) else how)
    notes = (part.get(key) for part in parts for key in ("why", "error", "note"))
    route = reply.get("route")
    route_id = meta[-1].get("learned_again") or meta[-1].get("route_id") or reply.get("route_id")
    if route_id is None and isinstance(route, dict):
        route_id = route.get("id")
    learned = reply.get("learned")
    companions = reply.get("learned_routes")
    return {"how": [mode for mode in modes if isinstance(mode, str)],
            "browser": any(part.get("browser") is True for part in parts),
            "hands": any(part.get("how") == "browse" or part.get("outcome") == "needs_hands" for part in parts)
                     or any(HANDS.search(note) for note in notes if isinstance(note, str)),
            "route": route_id if isinstance(route_id, str) else None,
            "page_routes": [page["route_id"] for page in page_replies
                            if page.get("how") == "called" and isinstance(page.get("route_id"), str)
                            and (page.get("ok") is True or page.get("outcome") == "answered_empty")],
            "learned": [row["route_id"] for row in learned if isinstance(row, dict) and isinstance(row.get("route_id"), str)]
                       if isinstance(learned, list) else [],
            "companions": [route for route in companions if isinstance(route, str)] if isinstance(companions, list) else [],
            "answered_empty": reply.get("outcome") == "answered_empty",
            "ok": meta[-1].get("ok") is True}


def warm_browser(calls):
    """Why a warm ask was not answered by the route the cold ask learned, from the node's own replies, or "".
    Read completed do and call replies. An ask ID means the call is still in progress. Driving or walking a page is
    browser use. The agent separately reports a wall as a gate."""
    why = []
    for c in calls:
        tool, said = c.get("tool", ""), c.get("said") or reply_says(c.get("result") or "")
        if tool.endswith("unbrowse_browse"):
            why.append("drove the page with unbrowse_browse")
        elif tool.endswith("unbrowse_walk"):
            why.append("walked the page with unbrowse_walk")
        elif tool.endswith("unbrowse_challenge"):
            why.append("used the browser challenge tool")
        elif tool.endswith("unbrowse_observe") and not c.get("is_error"):
            why.append("read a browser snapshot with unbrowse_observe")
        elif tool.endswith(("unbrowse_do", "unbrowse_call")):
            name = "unbrowse_do" if tool.endswith("unbrowse_do") else "unbrowse_call"
            if said["browser"]:
                why.append(f"{name} answered with browser: true")
            if c.get("is_error"):
                continue
            hows = [h for h in said["how"] if h not in ("called", "working")] if name == "unbrowse_do" else []
            if hows:
                why.append(f"{name} answered how=" + ",".join(hows))
    return "; ".join(dict.fromkeys(why))


def route_evidence(trace, *, cold):
    """Saved cold route IDs or successful warm replay route IDs, from complete node metadata."""
    seen = set()
    for call in trace:
        tool = call.get("tool", "")
        if call.get("is_error") or not tool.startswith("mcp__unbrowse"):
            continue
        said = call.get("said") or reply_says(call.get("result") or "")
        if cold and tool.endswith("unbrowse_browse"):
            seen.update(said.get("learned") or ())
        if tool.endswith("unbrowse_walk") and cold and said.get("route"):
            seen.add(said["route"])
        how = "learned" if cold else "called"
        answered = said.get("ok") or (not cold and said.get("answered_empty"))
        if not cold and tool.endswith("unbrowse_do"):
            seen.update(said.get("page_routes") or ())
        if tool.endswith("unbrowse_do") and how in said["how"] and answered and said.get("route"):
            seen.add(said["route"])
            if cold:
                seen.update(said.get("companions") or ())
        if not cold and tool.endswith("unbrowse_call") and answered:
            args = call.get("input")
            actual = said.get("route") or (args.get("route_id") if isinstance(args, dict) else None)
            if isinstance(actual, str):
                seen.add(actual)
    return seen
LOCK = threading.Lock()
RSS_CAP_MB = 2560
CHECK_KINDS = {
    "regex": "the answer text or one of its items matches the regular expression {arg}",
    "contains": "the answer text or one of its items contains {arg!r} (any case)",
    "items_match": "at least {n} of the listed items each match the regular expression {arg}",
    "count": "the answer lists at least {n} items of the kind asked ({arg})",
    # A value the site has nothing for (the bank's nonsense twins): the honest answer is that nothing was found. Records
    # served anyway, or another value's records, are the worst class (wrong data handed back as ok).
    "none": "the answer says the site has nothing for {arg}, and lists no records as results for it",
}


def describe_check(rule):
    """The check in words, for the judge. Alternatives joined by | : any one met is enough."""
    alts = re.split(r"\|(?=(?:contains|regex|none|count>=\d+|items_match>=\d+):)", rule)
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


def rate_limit_words(lines, err):
    """What the provider said when it asked to be asked again later, or "" when it did not.

    A rate limit is the one refusal a wait fixes: a per-minute window, a burst of 12 parallel asks, an `overloaded`. A
    spent usage window (`usage limit reached`) matches nothing here and is not waited for — no wait brings it back.
    """
    text = "\n".join((lines or [])[-20:]) + "\n" + (err or "")
    found = RATE_LIMIT.search(text)
    return found.group(0) if found else ""


def retry_settings(env=None):
    """How many asks, and the first wait: `GATE_RETRY_TRIES` and `GATE_RETRY_BASE_S`, or the defaults.

    Read per call so a test, and a workflow that wants a longer first wait, both say so in the environment.
    """
    env = os.environ if env is None else env
    try:
        tries = max(1, int(env.get("GATE_RETRY_TRIES") or RETRY_TRIES_DEFAULT))
    except ValueError:
        tries = RETRY_TRIES_DEFAULT
    try:
        base = max(0.0, float(env.get("GATE_RETRY_BASE_S") or RETRY_BASE_S_DEFAULT))
    except ValueError:
        base = RETRY_BASE_S_DEFAULT
    return tries, base


def run_model(cmd, timeout, say=print):
    """`run_claude`, and when the provider says it is rate limited, wait and ask again: each wait twice the last, capped.

    A rate limit is the provider asking for time, not a verdict on a site. Without this a burst of parallel asks turns a
    wave of tasks into `error`: on 26 Nov 2026 the 1k bench filed rate-limited asks as task errors, and a resume skipped
    them as done. With it, the ask that was only told to wait comes back with an answer, and the record is the answer.
    An ask still limited after every wait is `infra` (a rerun retries it) and does not stop the run: one lane's
    congestion is not the next lane's.
    """
    tries, delay = retry_settings()
    lines, err, timed_out = [], "", False
    for attempt in range(1, tries + 1):
        lines, err, timed_out = run_claude(cmd, timeout)
        words = "" if timed_out else rate_limit_words(lines, err)
        if not words or attempt == tries:
            return lines, err, timed_out
        say(f"  rate limited ({words}); waiting {delay:.0f}s and asking again ({attempt}/{tries})")
        time.sleep(delay)
        delay = min(delay * 2, RETRY_CAP_S)
    return lines, err, timed_out


def trace_excerpt(text):
    return limit_evidence(SECRET.sub("[REDACTED]", text), TRACE_RESULT_LIMIT)


def limit_evidence(text, limit):
    if len(text) <= limit:
        return text
    gap = "\n[Middle of tool reply omitted]\n"
    kept = limit - len(gap)
    if kept < 5:
        return text[:limit]
    first = kept * 4 // 5
    return text[:first] + gap + text[-(kept - first):]


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
                    c.update(is_error=bool(b.get("is_error")), result=trace_excerpt(text),
                             said=reply_says(text))
                    calls.append(c)
        elif ev.get("type") == "result":
            final = ev.get("result") or ""
            meta = {k: ev.get(k) for k in ("duration_ms", "num_turns", "total_cost_usd", "is_error", "subtype",
                                            "agent_cli", "usage")}
    return calls, final, meta


def last_json(text):
    for raw in reversed(JSON_BLOCK.findall(text or "")):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            continue
    return None


def judge_evidence(trace):
    replies, actions = [], []
    last_reads = {}
    for number, call in enumerate(trace, start=1):
        tool = call["tool"]
        result = call.get("result") or ""
        arguments = call.get("input") or {}
        words = arguments.get("do") if isinstance(arguments, dict) else None
        if not call.get("is_error") and tool.endswith(("unbrowse_do", "unbrowse_call")):
            if (call.get("said") or reply_says(result)).get("ok"):
                last_reads["route"] = [len(replies)]
        if tool.endswith("unbrowse_browse") and isinstance(words, list) and words:
            action = words[0]
            if action in ("open", "click", "fill", "type", "press", "eval", "get", "snapshot", "scroll"):
                tool = f"{tool} ({action})"
            if action in ("click", "fill", "type", "press"):
                actions.append(f"{number}. {tool}: {result[:180]}")
            if action in ("eval", "get", "snapshot") and result and not call.get("is_error"):
                recent = last_reads.setdefault(action, [])
                recent.append(len(replies))
                del recent[:-2]
        replies.append(f"{number}. {tool}: {result}")
    separator = "\n---\n"
    seen = separator.join(replies)
    if len(seen) <= JUDGE_TRACE_LIMIT:
        return seen
    action_summary = "\n".join(actions)[:2_000]
    summary = f"\nBrowser actions by call number:\n{action_summary}\n" if action_summary else ""
    remaining = JUDGE_TRACE_LIMIT - len(summary) - len(separator) * (len(replies) - 1)
    # Follow-up browser reads can use the same action as the read that found the record.
    reads = sorted((i for recent in last_reads.values() for i in recent), key=lambda i: len(replies[i]))
    reserve = remaining * 2 // 3
    for position, i in enumerate(reads):
        share = reserve // (len(reads) - position)
        replies[i] = limit_evidence(replies[i], max(0, min(share, TRACE_RESULT_LIMIT + 128)))
        reserve -= len(replies[i])
        remaining -= len(replies[i])
    other = [i for i in range(len(replies)) if i not in reads]
    # Short replies leave room for longer ones, and even middle replies retain an excerpt in time order.
    for position, i in enumerate(sorted(other, key=lambda i: len(replies[i]))):
        replies[i] = limit_evidence(replies[i], max(0, remaining // (len(other) - position)))
        remaining -= len(replies[i])
    return separator.join(replies) + summary


def judge_prompt(task, res, cold=None):
    """The judge's ask. A warm twin (`after`) is also shown its cold twin's task and answer: it is right only if the cold
    answer was, this one matches it in kind, and its records changed with the value. A twin whose cold run left no
    answer is judged against nothing, and says so."""
    text = JUDGE.format(task=taskmod.fill_dates(task["task"]), url=taskmod.fill_dates(task["url"]), check=task["check"],
                        check_words=describe_check(task["check"]), answer=json.dumps(res["answer"], indent=1),
                        seen=judge_evidence(res["trace"]) or "(no tool results)",
                        needed_hands="yes" if res["needed_hands"] else "no")
    if task.get("after"):
        text += (JUDGE_WARM_READ if task.get("kind") == "read" else JUDGE_WARM).format(cold_task=taskmod.fill_dates((cold or {}).get("task_text") or task["after"]),
                                  cold_answer=json.dumps((cold or {}).get("answer"), indent=1) if cold else
                                  "null (the cold ask left no answer: point 1 fails)")
    return text


def read_verdict(lines):
    """The judge's verdict from its output: {"meets_check": bool, "finished": bool, "why": str}, or None."""
    _, final, meta = parse_stream(lines)
    verdict = last_json(final)
    if not isinstance(verdict, dict) or not isinstance(verdict.get("meets_check"), bool):
        return None, meta
    return verdict, meta


def credential_refusal(res):
    """What the model's credential said when it refused the ask, or "" when it did not refuse.

    Read only where the client gave no answer at all, and only for the providers' own words for a spent window or a
    refused key: a site's 401 or a page's words are in a tool reply, never here."""
    for text in (res.get("stderr") or "", res.get("final_text") or ""):
        found = CREDENTIAL_REFUSAL.search(text)
        if found:
            return found.group(0)
    return ""


def first_outcome(res):
    """The outcome the client's run alone settles, or None when the answer goes to the judge."""
    ans, calls = res.get("answer"), res.get("trace") or []
    unb = [c for c in calls if c["tool"].startswith("mcp__unbrowse")]
    res["needed_hands"] = res.get("phase") == "authed" or any(
        c["tool"].endswith("unbrowse_do") and (c.get("said") or reply_says(c.get("result") or ""))["hands"]
        for c in unb
    )
    res["browsed"] = any(c["tool"].endswith("unbrowse_browse") for c in unb)
    # Whether the client took a check through the node's own tool (unbrowse_challenge), or gave up without it: a gate is
    # the node's wall, and the record says whether the client asked it to pass one. It never changes the outcome.
    res["challenged"] = any(c["tool"].endswith("unbrowse_challenge") for c in unb)
    if res.get("phase") == "warm":
        res["warm_browser"] = warm_browser(unb)
    if not unb and NO_SERVER.search(res.get("final_text") or ""):
        return "infra"
    # An answer the node did not give is not the node's to score. Steve QA 2026-11-24, UNB-300: the nightly bank
    # 45323992199 ran under a client that had a shell and the web and never the node's tools, and scored seven answers
    # "right" from Bash and WebFetch alone.
    # ToolSearch only loads the node's own tools' schemas (the CLI defers an MCP server's tools behind it): it reads no
    # site, so it is not answering from elsewhere.
    other = sorted({c["tool"] for c in calls if not c["tool"].startswith("mcp__unbrowse") and c["tool"] not in LOADS_TOOLS})
    if other or (not unb and isinstance(ans, dict) and ans.get("status") in ("answered", "gate", "failed")):
        res["fail_reason"] = "off_node: " + (", ".join(other) if other else "an answer with no call to the node")
        return "infra"
    if not isinstance(ans, dict) or ans.get("status") not in ("answered", "gate", "failed"):
        refused = credential_refusal(res)
        if refused:
            # The credential's refusal is the run's, not the site's: rerun it when the credential answers again, and
            # stop the run at once (run_one) rather than write a thousand task errors behind it.
            res["fail_reason"] = f"credential: {refused}"
            return "infra"
        limited = rate_limit_words([res.get("final_text") or ""] if not calls else [], res.get("stderr") or "")
        if limited:
            # Still limited after every wait (run_model): a rerun retries it, and the run goes on, because one lane's
            # congestion is not the next lane's verdict.
            res["fail_reason"] = f"rate_limited: {limited}"
            return "infra"
        return "error"
    if ans["status"] == "gate":
        return "set_aside"
    if ans["status"] == "failed":
        # A no-results answer can use "failed" after a completed read. A pending reply gives the judge no site data.
        read_tools = ("unbrowse_do", "unbrowse_call", "unbrowse_browse")
        got_data = any(
            not c.get("is_error")
            and c["tool"].endswith(read_tools)
            and (c.get("said") or reply_says(c.get("result") or ""))["how"] != ["working"]
            for c in unb
        )
        if not str(res.get("check", "")).startswith("none:") or not got_data:
            return "honest_fail"
    return None


def judged_outcome(res, verdict, meta):
    res["judge"], res["judge_meta"] = verdict, meta
    if verdict is None:
        return "infra"
    if not verdict["meets_check"]:
        return "confidently_wrong"
    if (res.get("phase") == "authed" or res["needed_hands"]) and verdict.get("finished") is not True:
        return "unfinished"
    # A warm ask the route did not answer is a failure whatever it answered (Lewis, 25 Nov 2026: "needs the browser =
    # fail"): the cold ask learned a route, and a new value must be called on it, no browser.
    if res.get("phase") == "warm" and res.get("warm_browser"):
        return "warm_browsed"
    return "right"


def twin_outcome(res, cold):
    """A warm twin's outcome once its cold ask's is final. A twin is read against what its cold ask learned, so one whose
    cold ask did not come out right has nothing to match: a wall there sets the pair aside, an infrastructure fault
    reruns it, and any other cold outcome makes the twin a fail it did not choose, never a confident wrong answer of its
    own. A local judged run on 25 Nov 2026 filed real rice cookers confidently wrong because the cold ask met the wall."""
    outcome = res["outcome"]
    if res.get("phase") != "warm" or outcome in ("infra", "error"):
        return outcome
    if not cold:
        if outcome == "right":
            res["fail_reason"] = "the paired cold ask has no recorded outcome"
            return "honest_fail"
        return outcome
    if cold.get("outcome") == "right":
        if outcome == "right":
            if "chrome_launches" in cold and cold["chrome_launches"] != 1:
                count = cold["chrome_launches"]
                res["fail_reason"] = f"expected one Chrome launch in the paired cold ask, saw {count if count is not None else 'missing evidence'}"
                return "honest_fail"
            saved = route_evidence(cold.get("trace") or [], cold=True)
            replayed = route_evidence(res.get("trace") or [], cold=False)
            if not replayed or replayed - saved:
                res["fail_reason"] = "warm replay did not use a route saved by its cold ask"
                return "honest_fail"
        return outcome
    was = cold.get("outcome")
    res["fail_reason"] = f"cold_{was}: its cold ask came out {was}, so there was no learned route to match"
    return was if was in ("set_aside", "infra") else "honest_fail"


def client_argv(args, task, mcp, *, paired_cold=False):
    phase = task.get("phase")
    # Some practice forms store usernames in a 20-character column. Keep all 64 random bits.
    signup_name = "ubqa" + secrets.token_hex(8) if phase == "authed" else ""
    cold_rules = PAIRED_COLD_RULES if paired_cold else COLD_RULES
    prompt = (PROMPT_AUTHED if phase == "authed" else PROMPT).format(
        task=taskmod.fill_dates(task["task"]), url=taskmod.fill_dates(task["url"]),
        today=taskmod.today_sgt().isoformat(), max_steps=args.max_steps,
        phase_rules=WARM_RULES if phase == "warm" else cold_rules,
        signup_name=signup_name,
    )
    return claude_cmd(args, prompt, SYSTEM, args.model, mcp=mcp)[1:]


def judge_argv(args, task, res, cold=None):
    return claude_cmd(args, judge_prompt(task, res, cold), JUDGE_SYSTEM, args.judge_model)[1:]


def client_result(task, args, lines, err, timed_out, wall_s):
    calls, final, meta = parse_stream(lines)
    if wall_s is None and meta.get("duration_ms"):
        wall_s = meta["duration_ms"] / 1000
    return {"id": task["id"], "source": task["source"], "phase": task.get("phase", "cold"), "after": task.get("after"),
            "check": task["check"], "model": args.model,
            # What the wrapper says it ran (a switch can run another model than the argv's `--model`); None when the
            # answer did not come from the wrapper. The floor and the candidate must answer with the same one.
            "model_ran": (meta.get("agent_cli") or {}).get("model"),
            "judge_model": args.judge_model, "node_build": args.build, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "wall_s": round(wall_s or 0, 1), "timed_out": timed_out, "meta": meta,
            "task_text": task.get("task", ""), "final_text": SECRET.sub("[REDACTED]", final or "")[-4000:], "answer": last_json(final),
            "stderr": SECRET.sub("[REDACTED]", err or ""), "tool_calls": len(calls), "trace": calls}


def task_cost(res):
    """What the task cost, from what each model run said of itself: dollars and seconds for the client and for the
    judge (None where a run said nothing: a client killed by its alarm, or an answer never judged)."""
    meta, judge = res.get("meta") or {}, res.get("judge_meta") or {}
    secs = judge.get("duration_ms")
    return {"client_usd": meta.get("total_cost_usd"), "client_s": res.get("wall_s"),
            "judge_usd": judge.get("total_cost_usd"), "judge_s": round(secs / 1000, 1) if secs else None}


def write_result(res, out):
    res["cost"] = task_cost(res)
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
    lines, err, timed_out = run_model([args.claude] + client_argv(args, task, args.mcp), args.timeout)
    res = client_result(task, args, lines, err, timed_out, time.time() - t0)
    if watch:
        res["node_peak_rss_mb"], killed = watch.end(task["id"])
        if killed:
            res["outcome"], res["fail_reason"], res["needed_hands"] = "error", "memory", False
            write_result(res, args.out)
            return res
    res["outcome"] = first_outcome(res)
    if res["outcome"] is None:
        cold = load_results(args.out).get(task["after"]) if task.get("after") else None
        jlines, _, _ = run_model([args.claude] + judge_argv(args, task, res, cold), 300)
        res["outcome"] = judged_outcome(res, *read_verdict(jlines))
    if task.get("after"):
        res["outcome"] = twin_outcome(res, load_results(args.out).get(task["after"]))
    write_result(res, args.out)
    if str(res.get("fail_reason") or "").startswith("credential:"):
        why = str(res["fail_reason"]).split(": ", 1)[-1]
        CREDENTIAL_STOP.set()
        raise SystemExit(f"run_gate: the model's credential refused the ask ({why}); stopped at {res['id']}. "
                         f"Nothing about the site is measured: give the run a credential that answers and run it again "
                         f"(the task is infra, and a rerun retries it).")
    return res


# CI runs the two models in steps of their own, where the model's credential is and no script of this repository
# runs (.github/scripts/test/test_workflow_security.py): `prepare` writes each client run's arguments, a step with the
# credential runs the locked CLI on each file, `judges` reads what the clients said and writes each judge run's
# arguments, the credential's step runs those, and `collect` writes the results. An .args file holds the CLI's
# arguments separated by NUL bytes; the run's output goes beside it as .out.


def _write_args(path, argv):
    with open(path, "wb") as f:
        f.write(b"\0".join(a.encode() for a in argv))


def _todo(args):
    """The tasks to run: not finished, or only hit infrastructure; with --again, the tasks its file names, whatever is
    finished. A warm twin runs only beside its cold task, on the node that learned it, so a twin left to do brings its
    cold task back with it."""
    tasks = bank_tasks(args)
    if getattr(args, "again", None):
        with open(args.again) as f:
            again = set(f.read().split())
        todo = [t for t in tasks if t["id"] in again]
    else:
        done = load_results(args.out) if getattr(args, "out", None) else {}
        todo = [t for t in tasks if t["id"] not in done or done[t["id"]]["outcome"] == "infra"]
    want = {t["after"] for t in todo if t.get("after")}
    have = {t["id"] for t in todo}
    return [t for t in tasks if t["id"] in have or t["id"] in want]


def cmd_prepare(args):
    todo = _todo(args)
    cold = [t for t in todo if not t.get("after")]
    paired = {t["after"] for t in todo if t.get("after")} if args.slice else set()
    rounds = [cold[i:i + args.per] for i in range(0, len(cold), args.per)]
    if len(rounds) > len(args.mcp):
        raise SystemExit(f"{len(rounds)} rounds of {args.per} need {len(rounds)} nodes; {len(args.mcp)} given")
    round_of = {t["id"]: r for r, tasks in enumerate(rounds) for t in tasks}
    for r, tasks in enumerate(rounds):
        folder = os.path.join(args.dir, f"round-{r}")
        os.makedirs(folder, exist_ok=True)
        for k, t in enumerate(tasks):
            _write_args(os.path.join(folder, f"{k:03}.args"), client_argv(args, t, args.mcp[r], paired_cold=t["id"] in paired))
            with open(os.path.join(folder, f"{k:03}.task.json"), "w") as f:
                json.dump(t, f)
        # The warm wave: run after the round's cold wave, before its node stops (the workflow waits between them).
        twins = [t for t in todo if t.get("after") and round_of.get(t["after"]) == r]
        if twins:
            os.makedirs(os.path.join(folder, "warm"), exist_ok=True)
        for k, t in enumerate(twins):
            _write_args(os.path.join(folder, "warm", f"{k:03}.args"), client_argv(args, t, args.mcp[r]))
            with open(os.path.join(folder, "warm", f"{k:03}.task.json"), "w") as f:
                json.dump(t, f)
    print(len(rounds))
    return 0


def _folders(top):
    """Each round's folder, then its warm wave's, as `prepare` wrote them."""
    for d in sorted(x for x in os.listdir(top) if x.startswith("round-")):
        yield d
        if os.path.isdir(os.path.join(top, d, "warm")):
            yield d + "/warm"


def _read_lines(path):
    if not os.path.exists(path):
        return []
    with open(path, errors="replace") as f:
        return f.read().splitlines()


def _chrome_launches(path):
    try:
        counts = _read_lines(path)
    except OSError:
        return None
    count = counts[0] if len(counts) == 1 else ""
    return int(count) if re.fullmatch(r"[0-9]+", count) else None


def cmd_judges(args):
    os.makedirs(os.path.join(args.dir, "judge"), exist_ok=True)
    n = 0
    seen = {}  # each cold result by task id: a round's folder is read before its warm wave's (`_folders`)
    for folder in _folders(args.dir):
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
            seen[task["id"]] = res
            with open(stem + ".res.json", "w") as f:
                json.dump(res, f)
            if res["outcome"] is None:
                _write_args(os.path.join(args.dir, "judge", f"{folder.replace('/', '-')}-{name[:-len('.task.json')]}.args"),
                            judge_argv(args, task, res, seen.get(task.get("after"))))
                n += 1
    print(n)
    return 0


def cmd_collect(args):
    final = {}  # each result's last outcome by task id: a round's cold folder is read before its warm one (`_folders`)
    for folder in _folders(args.dir):
        base = os.path.join(args.dir, folder)
        for name in sorted(f for f in os.listdir(base) if f.endswith(".res.json")):
            with open(os.path.join(base, name)) as f:
                res = json.load(f)
            if args.require_cold_browser and res.get("phase") == "cold":
                stem = os.path.join(base, name.removesuffix(".res.json"))
                res["chrome_launches"] = _chrome_launches(stem + ".chrome-launches.txt")
            if res["outcome"] is None:
                out = os.path.join(args.dir, "judge", f"{folder.replace('/', '-')}-{name[:-len('.res.json')]}.out")
                res["outcome"] = judged_outcome(res, *read_verdict(_read_lines(out)))
            res["outcome"] = twin_outcome(res, final.get(res.get("after")))
            final[res["id"]] = res
            write_result(res, args.out)
    return 0


def cmd_browser_verdict(args):
    status = 0
    if not os.path.isdir(args.dir):
        print("REFUSE task bank: missing the browser launch counts for the slice")
        return 1
    results = load_results(args.results)
    paired = {r["after"] for r in results.values() if r.get("phase") == "warm" and r.get("after")}
    for task_id in sorted(paired):
        cold = results.get(task_id, {})
        if cold.get("outcome") != "right":
            continue
        count = cold.get("chrome_launches")
        print(f"{task_id} cold Chrome launches: {count if count is not None else 'missing'}")
        if count != 1:
            print(f"REFUSE task bank: expected one cold Chrome launch for {task_id}")
            status = 1
    warm_folders = [folder for folder in _folders(args.dir) if folder.endswith("/warm")]
    if paired and not warm_folders:
        print("REFUSE task bank: missing the warm Chrome launch counts for the slice")
        return 1
    for folder in warm_folders:
        count = _chrome_launches(os.path.join(args.dir, folder, "chrome-launches.txt"))
        round_name = folder.removesuffix("/warm")
        print(f"{round_name} warm Chrome launches: {count if count is not None else 'missing'}")
        if count != 0:
            print(f"REFUSE task bank: expected zero warm Chrome launches in {round_name}")
            status = 1
    return status


NOT_MEASURED = ("infra", "error")


def load_attempts(path):
    """Every result line for each task, in the order they were written: the first run, then any run again."""
    out = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    out.setdefault(r["id"], []).append(r)
    return out


def again_ids(tasks, attempts, floor):
    """The tasks to run once more: each run once whose outcome measured nothing, or is not the floor's verdict for it
    (`floor`: id -> outcome), and the rest of its site (its cold task and every twin), in the bank's order. A task run
    more than once already is never named again: a verdict is rerun once."""
    pick = set()
    for t in tasks:
        runs = attempts.get(t["id"]) or []
        if len(runs) != 1:
            continue
        out = runs[0]["outcome"]
        if out in NOT_MEASURED or (t["id"] in floor and floor[t["id"]] != out):
            pick.add(t.get("after") or t["id"])
    return [t["id"] for t in tasks if (t.get("after") or t["id"]) in pick]


def cmd_again(args):
    floor = {}
    if args.floor and os.path.exists(args.floor):
        with open(args.floor) as f:
            floor = json.load(f).get("verdicts") or {}
    ids = again_ids(bank_tasks(args), load_attempts(args.out), floor)
    with open(args.write, "w") as f:
        f.write("\n".join(ids) + ("\n" if ids else ""))
    print(len(ids))
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


def _url_for():
    """The site list's own reader of a case's address for a value (run_bank.url_for: its `space` and quoting)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("run_bank", os.path.join(os.path.dirname(TOP1K), "run_bank.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.url_for


def bench_tasks(cases):
    """The gate's tasks for a site list (UNB-307), one rule for every site and no hand edit: per case in rank order, a
    cold task and its warm twin on the same node. A search case (its url takes `{q}`) asks its goal with its first value,
    then its second, and each answer must list that value's results with the fields a search result has; the warm one is
    judged against the cold answer (judge-warm.md). A read case reads its front page's own main content, then asks the
    same read again, judged as the same page's content (judge-warm-read.md). Each task keeps its case's site,
    tranco_rank and url_source."""
    url_for = _url_for()
    out = []
    for c in sorted(cases, key=lambda c: c.get("tranco_rank", 0)):
        cold = "top1k:" + c["site"]
        keep = {"source": "top1k", "site": c["site"], "tranco_rank": c.get("tranco_rank"),
                "url_source": c.get("url_source"), "goal": c["goal"]}
        for phase in ("cold", "warm"):
            twin = {"id": cold, **keep} if phase == "cold" else {"id": cold + "#warm", **keep, "after": cold}
            if "{q}" in c["url"]:
                value = c["values"][0 if phase == "cold" else 1]
                twin.update(kind="search", phase=phase, value=value, url=url_for(c, value),
                            task=f'On {c["site"]}, {c["goal"]} for "{value}" and list the first 5 results it shows '
                                 "(the name or title and the link of each, and its price or date where it shows one).",
                            check=f'count>=3:result of {c["site"]}\'s own search for "{value}", each with its name or '
                                  "title and its link")
            else:
                twin.update(kind="read", phase=phase, url=c["url"],
                            task=f'On {c["site"]}, {c["goal"]}: list up to 5 of the main items it shows (headlines, '
                                 "products, listings, posts or sections), with the title of each and its link where it "
                                 "has one.",
                            check=f'count>=3:item of the main content of {c["site"]}\'s own front page (a headline, '
                                  "product, listing, post or section the page itself shows), each with its title")
            out.append(twin)
    return out


def load_bank(path):
    """A bank's tasks: its `tasks`, or a site list's `cases` made into tasks by `bench_tasks`."""
    with open(path) as f:
        data = json.load(f)
    return bench_tasks(data["cases"]) if "cases" in data else data["tasks"]


def parse_shard(text):
    i, _, n = (text or "0/1").partition("/")
    i, n = int(i), int(n or 1)
    if not 0 <= i < n:
        raise SystemExit(f"--shard {text}: want i/n with 0 <= i < n")
    return i, n


def pick_sites(tasks, first=None, shard="0/1"):
    """The tasks of the first `first` sites, then of shard i of n: a site is its cold task and every twin after it, and
    the site at position p (in the bank's order) is in shard p % n, so each task is in exactly one shard of n."""
    i, n = parse_shard(shard)
    order = list(dict.fromkeys(t.get("after") or t["id"] for t in tasks))
    if first:
        order = order[:first]
    keep = {s for p, s in enumerate(order) if p % n == i}
    return [t for t in tasks if (t.get("after") or t["id"]) in keep]


def bank_tasks(args):
    tasks = load_bank(args.bank)
    ids = None
    if getattr(args, "slice", None):
        with open(args.slice) as f:
            ids = set(json.load(f)["ids"])
    elif getattr(args, "ids", None):
        ids = set(args.ids.split(","))
    tasks = [t for t in tasks if ids is None or t["id"] in ids]
    return pick_sites(tasks, getattr(args, "first", None), getattr(args, "shard", None) or "0/1")


def cmd_tasks(args):
    """How many tasks the bank (or a site list) makes, by kind and phase; with --write, the tasks themselves."""
    tasks = bank_tasks(args)
    by = {}
    for t in tasks:
        k = f"{t.get('kind', 'task')} {t.get('phase', 'cold')}"
        by[k] = by.get(k, 0) + 1
    sites = len({t.get("after") or t["id"] for t in tasks})
    print(f"{len(tasks)} tasks over {sites} sites: " + ", ".join(f"{k} {v}" for k, v in sorted(by.items())))
    if args.write:
        with open(args.write, "w") as f:
            json.dump({"tasks": tasks}, f, indent=1)
    return 0


def cmd_run(args):
    done = load_results(args.out)
    todo = _todo(args)
    if args.limit:
        todo = todo[:args.limit]
    if args.stop_file and os.path.exists(args.stop_file):
        print("stop file present; not starting")
        return 0
    CREDENTIAL_STOP.clear()
    print(f"{len(todo)} to run, {len(done)} already in {args.out}", flush=True)
    watch = None
    if args.node_pid_file:
        with open(args.node_pid_file) as f:
            watch = NodeWatch(int(f.read().strip()), args.rss_cap_mb, args.rss_every)
    # Cold asks one at a time, each learning alone with no other browser on the node; then every warm ask at once on
    # the same node: each asks a route its cold task learned, so none should need a browser (Lewis, 25 Nov 2026:
    # "make it do cold calls in sequence then warm calls in parallel").
    cold, warm = [t for t in todo if not t.get("after")], [t for t in todo if t.get("after")]
    for wave, jobs in ((cold, 1), (warm, max(1, len(warm)))):
        with cf.ThreadPoolExecutor(jobs) as ex:
            futs = [ex.submit(lambda t=t: None if (args.stop_file and os.path.exists(args.stop_file)) or (watch and watch.dead)
                              or CREDENTIAL_STOP.is_set() else run_one(t, args, watch)) for t in wave]
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
                 f"{k.replace('_', ' ')} {v}" for k, v in sorted(by.items()) if k != "right")]
    for phase in ("cold", "warm"):
        ph = {}
        for r in rows:
            if r.get("phase", "cold") == phase:
                ph[r["outcome"]] = ph.get(r["outcome"], 0) + 1
        if ph and any(r.get("phase") == "warm" for r in rows):
            lines.append(f"{phase}: " + "; ".join(f"{k.replace('_', ' ')} {v}" for k, v in sorted(ph.items())))
    lines += cost_lines(rows)
    lines += ["", "| task | outcome | hands | calls | s | judge | answer (cut) |", "|---|---|---|---|---|---|---|"]
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


def cost_lines(rows):
    """The run's cost from each task's own `cost`: for the client and the judge, dollars in all, a run and a task, and
    minutes a run; a run that said no cost is counted apart, as UNMEASURED, never as free."""
    out = []
    costs = [r.get("cost") or task_cost(r) for r in rows]
    for who in ("client", "judge"):
        usd = [c[f"{who}_usd"] for c in costs if c[f"{who}_usd"] is not None]
        secs = [c[f"{who}_s"] for c in costs if c[f"{who}_s"] is not None]
        if not rows:
            continue
        line = (f"{who}: ${sum(usd):.2f} over {len(usd)} run(s); ${sum(usd) / max(1, len(usd)):.3f} a run, "
                f"${sum(usd) / len(rows):.3f} a task of {len(rows)}; {sum(secs) / 60 / max(1, len(secs)):.2f} min a run")
        if who == "client" and len(usd) < len(rows):
            line += f"; {len(rows) - len(usd)} run(s) said no cost (UNMEASURED)"
        out.append(line)
    return out


def cmd_left(args):
    # The nodes are counted by cold tasks: a warm twin runs on its cold task's node.
    print(sum(1 for t in _todo(args) if not t.get("after")))
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
    co.add_argument("--require-cold-browser", action="store_true", help="read per-task Chrome launch counts for paired cold asks")
    browser = sub.add_parser("browser-verdict", help="check the slice's paired cold and warm Chrome launch counts")
    browser.add_argument("--dir", required=True)
    browser.add_argument("--results", required=True)
    left = sub.add_parser("left", help="how many tasks are not run yet (or only into infrastructure trouble)")
    left.add_argument("--out", required=True)
    left.add_argument("--slice")
    tk = sub.add_parser("tasks", help="count the bank's (or a site list's) tasks; --write them")
    tk.add_argument("--write")
    tk.add_argument("--ids")
    tk.add_argument("--slice")
    ag = sub.add_parser("again", help="write the tasks to run once more: a verdict that measured nothing or changed")
    ag.add_argument("--out", required=True)
    ag.add_argument("--floor", help="the floor's verdicts (promoted-1k.json); none: only what measured nothing")
    ag.add_argument("--write", required=True)
    for p in (left, pr):
        p.add_argument("--again", help="a file of task ids (`again --write`): run exactly those, whatever is finished")
    for p in (r, s, left, pr, tk, ag):
        p.add_argument("--bank", default=os.path.join(HERE, "bank.json"),
                       help="a bank (its tasks) or a site list (its cases, made into tasks: --bank " + TOP1K + ")")
        p.add_argument("--first", type=int, help="only the first N sites, in the bank's order")
        p.add_argument("--shard", default="0/1", help="i/n: only the sites at positions i, i+n, ... (i from 0)")
    for p in (r, pr, jd, co):
        p.add_argument("--claude", default="claude")
        p.add_argument("--model", default="sonnet")
        p.add_argument("--judge-model", default="sonnet")
        p.add_argument("--max-steps", type=int, default=25)
        p.add_argument("--max-turns", type=int, default=40)
        p.add_argument("--build", default="")
    a = ap.parse_args(argv)
    return {"run": cmd_run, "score": cmd_score, "left": cmd_left, "prepare": cmd_prepare, "judges": cmd_judges,
            "collect": cmd_collect, "tasks": cmd_tasks, "again": cmd_again, "browser-verdict": cmd_browser_verdict}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
