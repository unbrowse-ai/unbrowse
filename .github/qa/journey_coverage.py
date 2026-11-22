#!/usr/bin/env python3
"""Every journey in journeys.json has a QA step, and the run's report says how each journey did (UNB-235).

    journey_coverage.py check  [--out <folder>]
        Fails (exit 1, JOURNEYS_UNCOVERED) when a journey has no QA step and no waiver a person can check, when a QA
        step names no journey or one journeys.json doesn't have, or when a job or bank task a journey names doesn't
        exist. Prints JOURNEYS_COVERED journeys=<n> walked=<n> waived=<n> when all is well; with --out, writes
        coverage.md and coverage.json there.

    journey_coverage.py report --out <folder> [--verdict qa-verdict.json] [--mcp mcp-check.json]
                               [--bank results.jsonl] [--job qa.yml#skills=success ...]
        Writes journeys.md: each journey's steps with what each did in this run, and a result per journey. Reads the
        results as data; never decides a step's result itself (Claude and the checks did).

QA steps: a check in checklist.md names its journeys on a line `Journeys: a, b.`; a step in mcp-journey.json in
`journeys`; a journey names a job in `runs_in` (`<workflow>#<job>`, a workflow that runs on a push to staging, or one
that runs every night and takes no push: its journey is walked nightly, as a whole-bank task is) or gate bank tasks in
`bank` (the slice runs on a push, the whole bank nightly). Standard library only: the check runs before anything is
installed.
"""

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MIN_WAIVER = 40


def checklist_checks(text):
    """{check number: [journey ids]} from checklist.md's `## Checks` list."""
    checks = {}
    body = text.split("\n## Checks", 1)[-1].split("\n## ", 1)[0]
    for block in re.split(r"(?m)^(?=\d+\. \*\*)", body):
        start = re.match(r"(\d+)\. \*\*", block)
        if not start:
            continue
        named = re.search(r"(?m)^\s*Journeys:\s*([^\n]+?)\.?\s*$", block)
        checks[int(start.group(1))] = [j.strip() for j in named.group(1).split(",") if j.strip()] if named else []
    return checks


def workflow_jobs(path):
    """(job ids, whether a push to staging runs it, whether it runs every night) for a workflow file, read as text (no
    YAML parser needed)."""
    if not path.is_file():
        return set(), False, False
    text = path.read_text()
    jobs = set(re.findall(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", text.split("\njobs:", 1)[-1]))
    on = text.split("\njobs:", 1)[0]
    push = re.search(r"(?m)^  push:\s*\n\s+branches:\s*\[([^\]]*)\]", on)
    nightly = re.search(r"(?m)^  schedule:\s*\n\s+- cron:", on)
    return jobs, bool(push and re.search(r"\bstaging\b", push.group(1))), bool(nightly)


def bank_ids(root):
    bank = json.loads((root / "test-banks/gate/bank.json").read_text())
    tasks = bank["tasks"] if isinstance(bank, dict) else bank
    slice_ = json.loads((root / "test-banks/gate/slice.json").read_text())
    return {t["id"] for t in tasks}, set(slice_["ids"])


def coverage(root=ROOT, qa=None):
    """(rows, problems): one row per journey, with the QA steps that walk it."""
    qa = qa or root / ".github/qa"
    journeys = json.loads((qa / "journeys.json").read_text())["journeys"]
    checks = checklist_checks((qa / "checklist.md").read_text())
    steps = json.loads((qa / "mcp-journey.json").read_text())["steps"]
    in_bank, in_slice = bank_ids(root)
    problems = []
    ids = [j["id"] for j in journeys]
    known = set(ids)
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        problems.append(f"journey {dup} is listed twice")
    walks = {i: [] for i in ids}
    for n, named in sorted(checks.items()):
        if not named:
            problems.append(f"checklist.md check {n} names no journey (add a `Journeys:` line)")
        for j in named:
            if j in known:
                walks[j].append(f"check {n}")
            else:
                problems.append(f"checklist.md check {n} names journey {j}, which journeys.json doesn't have")
    for step in steps:
        named = step.get("journeys") or []
        if not named:
            problems.append(f"mcp-journey.json step {step['id']} names no journey")
        for j in named:
            if j in known:
                walks[j].append(f"mcp {step['id']}")
            else:
                problems.append(f"mcp-journey.json step {step['id']} names journey {j}, which journeys.json doesn't have")
    rows = []
    for j in journeys:
        jid = j["id"]
        for field in ("promise", "source", "surface"):
            if not j.get(field):
                problems.append(f"journey {jid} has no {field}")
        for ref in j.get("runs_in") or []:
            workflow, _, job = ref.partition("#")
            jobs, on_push, nightly = workflow_jobs(root / ".github/workflows" / workflow)
            if job not in jobs:
                problems.append(f"journey {jid}: {ref} names a job that doesn't exist")
            elif on_push:
                walks[jid].append(f"job {ref}")
            elif nightly:
                walks[jid].append(f"job {ref} (nightly)")
            else:
                problems.append(f"journey {jid}: {workflow} doesn't run on a push to staging, nor every night")
        nightly = []
        for task in j.get("bank") or []:
            if task not in in_bank:
                problems.append(f"journey {jid}: bank task {task} isn't in test-banks/gate/bank.json")
            elif task in in_slice:
                walks[jid].append(f"bank {task}")
            else:
                nightly.append(task)
                walks[jid].append(f"bank {task} (nightly)")
        waived = (j.get("waived") or "").strip()
        walked = [w for w in walks[jid]]
        if waived and walked:
            problems.append(f"journey {jid} is waived and also walked ({', '.join(walked)}): drop the waiver")
        elif waived and len(waived) < MIN_WAIVER:
            problems.append(f"journey {jid}: a waiver of {len(waived)} characters says too little to check (at least {MIN_WAIVER})")
        elif not waived and not walked:
            problems.append(f"journey {jid} has no QA step: name it in a checklist.md check, an mcp-journey.json step, runs_in or bank, or waive it with a reason")
        elif not waived and all(w.endswith("(nightly)") for w in walked):
            pass  # the whole bank walks it every night; the report says so
        rows.append({"id": jid, "surface": j.get("surface"), "promise": j.get("promise", ""), "picture": j.get("picture", ""),
                     "walked_by": walked, "waived": waived or None, "nightly_only": bool(walked) and all(w.endswith("(nightly)") for w in walked)})  # fmt: skip
    return rows, problems


def coverage_md(rows, problems):
    walked = sum(bool(r["walked_by"]) for r in rows)
    waived = sum(bool(r["waived"]) for r in rows)
    out = [f"**Journey coverage: {'pass' if not problems else 'fail'}.** {len(rows)} journeys in .github/qa/journeys.json: {walked} walked by a QA step, {waived} waived with a reason."]
    if problems:
        out += ["", *[f"- **{p}**" for p in problems]]
    out += ["", "| Journey | Surface | Walked by |", "| --- | --- | --- |"]
    for r in rows:
        by = ", ".join(r["walked_by"]) or f"waived: {r['waived']}"
        out.append(f"| {r['id']} | {r['surface']} | {by.replace('|', '/')} |")
    return "\n".join(out) + "\n"


def step_results(verdict, mcp, bank, jobs):
    """{'check 3': (result, note, picture)} for every QA step this run has a result for."""
    got = {}
    for c in (verdict or {}).get("checks") or []:
        try:
            n = int(c.get("n"))
        except (TypeError, ValueError):
            continue
        result = str(c.get("result") or "not run").lower()
        got[f"check {n}"] = (result if result in ("pass", "fail", "blocked", "not run") else "fail", str(c.get("note") or ""), f"check-{n:02d}.png")
    for s in (mcp or {}).get("steps") or []:
        if s.get("part") == "journey":
            got[f"mcp {s['id']}"] = ("pass" if s.get("pass") else "fail", "; ".join(s.get("problems") or []) or s.get("note", ""), s.get("shot"))
    for row in bank or []:
        outcome = row.get("outcome")
        result = {"right": "pass", "set_aside": "blocked", "infra": "blocked"}.get(outcome, "fail")
        got[f"bank {row.get('id')}"] = (result, outcome or "", None)
    for ref, conclusion in (jobs or {}).items():
        got[f"job {ref}"] = ({"success": "pass", "failure": "fail"}.get(conclusion, "not run"), conclusion, None)
    return got


def journey_report(rows, got):
    order = ("fail", "pass", "blocked", "not run", "nightly", "waived")
    tally = dict.fromkeys(order, 0)
    lines = []
    for r in rows:
        if r["waived"]:
            status, detail = "waived", r["waived"]
        else:
            cells, results = [], []
            for ref in r["walked_by"]:
                if ref.endswith("(nightly)"):
                    cells.append(f"{ref}: nightly")
                    results.append("nightly")
                    continue
                result, note, shot = got.get(ref, ("not run", "no result in this run", None))
                results.append(result)
                cells.append(f"{ref}: {result}" + (f" ({note[:80]})" if result != "pass" and note else "") + (f" [{shot}]" if shot else ""))
            status = next((s for s in order if s in results), "not run")
            if status == "nightly" and "pass" in results:
                status = "pass"
            detail = "; ".join(cells)
        tally[status] += 1
        mark = {"fail": "**fail**"}.get(status, status)
        lines.append(f"| {r['id']} | {r['surface']} | {mark} | {detail.replace('|', '/')[:600]} |")
    head = ", ".join(f"{n} {s}" for s, n in tally.items() if n)
    return "\n".join([f"**Journeys: {head}.** One row per journey in .github/qa/journeys.json; a journey fails when any QA step that walks it failed. Pictures are in the run's artifacts by the names in brackets.", "", "| Journey | Surface | Result | Steps (this run) |", "| --- | --- | --- | --- |", *lines]) + "\n", tally


def read_json(path):
    try:
        return json.loads(Path(path).read_text()) if path else None
    except (OSError, ValueError):
        return None


def read_jsonl(path):
    rows = {}
    try:
        for line in Path(path).read_text().splitlines() if path else []:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            rows[row.get("id")] = row  # the last line for a task wins, as run_gate.py reads it
    except OSError:
        return []
    return list(rows.values())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["check", "report"])
    parser.add_argument("--out", type=Path)
    parser.add_argument("--verdict")
    parser.add_argument("--mcp")
    parser.add_argument("--bank")
    parser.add_argument("--job", action="append", default=[], help="<workflow>#<job>=<conclusion>")
    args = parser.parse_args(argv)
    rows, problems = coverage()
    if args.mode == "check":
        md = coverage_md(rows, problems)
        if args.out:
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / "coverage.md").write_text(md)
            (args.out / "coverage.json").write_text(json.dumps({"pass": not problems, "problems": problems, "journeys": rows}, indent=1) + "\n")
        if problems:
            print("\n".join(problems))
            print(f"JOURNEYS_UNCOVERED problems={len(problems)}")
            return 1
        walked = sum(bool(r["walked_by"]) for r in rows)
        print(f"JOURNEYS_COVERED journeys={len(rows)} walked={walked} waived={len(rows) - walked}")
        return 0
    if not args.out:
        parser.error("report needs --out")
    jobs = dict(j.split("=", 1) for j in args.job if "=" in j)
    md, tally = journey_report(rows, step_results(read_json(args.verdict), read_json(args.mcp), read_jsonl(args.bank), jobs))
    if problems:
        md = "**Journey coverage failed:** " + "; ".join(problems) + "\n\n" + md
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "journeys.md").write_text(md)
    (args.out / "journeys.json").write_text(json.dumps({"tally": tally, "problems": problems}, indent=1) + "\n")
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
