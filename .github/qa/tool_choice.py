#!/usr/bin/env python3
"""Whether an agent reaches for the node when nothing tells it to.

The QA checklist turns every other web tool off, so it shows the node's tools work. This shows they get chosen. Each task
in tool-choice.json runs in a fresh headless Claude Code session with the node's MCP server beside the web tools an agent
already has, and the session's own record says which it called first. It reads the record, never the agent's account of
what it did.

    python3 .github/qa/tool_choice.py --mcp-config mcp.json --out <folder>

Writes each session to <folder>/<task>.jsonl, and tool-choice.json and tool-choice.md beside them. It exits 0 whatever the
agent chose, so a failure here can't stop the checks after it: `pass` in tool-choice.json is the verdict. It exits 1 when
it couldn't tell, because the node's tools never reached the agent.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

SERVER = "mcp__unbrowse"
OTHER_WEB_TOOLS = ("WebFetch", "WebSearch")
MAX_TURNS = "12"
MAX_USD = "0.75"
SESSION_SECS = 300


def events(lines):
    """The record's events: a line that isn't JSON (a warning a CLI printed) is no event."""
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def tools_called(lines):
    """The tools the session called, in order. A call the session wasn't allowed still shows what the agent reached for."""
    called = []
    for event in events(lines):
        if event.get("type") == "assistant":
            for block in (event.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    called.append(block.get("name", ""))
    return called


def reached_the_node(lines):
    """Whether the session started with the node's tools in hand."""
    for event in events(lines):
        if event.get("type") == "system" and event.get("subtype") == "init":
            return any(str(t).startswith(SERVER) for t in event.get("tools") or [])
    return False


def is_web(tool):
    return tool.startswith(SERVER) or tool in OTHER_WEB_TOOLS


def judge(task, lines):
    """One task's result: which web tool came first, and whether that's what it wanted."""
    called = tools_called(lines)
    first = next((t for t in called if is_web(t)), None)
    used_node = any(t.startswith(SERVER) for t in called)
    if task["wants"] == "none":
        chose_right, why = not used_node, "needed no website" if not used_node else "called the node for a task with no website in it"
    elif first is None:
        chose_right, why = False, "answered without any web tool"
    else:
        chose_right, why = first.startswith(SERVER), f"reached for {first} first"
    return {"id": task["id"], "wants": task["wants"], "first": first, "tools": called, "pass": chose_right, "why": why}


def verdict(results, passes_at):
    """Passes when the controls all stayed clear of the node, and enough of the web tasks reached for it first."""
    web = [r for r in results if r["wants"] == "unbrowse"]
    controls = [r for r in results if r["wants"] == "none"]
    rate = sum(r["pass"] for r in web) / len(web) if web else 0.0
    return {"pass": rate >= passes_at and all(r["pass"] for r in controls), "rate": rate, "passes_at": passes_at, "results": results}


def report(result):
    web = [r for r in result["results"] if r["wants"] == "unbrowse"]
    out = [
        f"**Tool choice: {'pass' if result['pass'] else 'fail'}.** The agent reached for the node first on "
        f"{sum(r['pass'] for r in web)} of {len(web)} web tasks (needs {result['passes_at']:.0%}), with other web tools on hand.",
        "",
        "| Task | Wanted | First web tool | Result |",
        "| --- | --- | --- | --- |",
    ]
    for r in result["results"]:
        out.append(f"| {r['id']} | {r['wants']} | {r['first'] or 'none'} | {'pass' if r['pass'] else 'fail: ' + r['why']} |")
    return "\n".join(out) + "\n"


def session(claude, prompt, mcp_config, record):
    """One fresh session. No shell and no file tools: it reads pages anyone can write, and has nothing to hand on."""
    command = claude + [
        "-p", prompt, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", str(mcp_config),
        "--setting-sources", "project", "--tools", ",".join(OTHER_WEB_TOOLS), "--allowedTools", ",".join((SERVER,) + OTHER_WEB_TOOLS),
        "--max-turns", MAX_TURNS, "--max-budget-usd", MAX_USD, "--no-session-persistence",
    ]  # fmt: skip
    with record.open("w") as out:
        try:
            subprocess.run(command, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.DEVNULL, timeout=SESSION_SECS, check=False)
        except subprocess.TimeoutExpired:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp-config", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--tasks", type=Path, default=Path(__file__).with_name("tool-choice.json"))
    parser.add_argument("--claude", default="claude", help="the command that runs Claude Code")
    parser.add_argument("--score-only", action="store_true", help="score session records made by a separate, credentialed CLI step")
    args = parser.parse_args(argv)
    plan = json.loads(args.tasks.read_text())
    args.out.mkdir(parents=True, exist_ok=True)
    results = []
    for task in plan["tasks"]:
        record = args.out / f"{task['id']}.jsonl"
        if not args.score_only:
            session(args.claude.split(), task["prompt"], args.mcp_config.resolve(), record)
        if not record.exists():
            print(f"{task['id']}: no session record was produced", file=sys.stderr)
            return 1
        lines = record.read_text(errors="replace").splitlines()
        if not reached_the_node(lines):
            print(f"{task['id']}: the session never had the node's tools, so this says nothing of what the agent would choose", file=sys.stderr)
            return 1
        results.append(judge(task, lines))
        print(f"{task['id']}: {results[-1]['why']}")
    result = verdict(results, plan["passes_at"])
    (args.out / "tool-choice.json").write_text(json.dumps(result, indent=2) + "\n")
    (args.out / "tool-choice.md").write_text(report(result))
    print(report(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
