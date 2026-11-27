#!/usr/bin/env python3
"""Whether the skills this repository ships are chosen when they should be, and only then (UNB-235).

skill-creator's trigger eval, for CI: each query in skill-evals.json runs in a fresh headless Claude Code session in a
project holding the repository's skills (skills/*), with the web tools an agent has anyway beside the Skill tool. The
session's own record says what it reached for first. A query that wants a skill passes when the first of those is that
skill; a near-miss (`wants: none`, a task close to a skill's words that no skill is for) passes when none of the
repository's skills is opened. Each query runs `trials` times, since a choice varies between runs: the report gives
each query's pass rate, pass@k and pass^k, and the verdict needs both rates (should and should-not) at `passes_at`.

    python3 .github/qa/skill_trigger.py --plan <folder>/plan.jsonl          # what a credentialed step runs, no model
    python3 .github/qa/skill_trigger.py --score <folder>                    # score the records it left
    python3 .github/qa/skill_trigger.py --key                               # the name these inputs' pass is kept under

`--key` prints `passed-skill-triggers-<hash>`: the hash of git's own record (`git ls-tree -r HEAD`) of everything the
answer depends on but the model (INPUTS below). A run that passed saves an empty cache entry under it, and the next
run with the same inputs finds it and asks no model again (UNB-166); the nightly run does not look, so a model that
drifts is still seen within a day.

The credentialed step runs only the locked CLI over plan.jsonl's lines (`record`, `prompt`); this script never holds
a credential. Writes skill-trigger.json and skill-trigger.md into <folder>. Exits 1 when it couldn't tell (a session
without the Skill tool or the skills), 0 otherwise: `pass` in skill-trigger.json is the verdict.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from costs import cost_of, table
from tool_choice import events, records, tools_called

HERE = Path(__file__).resolve().parent
OTHER = ("WebFetch", "WebSearch")
# What a skill-trigger verdict depends on, besides the model: the skills, the queries, this script and what it imports,
# the locked CLI the sessions run in, and the two workflows that hold the sessions' command line and flags.
INPUTS = (
    "skills",
    ".github/qa/skill-evals.json",
    ".github/qa/skill_trigger.py",
    ".github/qa/costs.py",
    ".github/qa/tool_choice.py",
    ".github/scripts/agent_cli.py",
    ".github/tools/claude-cli",
    ".github/tools/opencode",
    ".github/workflows/qa.yml",
    ".github/workflows/pr-agent-checks.yml",
)


def inputs_key(root=HERE.parents[1]):
    """`passed-skill-triggers-<sha256>` of the checked-out commit's blobs under INPUTS. Raises when one of them has no
    file in the commit: a key over less than every input would call a changed input unchanged."""
    listed = subprocess.run(["git", "-C", str(root), "ls-tree", "-r", "HEAD", "--", *INPUTS], capture_output=True, text=True, check=True).stdout
    paths = [line.split("\t", 1)[1] for line in listed.splitlines() if "\t" in line]
    for wanted in INPUTS:
        if not any(p == wanted or p.startswith(wanted + "/") for p in paths):
            raise RuntimeError(f"{wanted} is not in the commit: the key would leave an input out")
    auth = os.environ.get("AGENT_AUTH") or ""
    if auth.casefold() == "chatgpt":
        listed += "\nagent-auth=chatgpt"
    return "passed-skill-triggers-" + hashlib.sha256(listed.encode()).hexdigest()


def skills_opened(lines):
    """The skills the session opened, in order, by name (a plugin's `ns:name` read as `name`)."""
    opened = []
    for event in events(lines):
        if event.get("type") != "assistant":
            continue
        for block in (event.get("message") or {}).get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "Skill":
                given = block.get("input") or {}
                name = str(given.get("skill") or given.get("command") or given.get("name") or "")
                opened.append(name.lstrip("/").split(":")[-1])
    return opened


def had_skills(lines):
    for event in events(lines):
        if event.get("type") == "system" and event.get("subtype") == "init":
            return "Skill" in (event.get("tools") or [])
    return False


def judge(task, lines, ours):
    called = tools_called(lines)
    opened = skills_opened(lines)
    first = next((t for t in called if t == "Skill" or t in OTHER), None)
    first_skill = opened[0] if opened else None
    if task["wants"] == "none":
        mine = [s for s in opened if s in ours]
        ok, why = not mine, "opened no skill of ours" if not mine else f"opened {mine[0]} for a task no skill is for"
    elif first is None:
        ok, why = False, "opened no skill and used no web tool"
    elif first != "Skill":
        ok, why = False, f"reached for {first} first"
    else:
        ok, why = first_skill == task["wants"], f"opened {first_skill} first"
    return {"id": task["id"], "wants": task["wants"], "first": first_skill if first == "Skill" else first, "pass": ok, "why": why}


def verdict(results, passes_at):
    should = [r for r in results if r["wants"] != "none"]
    shouldnt = [r for r in results if r["wants"] == "none"]
    rate = lambda rs: sum(r["pass"] for r in rs) / len(rs) if rs else 1.0  # noqa: E731
    tasks = {}
    for r in results:
        tasks.setdefault(r["id"], []).append(r["pass"])
    per_task = {t: {"trials": len(p), "passed": sum(p), "pass_at_k": any(p), "pass_all_k": all(p)} for t, p in tasks.items()}
    return {"pass": rate(should) >= passes_at and rate(shouldnt) >= passes_at, "should_rate": rate(should), "should_not_rate": rate(shouldnt),
            "passes_at": passes_at, "tasks": per_task, "results": results}  # fmt: skip


def report(result):
    out = [
        f"**Skill triggers: {'pass' if result['pass'] else 'fail'}.** Opened the right skill on {result['should_rate']:.0%} of "
        f"should-trigger trials and kept clear on {result['should_not_rate']:.0%} of near misses (needs {result['passes_at']:.0%} each).",
        "",
        "| Query | Wants | Trials passed | pass@k | pass^k | First choice, each trial |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for task_id, t in result["tasks"].items():
        mine = [r for r in result["results"] if r["id"] == task_id]
        firsts = ", ".join((r["first"] or "nothing") + ("" if r["pass"] else f" (fail: {r['why']})") for r in mine)
        out.append(f"| {task_id} | {mine[0]['wants']} | {t['passed']}/{t['trials']} | {'yes' if t['pass_at_k'] else 'no'} | {'yes' if t['pass_all_k'] else 'no'} | {firsts} |")
    return "\n".join(out) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--evals", type=Path, default=HERE / "skill-evals.json")
    parser.add_argument("--skills", type=Path, default=HERE.parents[1] / "skills")
    parser.add_argument("--trials", type=int, default=0)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", type=Path, help="write the sessions to run, one JSON line each")
    mode.add_argument("--score", type=Path, help="the folder of session records to score")
    mode.add_argument("--key", action="store_true", help="print the name a pass of these inputs is kept under")
    args = parser.parse_args(argv)
    if args.key:
        print(inputs_key())
        return 0
    plan = json.loads(args.evals.read_text())
    trials = args.trials or int(plan.get("trials", 1))
    if args.plan:
        args.plan.parent.mkdir(parents=True, exist_ok=True)
        with args.plan.open("w") as out:
            for task in plan["tasks"]:
                for record in records(args.plan.parent, task["id"], trials):
                    out.write(json.dumps({"record": record.name, "prompt": task["prompt"]}) + "\n")
        return 0
    ours = {p.parent.name for p in args.skills.glob("*/SKILL.md")}
    results, spent = [], []
    for task in plan["tasks"]:
        found = records(args.score, task["id"])
        if not found:
            print(f"{task['id']}: no session record", file=sys.stderr)
            return 1
        for record in found:
            text = record.read_text(errors="replace")
            spent.append((record.stem, cost_of(text)))
            lines = text.splitlines()
            if not had_skills(lines):
                print(f"{record.name}: the session had no Skill tool, so it says nothing of what triggers", file=sys.stderr)
                return 1
            results.append(judge(task, lines, ours))
    result = verdict(results, plan["passes_at"])
    cost_md, result["cost"] = table("skill trigger sessions", spent)
    (args.score / "skill-trigger.json").write_text(json.dumps(result, indent=2) + "\n")
    (args.score / "skill-trigger.md").write_text(report(result) + "\n" + cost_md)
    print(report(result) + "\n" + cost_md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
