#!/usr/bin/env python3
"""One verdict, one report and one folder of pictures from Claude QA's shards (UNB-235).

    merge_shards.py --shards <dir> --checklist .github/qa/checklist.md --plan <workflow> --out <dir>

Claude QA runs as parallel jobs, each with a node of its own and a few of checklist.md's checks (the `CHECKS:` of its
matrix row in qa.yml / pr-agent-checks.yml), so a push's QA ends in minutes rather than one long session. Each shard's
artifact is a folder under <dir> (qa-report-<shard>/: qa-verdict.json, qa-report.md, qa-cost.json, shots/).

The merged verdict passes only when every check of the checklist has exactly one result, from the shard that was given
it, and no result is `fail`; a shard that wrote no verdict, left a check out or answered one it wasn't given fails it.
`blocked` and `not run` don't fail it, as in one session. Reads the agent's files as data: never runs or follows a link.

`--plan` prints nothing but checks the workflow's rows instead: every check given to exactly one shard.
"""

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROW = re.compile(r"(?m)^\s*- shard: (\d+)\n\s*checks: \"([\d,]+)\"")


def checklist_numbers(text):
    """The check numbers of checklist.md's `## Checks` list, in order."""
    body = text.split("\n## Checks\n", 1)[1].split("\n## ", 1)[0]
    return [int(n) for n in re.findall(r"(?m)^(\d+)\. \*\*", body)]


def plan(workflow_text):
    """{shard: [check numbers]} from a workflow's Claude QA matrix rows."""
    return {int(s): [int(n) for n in checks.split(",")] for s, checks in ROW.findall(workflow_text)}


def plan_problems(shards, numbers):
    problems, given = [], {}
    for shard, checks in sorted(shards.items()):
        for n in checks:
            if n in given:
                problems.append(f"check {n} is given to shard {given[n]} and shard {shard}")
            given[n] = shard
    for n in numbers:
        if n not in given:
            problems.append(f"check {n} is given to no shard")
    for n in sorted(set(given) - set(numbers)):
        problems.append(f"shard {given[n]} is given check {n}, which checklist.md doesn't have")
    return problems


def _read_json(path):
    if not path.is_file() or path.is_symlink():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def merge(shard_dirs, numbers, shards, out):
    """Write out/qa-verdict.json, qa-report.md, qa-cost-<shard>.json and shots/; return the merged verdict."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "shots" / "steps").mkdir(parents=True, exist_ok=True)
    results, problems, reports = {}, [], []
    owner = {n: s for s, checks in shards.items() for n in checks}
    for shard in sorted(shards):
        folder = shard_dirs.get(shard)
        verdict = _read_json(folder / "qa-verdict.json") if folder else None
        if folder is None:
            problems.append(f"shard {shard} left no artifact")
        elif not isinstance(verdict, dict) or not isinstance(verdict.get("checks"), list):
            problems.append(f"shard {shard} wrote no verdict")
        else:
            if verdict.get("pass") is not True:
                problems.append(f"shard {shard}'s verdict is not a pass")
            for check in verdict["checks"]:
                n = check.get("n") if isinstance(check, dict) else None
                if not isinstance(n, int) or isinstance(n, bool):
                    problems.append(f"shard {shard} answered a check with no number")
                elif owner.get(n) != shard:
                    problems.append(f"shard {shard} answered check {n}, which it wasn't given")
                elif n in results:
                    problems.append(f"shard {shard} answered check {n} twice")
                else:
                    results[n] = check
        if folder:
            report = folder / "qa-report.md"
            text = report.read_text() if report.is_file() and not report.is_symlink() else "No report from this shard."
            reports.append(f"### Shard {shard}: checks {', '.join(map(str, shards[shard]))}\n\n{text.strip()}\n")
            cost = folder / "qa-cost.json"
            if cost.is_file() and not cost.is_symlink():
                shutil.copyfile(cost, out / f"qa-cost-{shard}.json")
            for name in ("tool-choice.md", "tool-choice.json"):
                extra = folder / name
                if extra.is_file() and not extra.is_symlink():
                    shutil.copyfile(extra, out / name)
            for shot in sorted((folder / "shots").glob("*.png")) + sorted((folder / "shots" / "steps").glob("*.png")):
                if shot.is_file() and not shot.is_symlink():
                    shutil.copyfile(shot, out / shot.relative_to(folder))
    checks = []
    for n in numbers:
        if n in results:
            checks.append(results[n])
        else:
            problems.append(f"check {n} has no result")
            checks.append({"n": n, "result": "fail", "note": f"shard {owner.get(n, '?')} reported no result for it"})
    if any(isinstance(c, dict) and c.get("result") == "fail" for c in checks):
        problems.append("a check failed")
    verdict = {"pass": not problems, "checks": checks, "problems": sorted(set(problems), key=problems.index),
               "shards": {str(s): shards[s] for s in sorted(shards)}}
    (out / "qa-verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    lines = [*reports]
    if verdict["problems"]:
        lines.append("**Across the shards:** " + "; ".join(verdict["problems"]) + ".\n")
    (out / "qa-report.md").write_text("\n".join(lines))
    return verdict


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--checklist", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True, help="the workflow whose Claude QA rows give the shards")
    parser.add_argument("--shards", type=Path, help="one folder per shard: qa-report-<shard>/")
    parser.add_argument("--out", type=Path)
    a = parser.parse_args(argv)
    numbers = checklist_numbers(a.checklist.read_text())
    shards = plan(a.plan.read_text())
    problems = plan_problems(shards, numbers)
    if problems or not shards:
        print("\n".join(problems or ["no shard rows found"]), file=sys.stderr)
        return 1
    if a.shards is None:
        print(f"SHARDS_OK shards={len(shards)} checks={len(numbers)}")
        return 0
    found = {}
    for folder in sorted(a.shards.glob("qa-report-*")):
        m = re.fullmatch(r"qa-report-(\d+)", folder.name)
        if m and folder.is_dir() and not folder.is_symlink():
            found[int(m.group(1))] = folder
    verdict = merge(found, numbers, shards, a.out)
    for p in verdict["problems"]:
        print(p, file=sys.stderr)
    print(("MERGED_PASS" if verdict["pass"] else "MERGED_FAIL") + f" shards={len(shards)} checks={len(numbers)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
