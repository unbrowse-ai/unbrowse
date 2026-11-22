"""Behaviour coverage: which lines of the node's serving path the behaviour tests run, and nothing else's.

  behaviour_coverage.py --config .github/behaviour.json --lcov behaviour.lcov [--log behaviour.log] [--diff pr.diff]
                        [--root .] [--out behaviour.json] [--md behaviour.md]

Line coverage of the whole test suite says a line ran under some test. It does not say any test checked what an agent
gets back once that line ran: on 17 Nov 2026 #574 changed how a route's second value is served, every changed line was
covered by unit tests, and on 18 Nov the nightly Bank saw nasa.gov, pexels.com, mayoclinic.org and accuweather.com walk
the site again for their second value and keep a new route. So this measures the behaviour suite alone: the tests that
ask the node through the agent's own door (`do_goal`, as `unbrowse_do` does) against a site and assert the reply.

The config names the suite (`tests`, cargo test names, run with --exact) and the serving path (`paths`, globs from the
repository root). The job runs only those tests under llvm-cov and gives this script their lcov. It refuses:
  - a run where no line of the serving path ran, or no report reached it: UNMEASURED is a finding, never a pass;
  - a listed test the log does not show passing (with --log): a test that stopped running is a hole, not a pass;
  - a pull request whose added or changed lines on the serving path are under `changed_floor` percent run by the
    behaviour suite (with --diff), naming each file and line: a change to how an agent is answered comes with a test
    that asks as an agent does.
Lines of a file's in-file unit tests (from `#[cfg(test)]` before `mod` to the end) are left out: they are tests, not
the path. Whole-file numbers are reported, never refused.

Standard library only, as promotion_gate.py is.
"""
import argparse
import fnmatch
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from promotion_gate import parse_diff, _read_lines, _ranges  # noqa: E402

TEST_MODULE = re.compile(r"^\s*#\[cfg\(test\)\]\s*$")
MOD_LINE = re.compile(r"^\s*(pub(\([^)]*\))?\s+)?mod\s+\w+")


def test_module_start(text):
    """The 1-based line where a file's in-file unit tests begin (`#[cfg(test)]` followed by a `mod`), or None."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if TEST_MODULE.match(line):
            nxt = next((l for l in lines[i + 1:] if l.strip() and not l.strip().startswith("#[")), "")
            if MOD_LINE.match(nxt):
                return i + 1
    return None


def relative(name, root):
    name = name.replace("\\", "/")
    root = os.path.abspath(root).replace("\\", "/").rstrip("/") + "/"
    if name.startswith(root):
        return name[len(root):]
    # A path from a CI runner's checkout: keep it from the repository's own top folder on.
    m = re.search(r"/(unbrowse-node/.*)$", name)
    return m.group(1) if m else name.lstrip("./")


def on_path(rel, paths):
    return any(fnmatch.fnmatch(rel, p) for p in paths)


def read_lcov(path, root, paths):
    """{file: {line: ran}} for the serving path's files in one lcov report, in-file test modules left out."""
    out = {}
    for name, hits in _read_lines("lcov", path):
        rel = relative(name, root)
        if not on_path(rel, paths):
            continue
        mine = out.setdefault(rel, {})
        for n, ran in hits.items():
            mine[n] = mine.get(n, False) or ran
    for rel, hits in out.items():
        src = os.path.join(root, rel)
        start = test_module_start(open(src).read()) if os.path.exists(src) else None
        if start:
            for n in [n for n in hits if n >= start]:
                del hits[n]
    return out


def passed_tests(log_text):
    return set(re.findall(r"^test (\S+) \.\.\. ok$", log_text, re.M))


def judge(config, hits, root, log_text=None, changed=None):
    """(problems, report): report holds the per-file numbers and, with a diff, the changed lines' numbers."""
    problems, paths, floor = [], config["paths"], float(config.get("changed_floor", 0))
    files = {}
    for pattern in paths:
        if not glob.glob(os.path.join(root, pattern)):
            problems.append(f"the serving path names {pattern}, which no file matches: the config is out of date")
    for rel, lines in sorted(hits.items()):
        total, covered = len(lines), sum(1 for ran in lines.values() if ran)
        files[rel] = {"covered": covered, "total": total}
    covered = sum(f["covered"] for f in files.values())
    total = sum(f["total"] for f in files.values())
    if not total or not covered:
        problems.append(f"UNMEASURED: {covered} of {total} serving-path lines ran under the behaviour suite")
    if log_text is not None:
        ran = passed_tests(log_text)
        for name in config["tests"]:
            if name not in ran:
                problems.append(f"the behaviour test {name} did not pass in this run (failed, renamed or gone)")
    report = {"covered": covered, "total": total, "files": files, "changed": None, "floor": floor}
    if changed is not None:
        new = {"covered": 0, "total": 0, "files": {}}
        for rel, numbers in sorted(changed.items()):
            if not on_path(rel, paths) or rel not in hits:
                continue
            counted = sorted(n for n in numbers if n in hits[rel])
            if not counted:
                continue
            missed = [n for n in counted if not hits[rel][n]]
            new["files"][rel] = {"covered": len(counted) - len(missed), "total": len(counted), "missed": missed}
            new["covered"] += len(counted) - len(missed)
            new["total"] += len(counted)
        report["changed"] = new
        if new["total"] and 100.0 * new["covered"] / new["total"] < floor:
            where = "; ".join(f"{rel}: {_ranges(f['missed'])}" for rel, f in new["files"].items() if f["missed"])
            problems.append(f"{new['covered']} of {new['total']} serving-path lines this change adds or changes ran under "
                            f"the behaviour suite, under {floor:g}%: not run by any behaviour test: {where}")
    return problems, report


def pct(c, t):
    return f"{100.0 * c / t:.2f}%" if t else "UNMEASURED"


def markdown(report, problems):
    rows = ["| Serving-path file | Lines the behaviour suite ran | |", "|---|---|---|"]
    for rel, f in report["files"].items():
        rows.append(f"| `{rel}` | {f['covered']} / {f['total']} | {pct(f['covered'], f['total'])} |")
    rows.append(f"| **all** | **{report['covered']} / {report['total']}** | **{pct(report['covered'], report['total'])}** |")
    ch = report["changed"]
    if ch is not None:
        rows += ["", f"Lines this change adds or changes on the serving path, run by the behaviour suite: "
                     f"{ch['covered']} / {ch['total']} ({pct(ch['covered'], ch['total'])}; floor {report['floor']:g}%)."]
    rows += [""] + [f"REFUSE {p}" for p in problems]
    rows.append(f"BEHAVIOUR_REFUSED: {len(problems)} rule(s) unmet" if problems else "BEHAVIOUR_OK")
    return "\n".join(rows)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", required=True)
    ap.add_argument("--lcov", required=True)
    ap.add_argument("--log")
    ap.add_argument("--diff")
    ap.add_argument("--root", default=".")
    ap.add_argument("--out")
    ap.add_argument("--md")
    a = ap.parse_args(argv)
    config = json.load(open(a.config))
    hits = read_lcov(a.lcov, a.root, config["paths"]) if os.path.exists(a.lcov) else {}
    log_text = open(a.log).read() if a.log and os.path.exists(a.log) else (None if not a.log else "")
    changed = parse_diff(open(a.diff).read()) if a.diff and os.path.exists(a.diff) else None
    problems, report = judge(config, hits, a.root, log_text, changed)
    md = markdown(report, problems)
    print(md)
    if a.md:
        open(a.md, "w").write(md + "\n")
    if a.out:
        json.dump({**report, "problems": problems}, open(a.out, "w"), indent=1, sort_keys=True)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
