"""Staging's live-site check on the 30 hardest sites (UNB-249).

    hard_sites.py shard  --list staging-hard-sites.json --shard 3 --of 10
        the sites one parallel job reads, comma-separated (every site lands in exactly one shard)
    hard_sites.py report --list staging-hard-sites.json --reads <dir> [--md out.md] [--json out.json]
        each site sorted into right, wrong, needs a browser, walled or unknown, from the reads files run_bank.py wrote
        (reads-*.json) and the seconds each site took (times-*.jsonl), all found under <dir>

run_bank.py reads each answer by its rule; this file only sorts its verdicts, it decides no answer itself. Exit 1 only when
no site has a record at all (the check did not run); a site that answers wrong is a finding to read, not a failed run.
"""

import argparse
import json
import sys
from pathlib import Path

import run_bank

LABELS = ("right", "wrong", "needs a browser", "walled", "unknown")


def cases(path):
    return json.loads(Path(path).read_text())["cases"]


def shard(sites, index, count):
    """Round robin, in the list's order: the list mixes slow and quick sites, so no shard gets all the slow ones."""
    if not 0 <= index < count:
        raise SystemExit(f"shard {index} is not one of 0..{count - 1}")
    return [s for n, s in enumerate(sites) if n % count == index]


def label(record, skipped=None):
    """(label, why) for one site. `record` is run_bank.py's entry for it, `skipped` its skipped[] entry."""
    if record is None:
        if skipped and skipped.get("why") == "a_wall_on_this_domain":
            return "walled", "a sibling on its domain met a wall in this run"
        if skipped and skipped.get("why") == "capped":
            return "unknown", f"stopped at the per-site time cap ({skipped['seconds']} s) before its checks were written"
        return "unknown", "no record: its job stopped before it"
    checks = record.get("checks") or []
    outcome = run_bank.judge_site(checks, retried=bool(record.get("retried_timeout")))
    stopped = record.get("stopped")
    whys = sorted({c["why"] for c in checks if c.get("why")})
    said = ", ".join(f"{c['step']}: {c.get('outcome', 'not_tested')}" + (f" ({c['why']})" if c.get("why") else "") for c in checks)
    if outcome in ("blocked", "requires_account") or stopped in ("blocked", "rate_limited"):
        return "walled", said or str(stopped)
    if outcome == "safety_stop" or all(c.get("outcome", "not_tested") == "not_tested" for c in checks):
        return "unknown", said or f"nothing asked ({stopped or 'no checks'})"
    if outcome.startswith("pass"):
        if record.get("warm_in_browser") or outcome == "pass_after_hands":
            return "needs a browser", "right, but the node's browser ran " + ", ".join(record.get("warm_in_browser") or ["a person's hands"])
        return "right", said
    if "needs_hands" in whys:
        return "needs a browser", said
    if stopped == "timeout":
        return "unknown", "timed out: " + said
    # A check scored on a reply that said the node was still working (how: working) scored no answer: run_bank.py collects
    # it by its ask, and when even that ran out, no answer came back to read. Only a site with nothing else wrong is unknown.
    failed = [c for c in checks if not str(c.get("outcome", "not_tested")).startswith("pass") and c.get("outcome", "not_tested") != "not_tested"]
    if failed and all(c.get("how") == "working" for c in failed):
        return "unknown", "the node was still working and no answer came back: " + said
    if outcome in ("ok_but_wrong", "false_failure", "fail"):
        return "wrong", said
    return "unknown", said or outcome


def gather(reads_dir):
    """The last record of each site and each skipped[] entry across every reads-*.json under the folder, and the seconds
    each site took from times-*.jsonl."""
    records, skipped, seconds = {}, {}, {}
    for path in sorted(Path(reads_dir).rglob("reads-*.json")):
        doc = json.loads(path.read_text())
        for entry in doc.get("skipped", []):
            skipped[entry["site"]] = entry
        for entry in doc.get("sites", []):
            records[entry["site"]] = entry
    for path in sorted(Path(reads_dir).rglob("times-*.jsonl")):
        for line in path.read_text().splitlines():
            if line.strip():
                t = json.loads(line)
                seconds[t["site"]] = t["seconds"]
                if t.get("capped") and t["site"] not in records:
                    skipped.setdefault(t["site"], {"site": t["site"], "why": "capped", "seconds": t["seconds"]})
    return records, skipped, seconds


def report(listed, records, skipped, seconds):
    rows = []
    for case in listed:
        name = case["site"]
        verdict, why = label(records.get(name), skipped.get(name))
        record = records.get(name) or {}
        rows.append({
            "site": name, "label": verdict, "why": why, "gate": (case.get("hard") or {}).get("gate") or case.get("kind", "search"),
            "outcome": run_bank.judge_site(record.get("checks") or []) if record else None,
            "checks": {c["step"]: c.get("outcome", "not_tested") for c in record.get("checks") or []},
            "warm_in_browser": record.get("warm_in_browser") or [], "seconds": seconds.get(name),
        })
    counts = {k: sum(r["label"] == k for r in rows) for k in LABELS}
    return {"sites": len(rows), "counts": counts, "rows": rows}


def markdown(result):
    c = result["counts"]
    lines = [f"**Hard sites: {c['right']} right, {c['wrong']} wrong, {c['needs a browser']} need a browser, {c['walled']} walled, "
             f"{c['unknown']} unknown, of {result['sites']}.**", "", "| site | verdict | wall | checks | s |", "|---|---|---|---|---|"]
    order = {k: n for n, k in enumerate(LABELS)}
    for r in sorted(result["rows"], key=lambda r: (order[r["label"]], r["site"])):
        why = r["why"].replace("|", "/")[:220]
        lines.append(f"| {r['site']} | {r['label']} | {r['gate']} | {why} | {r['seconds'] if r['seconds'] is not None else ''} |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    s = commands.add_parser("shard")
    s.add_argument("--list", required=True)
    s.add_argument("--shard", type=int, required=True)
    s.add_argument("--of", type=int, required=True)
    r = commands.add_parser("report")
    r.add_argument("--list", required=True)
    r.add_argument("--reads", required=True)
    r.add_argument("--md")
    r.add_argument("--json")
    args = parser.parse_args(argv)
    listed = cases(args.list)
    if args.command == "shard":
        print(",".join(shard([c["site"] for c in listed], args.shard, args.of)))
        return 0
    result = report(listed, *gather(args.reads))
    text = markdown(result)
    print(text)
    if args.md:
        Path(args.md).write_text(text)
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1) + "\n")
    return 0 if any(r["checks"] for r in result["rows"]) else 1


if __name__ == "__main__":
    sys.exit(main())
