"""The promotion gate (UNB-208): what staging must show before it is promoted to public.

  promotion_gate.py coverage --root . [--llvm PART=report.json ...] [--istanbul PART=coverage.json ...]
                             [--coveragepy PART=coverage.json ...] [--lcov PART=lcov.info ...]
                             [--exclusions docs/COVERAGE-EXCLUSIONS.md] [--commit SHA] --out summary.json [--md summary.md]
  promotion_gate.py check [--coverage summary.json] [--bank-results results.jsonl] [--bank test-banks/gate/bank.json]
                          [--baseline test-banks/gate/promoted.json] [--rereads test-banks/gate/rereads.json]
                          [--slice test-banks/gate/slice.json] [--coverage-only | --tasks-only] [--md verdict.md]
  promotion_gate.py record --bank-results results.jsonl --bank bank.json --build vX.Y.Z --out promoted.json
  promotion_gate.py ratchet --head summary.json [--base staging-summary.json ...] --diff pr.diff
                            [--lcov PART=lcov.info ...] [--istanbul PART=coverage.json ...] [--coveragepy PART=coverage.json ...]
                            [--exclusions docs/COVERAGE-EXCLUSIONS.md] [--root .] [--md ratchet.md]

`coverage` turns the coverage tools' reports into one summary: line coverage per part, the files behind it, and the
lines left out by the approved rows of docs/COVERAGE-EXCLUSIONS.md (nothing else is left out).

`check` prints one line per rule and ends with PROMOTION_OK or PROMOTION_REFUSED; it exits 1 when refused. It refuses:
  - a gated part (GATED_PARTS) under 90.00% line coverage, or not measured;
  - a bank task right on the last promoted build (promoted.json) that is not right now, until a person has re-read
    that site by hand and recorded what they found in rereads.json (AGENTS.md: "changed", not "regressed", until then);
  - any confidently wrong answer (the agent said "answered" and its judge found the check unmet), unless a hand re-read
    of that exact answer found the check at fault;
  - fewer tasks right than the last promotion had (the floor, which only rises);
  - a bank that did not finish (a task not run, or only run into an infrastructure failure);
  - no promoted baseline recorded at all.
A task the site blocked (set_aside) is counted apart and is never a pass; one that was right on the baseline and is
set aside now, or has left bank.json, is a regression, named. With --slice, only the slice's tasks are
read, against the slice's reference verdicts when promoted.json has none for them, and there is no floor: that is the
check a pull request gets.

`ratchet` is the check every pull request to staging gets, and it blocks the merge (Lewis, 18 Nov 2026: a hard block,
not a report). It refuses:
  - a gated part whose line coverage falls below staging's by RATCHET_TOLERANCE points or more, naming the files that
    have more lines unrun than on staging;
  - a gated part where the lines the pull request adds or changes are under 90% covered, naming each file and line;
  - a gated part not measured on the pull request, or on none of the staging runs given: UNMEASURED is a finding,
    never a pass; and a pull request whose diff did not reach the check. A run in which no line of a part ran (0/N)
    failed: it is UNMEASURED, on the pull request and on staging alike.
A part named with --not-reached is one coverage.yml left out because no file the pull request changes can reach it
(ci-scope.py): it is as staging has it, so it is neither UNMEASURED nor compared. If the diff does touch a counted
file of such a part, the table that left it out is wrong, and that is refused.
--base is staging's summaries, nearest first (coverage-base.sh fetches them); each part is compared with the lowest of
the first RATCHET_BASES that measured it, so a staging run that lost a job, or whose browser run had a Chrome the pull
request's did not, is not held against it. Staging is read with the pull request's exclusions, so a newly approved row is not a fall.

`record` writes the promoted.json a promotion leaves behind: every task's verdict and the pass count, which is the
next promotion's floor.

Standard library only: the release workflow runs this beside its signing keys, where nothing is installed.
"""
import argparse
import fnmatch
from fractions import Fraction
import gzip
import hashlib
import json
import os
import re
import sys
import time

THRESHOLD = 90.0
# A fall smaller than this many percentage points is not refused. Measured on 9 consecutive staging runs (18 Nov 2026),
# in files no commit touched, timing-dependent tests moved the node by up to 14 lines (once 127) and browser core by 4:
# 0.05 points is about 60 lines of the node and 5 of browser core, and under one line of either SDK, which never moved.
RATCHET_TOLERANCE = Fraction(5, 100)
# Each part is compared with the lowest of staging's last RATCHET_BASES runs that measured it, not only the newest:
# Chrome starts in about half of CI's browser runs, so the browser CLI reads 67.92% or 62.15% on the same code.
RATCHET_BASES = 5
# Part name -> its directory. The gated ones are the goal's: the Rust workspaces and both SDKs. The rest are measured
# and reported apart (the contracts, the Zig window), never gating.
PARTS = {
    "rust:unbrowse-node": "unbrowse-node/",
    "rust:browser-core": "unbrowse-node/crates/browser/",
    "rust:browser-cli": "unbrowse-browser/cli/",
    "sdk:typescript": "unbrowse-sdk/typescript/",
    "sdk:python": "unbrowse-sdk/python/",
    "settlement": "unbrowse-settlement/",
    "zig:window": "unbrowse-node/window/",
}
GATED_PARTS = ["rust:unbrowse-node", "rust:browser-core", "rust:browser-cli", "sdk:typescript", "sdk:python"]
DROPPED = re.compile(r"(^|/)(vendor|target|node_modules)/")
SETTLEMENT_SOURCES = "unbrowse-settlement/src/"


# ----------------------------------------------------------------------------------------------------- coverage


def load_exclusions(text):
    """Rows of the "## Approved" table: (glob, why, approval). A row with no approval is an error, never applied."""
    rows, in_table = [], False
    for line in text.splitlines():
        if line.startswith("## "):
            in_table = line.strip().lower() == "## approved"
            continue
        if not in_table or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3 or set(cells[0]) <= set("-: ") or cells[0].lower().startswith("path"):
            continue
        glob = cells[0].strip("`")
        if not cells[2]:
            raise ValueError(f"coverage exclusion {glob!r} has no approval: it is not applied, and the file is refused")
        rows.append((glob, cells[1], cells[2]))
    return rows


def _relative(path, root, part):
    path = path.replace("\\", "/")
    root = os.path.abspath(root).replace("\\", "/").rstrip("/") + "/"
    if path.startswith(root):
        return path[len(root):]
    if os.path.isabs(path):
        # A path from another machine's checkout (a CI runner): keep it from the part's directory on.
        at = path.find("/" + PARTS[part])
        return path[at + 1:] if at >= 0 else None
    return path if path.startswith(PARTS[part]) else PARTS[part] + path.lstrip("./")


def _read(kind, path):
    """Yield (file, lines_total, lines_covered) from one report."""
    with (gzip.open(path, "rt") if path.endswith(".gz") else open(path)) as f:
        if kind == "lcov":
            name, total, covered = None, 0, 0
            for line in f:
                line = line.strip()
                if line.startswith("SF:"):
                    name, total, covered = line[3:], 0, 0
                elif line.startswith("DA:"):
                    total += 1
                    covered += int(line[3:].split(",")[1]) > 0
                elif line == "end_of_record" and name:
                    yield name, total, covered
                    name = None
            return
        data = json.load(f)
    if kind == "llvm":
        for export in data["data"]:
            for entry in export["files"]:
                lines = entry["summary"]["lines"]
                yield entry["filename"], lines["count"], lines["covered"]
    elif kind == "istanbul":
        for name, entry in data.items():
            if name == "total":
                continue
            if "lines" in entry:  # json-summary
                yield name, entry["lines"]["total"], entry["lines"]["covered"]
            else:  # coverage-final: a line counts once, covered when any statement starting on it ran
                lines = {}
                for sid, loc in entry["statementMap"].items():
                    lines.setdefault(loc["start"]["line"], []).append(entry["s"][sid])
                yield name, len(lines), sum(1 for hits in lines.values() if max(hits) > 0)
    elif kind == "coveragepy":
        for name, entry in data["files"].items():
            yield name, entry["summary"]["num_statements"], entry["summary"]["covered_lines"]
    else:
        raise ValueError(f"unknown report kind {kind}")


def _sub(part, rel):
    if part != "rust:unbrowse-node":
        return None
    rest = rel[len(PARTS[part]):]
    if rest.startswith("crates/"):
        return rest.split("/")[1]
    return rest.split("/")[0]


def _pct(covered, total):
    return round(100.0 * covered / total, 2) if total else 0.0


def _in_part(rel, part):
    if rel is None or not rel.startswith(PARTS[part]) or DROPPED.search(rel[len(PARTS[part]):]):
        return False
    if part == "settlement" and not rel.startswith(SETTLEMENT_SOURCES):
        return False  # forge reports its tests and scripts too; the contracts are src/
    if part == "rust:unbrowse-node" and rel.startswith(PARTS["zig:window"]):
        return False
    return True


def _excluded_by(rel, exclusions):
    return next((g for g, _, _ in exclusions if fnmatch.fnmatch(rel, g)), None)


def _part_of(rel):
    return max((p for p, d in PARTS.items() if rel.startswith(d)), key=lambda p: len(PARTS[p]), default=None)


def summarise(inputs, root, exclusions, commit=""):
    files = {}
    for kind, part, path in inputs:
        for name, total, covered in _read(kind, path):
            rel = _relative(name, root, part)
            if _in_part(rel, part):
                files[rel] = [total, covered]
    summary = {"commit": commit, "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "threshold": THRESHOLD, "excluded": [], "files": files}
    return resummarise(summary, exclusions)


def resummarise(summary, exclusions):
    """The summary's per-part numbers rebuilt from its files, leaving out what an approved exclusion matches. The
    ratchet reads staging's summaries this way, with the pull request's exclusions, so both sides count alike."""
    files = {}
    excluded = {e["glob"]: [e["lines"], e["uncovered"]] for e in summary.get("excluded", [])}
    for rel, (total, covered) in summary.get("files", {}).items():
        glob = _excluded_by(rel, exclusions)
        if glob:
            excluded.setdefault(glob, [0, 0])
            excluded[glob][0] += total
            excluded[glob][1] += total - covered
            continue
        files[rel] = [total, covered]
    parts = {}
    for rel, (total, covered) in sorted(files.items()):
        part = _part_of(rel)
        if part is None:
            continue
        entry = parts.setdefault(part, {"covered": 0, "total": 0, "gated": part in GATED_PARTS})
        entry["covered"] += covered
        entry["total"] += total
        sub = _sub(part, rel)
        if sub:
            s = entry.setdefault("sub", {}).setdefault(sub, {"covered": 0, "total": 0})
            s["covered"] += covered
            s["total"] += total
    for entry in parts.values():
        entry["pct"] = _pct(entry["covered"], entry["total"])
        for s in entry.get("sub", {}).values():
            s["pct"] = _pct(s["covered"], s["total"])
    rust = [parts[p] for p in parts if p.startswith("rust:")]
    out = dict(summary)
    out.update({
        "parts": parts,
        "rust_all": {"covered": sum(p["covered"] for p in rust), "total": sum(p["total"] for p in rust)},
        "excluded": [{"glob": g, "lines": t, "uncovered": u} for g, (t, u) in sorted(excluded.items())],
        "unmeasured": sorted(p for p in PARTS if p not in parts),
        "files": files,
    })
    out["rust_all"]["pct"] = _pct(out["rust_all"]["covered"], out["rust_all"]["total"])
    return out


def coverage_markdown(summary, not_reached=()):
    rows = ["| Part | Lines covered / total | Line % | Gate |", "|---|---|---|---|"]
    for name in list(GATED_PARTS) + [p for p in PARTS if p not in GATED_PARTS]:
        p = summary["parts"].get(name)
        if not p and name in not_reached:
            rows.append(f"| {name} | — | not run | no changed file reaches it: as on staging |")
            continue
        if not p:
            rows.append(f"| {name} | — | UNMEASURED | {'refuses' if name in GATED_PARTS else 'reported apart'} |")
            continue
        gate = ("ok" if _meets(p) else "below 90%") if p["gated"] else "reported apart"
        rows.append(f"| {name} | {p['covered']} / {p['total']} | {p['pct']:.2f}% | {gate} |")
        for sub, s in sorted(p.get("sub", {}).items()):
            rows.append(f"| · {sub} | {s['covered']} / {s['total']} | {s['pct']:.2f}% | |")
    r = summary["rust_all"]
    rows.append(f"| Rust, all workspaces | {r['covered']} / {r['total']} | {r['pct']:.2f}% | |")
    if summary["excluded"]:
        rows.append("")
        rows.append("Left out by docs/COVERAGE-EXCLUSIONS.md: " + "; ".join(
            f"`{e['glob']}` ({e['lines']} lines)" for e in summary["excluded"]))
    return "\n".join(rows)


# ------------------------------------------------------------------------------------------------------ the ratchet


def parse_diff(text):
    """{path: lines} a pull request adds or changes: the new side's lines of `git diff --unified=0`. A deleted file
    has none."""
    changed, path, prev = {}, None, ""
    for line in text.splitlines():
        if line.startswith("+++ ") and prev.startswith("--- "):
            target = line[4:].strip().strip('"')
            path = target[2:] if target.startswith("b/") else None
        elif line.startswith("@@ ") and path:
            m = re.match(r"@@ -\S+ \+(\d+)(?:,(\d+))? @@", line)
            if m:
                start, count = int(m.group(1)), int(m.group(2) if m.group(2) is not None else 1)
                if count:
                    changed.setdefault(path, set()).update(range(start, start + count))
        prev = line
    return changed


def _read_lines(kind, path):
    """Yield (file, {line: ran}) from one report that has lines (llvm-cov's summary export has none: use its lcov)."""
    with (gzip.open(path, "rt") if path.endswith(".gz") else open(path)) as f:
        if kind == "lcov":
            name, hits = None, {}
            for line in f:
                line = line.strip()
                if line.startswith("SF:"):
                    name, hits = line[3:], {}
                elif line.startswith("DA:") and name:
                    n, count = line[3:].split(",")[:2]
                    hits[int(n)] = hits.get(int(n), False) or int(count) > 0
                elif line == "end_of_record" and name:
                    yield name, hits
                    name = None
            return
        data = json.load(f)
    if kind == "istanbul":
        for name, entry in data.items():
            if name == "total" or "statementMap" not in entry:
                continue
            hits = {}
            for sid, loc in entry["statementMap"].items():
                n = loc["start"]["line"]
                hits[n] = hits.get(n, False) or entry["s"][sid] > 0
            yield name, hits
    elif kind == "coveragepy":
        for name, entry in data["files"].items():
            hits = {n: False for n in entry.get("missing_lines", [])}
            hits.update({n: True for n in entry.get("executed_lines", [])})
            yield name, hits
    else:
        raise ValueError(f"a {kind} report has no lines for the ratchet; give the part's lcov report")


def diff_coverage(changed, inputs, root, exclusions):
    """{part: {covered, total, files: {file: {covered, total, missed}}}} over the lines a pull request adds or changes
    that the coverage tools can count (a comment or a blank line is not one). Excluded files are left out."""
    hits = {}
    for kind, part, path in inputs:
        for name, lines in _read_lines(kind, path):
            rel = _relative(name, root, part)
            if not _in_part(rel, part) or rel not in changed or _excluded_by(rel, exclusions):
                continue
            mine = hits.setdefault(rel, {})
            for n, ran in lines.items():
                mine[n] = mine.get(n, False) or ran
    out = {}
    for rel, lines in sorted(hits.items()):
        new = sorted(n for n in changed[rel] if n in lines)
        if not new:
            continue
        missed = [n for n in new if not lines[n]]
        entry = out.setdefault(_part_of(rel), {"covered": 0, "total": 0, "files": {}})
        entry["files"][rel] = {"covered": len(new) - len(missed), "total": len(new), "missed": missed}
        entry["covered"] += len(new) - len(missed)
        entry["total"] += len(new)
    return out


def _ranges(numbers):
    out, start = [], None
    for i, n in enumerate(numbers):
        if start is None:
            start = n
        if i + 1 == len(numbers) or numbers[i + 1] != n + 1:
            out.append(str(start) if start == n else f"{start}-{n}")
            start = None
    return ",".join(out)


def _fell(base, head):
    return (Fraction(base["covered"], base["total"]) - Fraction(head["covered"], head["total"])) * 100 \
        >= RATCHET_TOLERANCE


def _more_unrun(base_summary, head_summary, part, limit=10):
    grew = []
    for rel, (total, covered) in head_summary["files"].items():
        if _part_of(rel) != part:
            continue
        before = base_summary["files"].get(rel)
        more = (total - covered) - ((before[0] - before[1]) if before else 0)
        if more > 0:
            grew.append((-more, rel))
    if not grew:
        return "no file has more lines unrun than on staging: covered lines were removed"
    grew.sort()
    shown = ", ".join(f"{rel} (+{-more} unrun)" for more, rel in grew[:limit])
    return shown + (f" and {len(grew) - limit} more" if len(grew) > limit else "")


def touched_parts(changed, exclusions):
    """The gated parts whose counted files a diff touches."""
    out = set()
    for rel in changed:
        part = _part_of(rel)
        if part in GATED_PARTS and _in_part(rel, part) and not _excluded_by(rel, exclusions):
            out.add(part)
    return out


def _measured(p):
    # A run in which not one line of a part ran is a run that failed (the node read 0/N on #690, #691, #692 and #708),
    # not a measurement: it is never a pass, and never the floor staging is held to.
    return bool(p and p["total"] and p["covered"])


def ratchet(head, bases, new_lines, exclusions, unmeasured_new=(), not_reached=()):
    """(problems, lines): head is the pull request's summary (None when none reached the check), bases staging's,
    nearest first; new_lines diff_coverage's answer, or None when no diff reached the check; unmeasured_new the parts
    the diff touches that no line report reached; not_reached the parts left out of this run because no changed file
    can reach them."""
    head = resummarise(head, exclusions) if head else None
    bases = [resummarise(b, exclusions) for b in bases]
    problems = []
    lines = [f"coverage ratchet: pull request {(head or {}).get('commit', '')[:8] or 'UNMEASURED'} against the lowest "
             f"of staging's last {RATCHET_BASES} measured runs; a part may not fall {float(RATCHET_TOLERANCE):.2f} points "
             f"or more, and its new lines are {THRESHOLD:.0f}% covered"]
    for name in GATED_PARTS:
        h = head["parts"].get(name) if head else None
        h = h if _measured(h) else None
        measured = [b for b in bases if _measured(b["parts"].get(name))][:RATCHET_BASES]
        base_summary = min(measured, key=lambda b: Fraction(b["parts"][name]["covered"], b["parts"][name]["total"]),
                           default=None)
        b = base_summary["parts"][name] if base_summary else None
        n = (new_lines or {}).get(name)
        left_out = name in not_reached and not h
        row = f"  {name:20} " + (f"{h['pct']:6.2f}% {h['covered']}/{h['total']}" if h else
                                 "not run (no changed file reaches it)" if left_out else "UNMEASURED")
        row += "  staging " + (f"{b['pct']:6.2f}% ({base_summary.get('commit', '')[:8]})" if b else "UNMEASURED")
        row += "  new lines " + (f"{_pct(n['covered'], n['total']):.2f}% {n['covered']}/{n['total']}" if n else
                                 ("UNMEASURED" if new_lines is None or name in unmeasured_new else "none"))
        lines.append(row)
        if left_out:
            # Nothing of it changed, so nothing of it is compared. A diff that touches it all the same is caught
            # below: no line report reached the check for a part the diff touches.
            pass
        elif not h:
            problems.append(f"coverage ratchet: {name} UNMEASURED on this pull request (its coverage job failed, was "
                            f"skipped, wrote no report or ran no line): a part not measured is a finding, never a pass")
        elif not b:
            problems.append(f"coverage ratchet: {name} UNMEASURED on staging (none of the {len(bases)} staging "
                            f"summaries read measured it), so a fall cannot be ruled out")
        elif _fell(b, h):
            problems.append(f"coverage ratchet: {name} fell from {b['pct']:.2f}% ({b['covered']}/{b['total']}, staging "
                            f"{base_summary.get('commit', '')[:8]}) to {h['pct']:.2f}% ({h['covered']}/{h['total']}); "
                            f"{_more_unrun(base_summary, head, name)}")
        if name in unmeasured_new:
            problems.append(f"coverage ratchet: {name} lines this pull request adds or changes are UNMEASURED (no "
                            f"line report of that part reached the check)"
                            + (": it was left out as not reached, though the diff touches it" if left_out else ""))
        elif n and n["total"] and not _meets(n):
            short = sorted(((-len(f["missed"]), rel, f) for rel, f in n["files"].items() if f["missed"]))
            files = "; ".join(f"{rel} lines {_ranges(f['missed'])}" for _, rel, f in short[:10])
            more = f"; and {len(short) - 10} more files" if len(short) > 10 else ""
            problems.append(f"coverage ratchet: {name} lines this pull request adds or changes are "
                            f"{_pct(n['covered'], n['total']):.2f}% covered ({n['covered']}/{n['total']}), under "
                            f"{THRESHOLD:.0f}%; not run: {files}{more}")
    if new_lines is None:
        problems.append("coverage ratchet: the lines this pull request adds or changes are UNMEASURED (no diff reached "
                        "the check)")
    return problems, lines


# ------------------------------------------------------------------------------------------------------ the gate


def _meets(p):
    # Exact: 17999 of 20000 is 89.995%, under 90, whatever it rounds to.
    return p["total"] > 0 and p["covered"] * 100 >= THRESHOLD * p["total"]


def check_coverage(summary):
    problems = []
    for name in GATED_PARTS:
        p = summary["parts"].get(name)
        if not p:
            problems.append(f"code coverage: {name} UNMEASURED (no report reached the gate)")
        elif not _meets(p):
            problems.append(f"code coverage: {name} {p['pct']:.2f}% < {THRESHOLD:.0f}% "
                            f"({p['covered']}/{p['total']} lines)")
    return problems


def answer_sha(res):
    blob = json.dumps(res.get("answer"), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def load_results(path):
    out = {}
    with open(path) as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                out[r["id"]] = r  # the last line for a task wins: a rerun replaces it
    return out


def _reread(rereads, res):
    sha = answer_sha(res)
    for r in rereads:
        if r.get("id") == res["id"] and r.get("answer_sha") == sha:
            return r.get("finding")
    return None


def check_tasks(bank_ids, results, baseline, rereads, slice_mode=False):
    """Returns (problems, stats). results: id -> result (or a list, the last per id winning); baseline: promoted.json's
    shape."""
    if isinstance(results, list):
        results = {r["id"]: r for r in results}
    problems, stats = [], {"right": 0, "set_aside": 0, "confidently_wrong": 0, "honest_fail": 0, "error": 0,
                           "unfinished": 0, "not_run": 0, "changed": 0, "regressed": 0, "check_fault": 0}
    verdicts = baseline.get("verdicts") or {}
    if not verdicts and not slice_mode:
        problems.append("task baseline: none recorded (test-banks/gate/promoted.json). Run the full bank on the last "
                        "promoted build and record it (promotion_gate.py record) before the first promotion")
    not_run, wrong, changed, regressed = [], [], [], []
    # A task right on the baseline that the site now blocks, or that left the bank, answers nothing it answered before:
    # a regression, named, not a gap only the floor might notice. A slice reads a few tasks, so the rest are not dropped.
    blocked = []
    dropped = [] if slice_mode else sorted(t for t, v in verdicts.items() if v == "right" and t not in set(bank_ids))
    for tid in bank_ids:
        res = results.get(tid)
        if not res or res.get("outcome") == "infra":
            not_run.append(tid)
            continue
        out = res["outcome"]
        finding = _reread(rereads, res)
        if out == "confidently_wrong" and finding == "check_fault":
            stats["check_fault"] += 1
        elif out in stats:
            stats[out] += 1
        if out == "confidently_wrong" and finding != "check_fault":
            wrong.append(tid)
        if verdicts.get(tid) == "right" and out == "set_aside":
            blocked.append(tid)
        elif verdicts.get(tid) == "right" and out != "right":
            if finding == "regression" or finding == "confirmed_wrong":
                regressed.append(tid)
            elif finding not in ("not_a_regression", "check_fault"):
                changed.append(tid)
    stats["not_run"] = len(not_run)
    stats["changed"], stats["regressed"] = len(changed), len(regressed) + len(blocked) + len(dropped)
    if not_run:
        problems.append(f"task bank: {len(not_run)} of {len(bank_ids)} tasks not run or only hit infrastructure "
                        f"trouble: {', '.join(not_run[:12])}{' …' if len(not_run) > 12 else ''}")
    if wrong:
        problems.append(f"task bank: {len(wrong)} answer(s) confidently wrong (must be 0): {', '.join(wrong)}")
    if regressed:
        problems.append(f"task bank: {len(regressed)} task(s) right on {baseline.get('build') or 'the reference'} "
                        f"regressed (re-read by hand): {', '.join(regressed)}")
    if blocked:
        problems.append(f"task bank: {len(blocked)} task(s) right on {baseline.get('build') or 'the reference'} "
                        f"regressed: set aside now (the site blocked them): {', '.join(blocked)}")
    if dropped:
        problems.append(f"task bank: {len(dropped)} task(s) right on {baseline.get('build') or 'the reference'} "
                        f"regressed: missing from the bank (bank.json): {', '.join(dropped)}")
    if changed:
        problems.append(f"task bank: {len(changed)} task(s) right on {baseline.get('build') or 'the reference'} are not "
                        f"right now: changed, to be re-read by hand one site at a time (rereads.json): "
                        f"{', '.join(changed)}")
    floor = baseline.get("pass_count")
    if not slice_mode and floor is not None and stats["right"] < floor:
        problems.append(f"task bank: {stats['right']} right is below the floor of {floor} "
                        f"(the pass count of {baseline.get('build')})")
    return problems, stats


def _load_json(path, default=None):
    if not path or not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def cmd_check(a):
    lines, problems = [], []
    if not a.tasks_only:
        summary = _load_json(a.coverage)
        if summary is None:
            problems.append(f"code coverage: no summary at {a.coverage}: UNMEASURED")
        else:
            lines.append(f"code coverage (commit {summary.get('commit') or '?'}, {summary.get('measured_at')}):")
            for name in GATED_PARTS:
                p = summary["parts"].get(name)
                lines.append(f"  {name:20} " + (f"{p['pct']:6.2f}%  {p['covered']}/{p['total']}" if p
                                                 else "UNMEASURED"))
            for name in summary["parts"]:
                if name not in GATED_PARTS:
                    p = summary["parts"][name]
                    lines.append(f"  {name:20} {p['pct']:6.2f}%  {p['covered']}/{p['total']}  (reported apart)")
            problems += check_coverage(summary)
    if not a.coverage_only:
        bank_ids = [t["id"] for t in _load_json(a.bank)["tasks"]]
        baseline = _load_json(a.baseline, {}) or {}
        rereads = _load_json(a.rereads, []) or []
        if a.slice:
            sl = _load_json(a.slice)
            bank_ids = [i for i in bank_ids if i in set(sl["ids"])]
            known = baseline.get("verdicts") or {}
            if not any(i in known for i in bank_ids):
                baseline = {"build": sl.get("reference", {}).get("build"),
                            "verdicts": sl.get("reference", {}).get("verdicts", {})}
        results = load_results(a.bank_results) if a.bank_results and os.path.exists(a.bank_results) else {}
        tp, stats = check_tasks(bank_ids, results, baseline, rereads, slice_mode=bool(a.slice))
        problems += tp
        lines.append(f"task bank ({'slice of ' if a.slice else ''}{len(bank_ids)} tasks, baseline "
                     f"{baseline.get('build') or 'none'}, floor {baseline.get('pass_count')}):")
        lines.append("  " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in stats.items()))
    for line in lines:
        print(line)
    for p in problems:
        print(f"REFUSE {p}")
    verdict = f"PROMOTION_REFUSED: {len(problems)} rule(s) unmet" if problems else "PROMOTION_OK"
    print(verdict)
    if a.md:
        with open(a.md, "w") as f:
            f.write("```\n" + "\n".join(lines + [f"REFUSE {p}" for p in problems] + [verdict]) + "\n```\n")
    return 1 if problems else 0


def _inputs(a, kinds):
    inputs = []
    for kind in kinds:
        for spec in getattr(a, kind, None) or []:
            part, _, path = spec.partition("=")
            if part not in PARTS:
                raise SystemExit(f"unknown part {part}; parts: {', '.join(PARTS)}")
            if os.path.exists(path):
                inputs.append((kind, part, path))
            else:
                print(f"no report at {path}: {part} UNMEASURED", file=sys.stderr)
    return inputs


def _not_reached(a):
    parts = a.not_reached or []
    for part in parts:
        if part not in PARTS:
            raise SystemExit(f"unknown part {part}; parts: {', '.join(PARTS)}")
    return parts


def cmd_ratchet(a):
    head = _load_json(a.head)
    bases = [s for s in (_load_json(p) for p in a.base or []) if s]
    exclusions = load_exclusions(open(a.exclusions).read()) if a.exclusions else []
    new_lines, unmeasured_new = None, []
    if a.diff and os.path.exists(a.diff):
        with open(a.diff) as f:
            changed = parse_diff(f.read())
        inputs = _inputs(a, ("lcov", "istanbul", "coveragepy"))
        new_lines = diff_coverage(changed, inputs, a.root, exclusions)
        unmeasured_new = sorted(touched_parts(changed, exclusions) - {part for _, part, _ in inputs})
    problems, lines = ratchet(head, bases, new_lines, exclusions, unmeasured_new, _not_reached(a))
    verdict = f"RATCHET_REFUSED: {len(problems)} rule(s) unmet" if problems else "RATCHET_OK"
    out = lines + [f"REFUSE {p}" for p in problems] + [verdict]
    print("\n".join(out))
    if a.md:
        with open(a.md, "w") as f:
            f.write("```\n" + "\n".join(out) + "\n```\n")
    return 1 if problems else 0


def cmd_coverage(a):
    inputs = _inputs(a, ("llvm", "istanbul", "coveragepy", "lcov"))
    exclusions = load_exclusions(open(a.exclusions).read()) if a.exclusions else []
    summary = summarise(inputs, a.root, exclusions, commit=a.commit or "")
    with open(a.out, "w") as f:
        json.dump(summary, f, indent=1, sort_keys=True)
    md = coverage_markdown(summary, _not_reached(a))
    print(md)
    if a.md:
        with open(a.md, "w") as f:
            f.write(md + "\n")
    return 0


def cmd_record(a):
    bank_ids = [t["id"] for t in _load_json(a.bank)["tasks"]]
    results = load_results(a.bank_results)
    verdicts = {i: results[i]["outcome"] for i in bank_ids if i in results}
    record = {"build": a.build, "recorded": time.strftime("%Y-%m-%d", time.gmtime()),
              "pass_count": sum(v == "right" for v in verdicts.values()), "verdicts": verdicts}
    with open(a.out, "w") as f:
        json.dump(record, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"recorded {a.build}: {record['pass_count']} right of {len(bank_ids)}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("coverage")
    c.add_argument("--root", default=".")
    for kind in ("llvm", "istanbul", "coveragepy", "lcov"):
        c.add_argument(f"--{kind}", action="append", metavar="PART=PATH")
    c.add_argument("--exclusions")
    c.add_argument("--not-reached", action="append", metavar="PART")
    c.add_argument("--commit")
    c.add_argument("--out", required=True)
    c.add_argument("--md")
    k = sub.add_parser("check")
    k.add_argument("--coverage")
    k.add_argument("--bank", default="test-banks/gate/bank.json")
    k.add_argument("--bank-results")
    k.add_argument("--baseline", default="test-banks/gate/promoted.json")
    k.add_argument("--rereads", default="test-banks/gate/rereads.json")
    k.add_argument("--slice")
    k.add_argument("--coverage-only", action="store_true")
    k.add_argument("--tasks-only", action="store_true")
    k.add_argument("--md")
    r = sub.add_parser("record")
    r.add_argument("--bank", default="test-banks/gate/bank.json")
    r.add_argument("--bank-results", required=True)
    r.add_argument("--build", required=True)
    r.add_argument("--out", required=True)
    t = sub.add_parser("ratchet")
    t.add_argument("--root", default=".")
    t.add_argument("--head", required=True)
    t.add_argument("--base", action="append", metavar="SUMMARY")
    t.add_argument("--diff")
    for kind in ("lcov", "istanbul", "coveragepy"):
        t.add_argument(f"--{kind}", action="append", metavar="PART=PATH")
    t.add_argument("--exclusions")
    t.add_argument("--not-reached", action="append", metavar="PART")
    t.add_argument("--md")
    a = ap.parse_args(argv)
    return {"coverage": cmd_coverage, "check": cmd_check, "record": cmd_record, "ratchet": cmd_ratchet}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
