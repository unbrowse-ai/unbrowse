#!/usr/bin/env python3
"""Re-apply the bench-local rubric to an existing results.jsonl.

Use this when you want to re-judge a past run without re-executing the
bench (bench runs cost minutes; triage is <100ms). Rubric lives in
CLAUDE.md under "bench-local"; this script is the deterministic
denominator calculator for "the agent judges in-thread".

Usage:
  python3 scripts/bench-local-triage.py .bench-local/results.jsonl
  python3 scripts/bench-local-triage.py .bench-evidence/v3.8.0-preview.3-candidates-20260411.csv
"""
import sys
import json
import csv
from collections import defaultdict
from pathlib import Path


def classify(row: dict) -> str:
    """First-match-wins rubric. Matches the logic in scripts/bench-local.sh.

    The harness is deterministic. The agent still reads rejected_samples
    and raw .out files in-thread when something sits on a boundary.
    """
    bs_raw = row.get("browser_block_signals") or ""
    has_ops = row.get("has_available_operations") in (True, "True", "true")
    n_ops = int(row.get("n_operations") or 0)
    trace_raw = row.get("trace_success")
    trace_ok = trace_raw in (True, "True", "true")
    src = row.get("source") or ""
    err = row.get("error_code") or ""

    # Parse the signals list if it's a JSON string from the CSV.
    bs = ""
    if isinstance(bs_raw, list):
        bs = ",".join(bs_raw)
    elif bs_raw and bs_raw != "[]":
        try:
            parsed = json.loads(bs_raw) if isinstance(bs_raw, str) else bs_raw
            if isinstance(parsed, list):
                bs = ",".join(parsed)
            else:
                bs = str(bs_raw)
        except Exception:
            bs = str(bs_raw)

    if bs and ("vendor:" in bs or "challenge_title" in bs or "no_html_many_apis" in bs):
        return "BROWSER_BLOCK"
    diag = row.get("capture_diagnostic") or ""
    if diag in ("no_endpoints_extracted", "all_endpoints_filtered_by_noise_rules"):
        return "BROWSER_BLOCK"
    # Empty row — no source, no trace, no ops. CLI never returned a
    # top-level response, almost always a clean timeout. Treat as block.
    if not src and trace_raw in (None, "None", "") and not has_ops:
        return "BROWSER_BLOCK"
    if err == "auth_required" or row.get("auth_recommended") in (True, "True", "true"):
        return "AUTH_GATED"
    if has_ops and n_ops > 0:
        return "PASS"
    if trace_ok and src == "dom-fallback":
        return "PASS"
    if trace_ok and src == "direct-fetch":
        return "PASS"
    if bs and "sparse_capture_mostly_noise" in bs:
        return "SPARSE_REVIEW"
    return "PRODUCT_FAIL"


def load(path: Path):
    if path.suffix == ".csv":
        return list(csv.DictReader(open(path)))
    # Default: JSONL
    return [json.loads(line) for line in open(path) if line.strip()]


def main():
    argv = sys.argv[1:]
    json_out = "--json" in argv
    argv = [a for a in argv if not a.startswith("--")]
    if len(argv) != 1:
        print("usage: bench-local-triage.py <results.jsonl|evidence.csv> [--json]", file=sys.stderr)
        sys.exit(2)
    path = Path(argv[0])
    rows = load(path)
    buckets = defaultdict(list)
    for r in rows:
        buckets[classify(r)].append(r)

    total = len(rows)
    passes = len(buckets["PASS"])
    blocked = len(buckets["BROWSER_BLOCK"]) + len(buckets["AUTH_GATED"])
    reachable = total - blocked

    if json_out:
        summary = {
            "total": total,
            "pass": passes,
            "product_fail": len(buckets["PRODUCT_FAIL"]),
            "sparse_review": len(buckets["SPARSE_REVIEW"]),
            "browser_block": len(buckets["BROWSER_BLOCK"]),
            "auth_gated": len(buckets["AUTH_GATED"]),
            "reachable": reachable,
            "raw_pass_rate": round(passes / total, 4) if total else 0,
            "product_reachable_pass_rate": round(passes / reachable, 4) if reachable else 0,
            "buckets": {k: [r.get("url") for r in v] for k, v in buckets.items()},
        }
        print(json.dumps(summary, indent=2))
        return

    print(f"\n=== bench-local triage: {path} ===\n")
    for k in ("PASS", "PRODUCT_FAIL", "SPARSE_REVIEW", "BROWSER_BLOCK", "AUTH_GATED"):
        items = buckets.get(k, [])
        if not items:
            continue
        print(f"{k:<15} {len(items):>3}")
        for r in items:
            url = r.get("url", "?")
            tag_bits = []
            if r.get("n_operations"):
                tag_bits.append(f"ops={r['n_operations']}")
            if r.get("source"):
                tag_bits.append(f"src={r['source']}")
            if r.get("error_code"):
                tag_bits.append(f"err={r['error_code']}")
            if r.get("browser_block_signals") and r["browser_block_signals"] not in ("", "[]"):
                tag_bits.append(f"signals={r['browser_block_signals']}")
            tag = " ".join(tag_bits)
            print(f"  - {url[:100]}  {tag}")
        print()

    print(f"raw pass: {passes}/{total} ({100*passes/total:.0f}%)")
    if reachable > 0:
        print(f"product-reachable pass: {passes}/{reachable} ({100*passes/reachable:.0f}%)")


if __name__ == "__main__":
    main()
