#!/usr/bin/env python3
"""Whether a commit's checks are green: the one reader the red-merge backstop and the release gates ask (UNB-248).

On 23-24 Nov 2026 ten pull requests merged into staging with checks failed, cancelled or still running. The
organisation is on GitHub's free plan, so branch protection and rulesets answer 403 and nothing on GitHub refuses a red
merge. The gates live in the path a commit takes after the merge instead, where no agent or tool can skip them:

    checks_green.py sha --repo R --sha S [--event push] [--skip-run ID] [--wait SECONDS]
        The workflow runs this commit's own pushes started (a push to staging, a release branch, main or a tag), each
        workflow's latest. Waits up to SECONDS for the ones still running. Exit 0 only when every one passed (success,
        skipped or neutral) and at least one ran; 1 otherwise, naming each run that did not. The runs another
        workflow's `workflow_run` hangs on the same commit (another pull request's review, the release itself) are not
        this commit's checks and are not read.

    checks_green.py red-merge --pr-json F --message F [--ignore-workflow NAME] --body F
        Whether a pull request merged into staging while any check on its head was failed, cancelled or still running
        (`gh pr view --json number,title,mergedAt,mergedBy,mergeCommit,headRefName,baseRefName,statusCheckRollup`), and
        the comment that says so: who merged it, and the merge commit's `Agent:` and `Agent-Model:` trailers. Writes
        `red=true|false` to GITHUB_OUTPUT. Merges and reverts nothing itself.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

GREEN = {"SUCCESS", "NEUTRAL", "SKIPPED"}
RUNNING = {"QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED", "EXPECTED"}
SAID = {"red": "failed", "cancelled": "cancelled", "running": "still running"}


def reading(status: str | None, conclusion: str | None) -> str:
    """One check as green, running, cancelled or red. A check run has a status and a conclusion; a commit status has
    only a state, passed here as the conclusion."""
    status = (status or "").upper()
    conclusion = (conclusion or "").upper()
    if status in RUNNING or conclusion in RUNNING or (not conclusion and status != "COMPLETED"):
        return "running"
    if conclusion in GREEN:
        return "green"
    if conclusion == "CANCELLED":
        return "cancelled"
    return "red"


def latest(items: list[dict]) -> list[dict]:
    """Each check once: a rerun or a newer run of the same workflow on the same commit replaces the older one."""
    kept: dict[tuple, dict] = {}
    for item in items:
        key = (item["workflow"], item["name"])
        if key not in kept or item["when"] >= kept[key]["when"]:
            kept[key] = item
    return sorted(kept.values(), key=lambda i: (i["workflow"], i["name"]))


def from_rollup(rollup: list[dict], ignore_workflows: set[str]) -> list[dict]:
    """A pull request's `statusCheckRollup`, check runs and commit statuses alike."""
    items = []
    for c in rollup or []:
        if c.get("__typename") == "StatusContext":
            items.append({"workflow": "", "name": c.get("context") or "", "url": c.get("targetUrl") or "",
                          "state": reading("COMPLETED" if c.get("state") not in RUNNING else c.get("state"),
                                           c.get("state")),
                          "when": c.get("startedAt") or c.get("createdAt") or ""})
            continue
        workflow = c.get("workflowName") or ""
        if workflow in ignore_workflows:
            continue
        items.append({"workflow": workflow, "name": c.get("name") or "", "url": c.get("detailsUrl") or "",
                      "state": reading(c.get("status"), c.get("conclusion")),
                      "when": c.get("startedAt") or c.get("completedAt") or ""})
    return latest(items)


def from_runs(runs: list[dict], skip_runs: set[str]) -> list[dict]:
    """Workflow runs (`actions/runs?head_sha=`), each workflow's latest, the caller's own run left out."""
    items = []
    for r in runs or []:
        if str(r.get("id")) in skip_runs:
            continue
        items.append({"workflow": r.get("name") or "", "name": r.get("name") or "", "url": r.get("html_url") or "",
                      "state": reading(r.get("status"), r.get("conclusion")),
                      "when": f"{r.get('created_at') or ''}#{int(r.get('run_attempt') or 1):04d}"})
    return latest(items)


def not_green(items: list[dict]) -> list[dict]:
    return [i for i in items if i["state"] != "green"]


def label(item: dict) -> str:
    where = f"{item['workflow']} / {item['name']}" if item["workflow"] and item["workflow"] != item["name"] else item["name"]
    return f"{where}: {SAID[item['state']]}" + (f" ({item['url']})" if item["url"] else "")


def trailers(message: str) -> dict[str, list[str]]:
    """The agent that wrote the commits, as their trailers say (the global prepare-commit-msg hook adds them)."""
    found: dict[str, list[str]] = {"agent": [], "agent_model": [], "co_authored_by": []}
    keys = {"agent": "agent", "agent-model": "agent_model", "co-authored-by": "co_authored_by"}
    for m in re.finditer(r"(?im)^\s*(agent|agent-model|co-authored-by):\s*(.+?)\s*$", message or ""):
        bucket = found[keys[m.group(1).lower()]]
        if m.group(2) not in bucket:
            bucket.append(m.group(2))
    return found


def red_merge(pr: dict, message: str, ignore_workflows: set[str]) -> dict:
    """Whether this pull request merged into staging with a check not green, and the comment saying so."""
    number = pr.get("number")
    if not pr.get("mergedAt"):
        return {"red": False, "why": f"#{number} closed without merging"}
    if pr.get("baseRefName") != "staging":
        return {"red": False, "why": f"#{number} merged into {pr.get('baseRefName')}, not staging"}
    if (pr.get("headRefName") or "").startswith("revert/"):
        return {"red": False, "why": f"#{number} is a revert; a revert is not reverted"}
    items = from_rollup(pr.get("statusCheckRollup") or [], ignore_workflows)
    bad = not_green(items)
    if not items:
        return {"red": False, "why": f"#{number} had no checks to read", "checks": 0}
    if not bad:
        return {"red": False, "why": f"#{number} merged with all {len(items)} checks green", "checks": len(items)}
    who = ((pr.get("mergedBy") or {}).get("login")) or "an unknown account"
    t = trailers(message)
    agent = ", ".join(t["agent"]) or "none"
    model = ", ".join(t["agent_model"]) or "none"
    lines = [
        f"**This pull request was merged into staging by `{who}` while {len(bad)} of its {len(items)} checks were not "
        "green.** Nothing on GitHub refuses a red merge on this plan, so this backstop opens a revert and merges nothing. "
        "Merge the revert, or fix forward and close it.",
        "",
        f"- Merged by: `{who}`",
        f"- Agent (merge commit trailer): {agent}",
        f"- Agent-Model (merge commit trailer): {model}",
    ]
    if t["co_authored_by"]:
        lines.append(f"- Co-authored-by: {', '.join(t['co_authored_by'])}")
    lines += ["", "Checks not green at the merge:", ""]
    lines += [f"- {label(i)}" for i in bad]
    return {"red": True, "why": f"#{number} merged by {who} with {len(bad)} checks not green", "checks": len(items),
            "bad": [label(i) for i in bad], "merged_by": who, "agent": t["agent"], "agent_model": t["agent_model"],
            "body": "\n".join(lines) + "\n"}


def gh_runs(repo: str, sha: str, event: str | None) -> list[dict]:
    argv = ["gh", "api", "-X", "GET", f"repos/{repo}/actions/runs", "-f", f"head_sha={sha}", "-f", "per_page=100",
            "--paginate", "--jq", ".workflow_runs[]"]
    if event:
        # Its own -f pair. Spliced in at a fixed index it once landed between `-f` and `head_sha=…`, and every release
        # failed to ask (Release 45442586420).
        argv[5:5] = ["-f", f"event={event}"]
    out = subprocess.run(argv, capture_output=True, text=True, check=True).stdout
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def write(path: str | None, text: str) -> None:
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text)


def sha_main(a: argparse.Namespace) -> int:
    deadline = time.time() + a.wait
    skip = set(a.skip_run or [])
    while True:
        items = from_runs(gh_runs(a.repo, a.sha, a.event), skip)
        running = [i for i in items if i["state"] == "running"]
        if not running or time.time() >= deadline:
            break
        print(f"waiting on {len(running)} run(s): {', '.join(i['name'] for i in running)}", flush=True)
        time.sleep(a.interval)
    bad = not_green(items)
    ok = bool(items) and not bad
    head = f"### Checks on {a.sha[:12]}" + (f" ({a.event} runs)" if a.event else "")
    lines = [head, ""]
    if not items:
        lines.append(f"No {a.event or ''} run on this commit: nothing shows it passed, so it is refused.".replace("  ", " "))
    lines += [f"- {i['name']}: {i['state']}" for i in items]
    lines += ["", "All green." if ok else f"Refused: {len(bad) or 'no'} run(s) not green" +
              (": " + "; ".join(label(i) for i in bad) if bad else ".")]
    text = "\n".join(lines) + "\n"
    print(text)
    write(os.environ.get("GITHUB_STEP_SUMMARY"), text)
    if not ok:
        print(f"::error::{a.sha[:12]} is not green: " + ("; ".join(label(i) for i in bad) or "no run"), file=sys.stderr)
    return 0 if ok else 1


def red_merge_main(a: argparse.Namespace) -> int:
    pr = json.load(open(a.pr_json, encoding="utf-8"))
    message = open(a.message, encoding="utf-8").read() if a.message else ""
    got = red_merge(pr, message, set(a.ignore_workflow or []))
    print(got["why"])
    for line in got.get("bad", []):
        print(f"  {line}")
    if got["red"]:
        open(a.body, "w", encoding="utf-8").write(got["body"])
    write(os.environ.get("GITHUB_OUTPUT"), f"red={'true' if got['red'] else 'false'}\n")
    write(os.environ.get("GITHUB_STEP_SUMMARY"), f"{got['why']}\n" + "".join(f"- {b}\n" for b in got.get("bad", [])))
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sha")
    s.add_argument("--repo", required=True)
    s.add_argument("--sha", required=True)
    s.add_argument("--event", default="push")
    s.add_argument("--skip-run", action="append")
    s.add_argument("--wait", type=int, default=0)
    s.add_argument("--interval", type=int, default=30)
    r = sub.add_parser("red-merge")
    r.add_argument("--pr-json", required=True)
    r.add_argument("--message")
    r.add_argument("--ignore-workflow", action="append")
    r.add_argument("--body", required=True)
    a = p.parse_args(argv)
    return sha_main(a) if a.cmd == "sha" else red_merge_main(a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
