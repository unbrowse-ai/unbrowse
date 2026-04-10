#!/usr/bin/env python3
"""Promote PASS rows from a bench-local run into benchmark-baseline.txt.

The self-extending corpus primitive: every time you run bench-local
against a candidates file, the URLs that land in PASS (via the same
rubric as bench-local.sh + bench-local-triage.py) get appended to the
baseline corpus. BROWSER_BLOCK, SPARSE_REVIEW, and PRODUCT_FAIL rows
are skipped — they aren't promotion-worthy until investigated.

Dedup is by `goal|url` line so re-running doesn't create duplicates.

Usage:
  python3 scripts/bench-local-promote.py .bench-local/results.jsonl
  python3 scripts/bench-local-promote.py .bench-local/results.jsonl --dry-run
"""
import sys
import json
from pathlib import Path

HERE = Path(__file__).parent


def classify(row: dict) -> str:
    """First-match-wins rubric — must match scripts/bench-local-triage.py
    and the grouping in scripts/bench-local.sh. Documented in CLAUDE.md."""
    bs_raw = row.get("browser_block_signals") or ""
    has_ops = row.get("has_available_operations") in (True, "True", "true")
    n_ops = int(row.get("n_operations") or 0)
    trace_ok = row.get("trace_success") in (True, "True", "true")
    src = row.get("source") or ""
    err = row.get("error_code") or ""
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
    if err == "auth_required":
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


def main():
    argv = sys.argv[1:]
    dry_run = "--dry-run" in argv
    argv = [a for a in argv if not a.startswith("--")]
    if len(argv) != 1:
        print("usage: bench-local-promote.py <results.jsonl> [--dry-run]", file=sys.stderr)
        sys.exit(2)
    src = Path(argv[0])
    baseline = HERE.parent / "scripts" / "corpus" / "benchmark-baseline.txt"

    rows = [json.loads(line) for line in open(src) if line.strip()]
    existing = set()
    if baseline.exists():
        for line in open(baseline):
            line = line.strip()
            if line:
                existing.add(line)

    added = []
    skipped_already = 0
    skipped_not_pass = 0
    for r in rows:
        bucket = classify(r)
        if bucket != "PASS":
            skipped_not_pass += 1
            continue
        goal = r.get("goal", "").strip()
        url = r.get("url", "").strip()
        if not goal or not url:
            continue
        line = f"{goal}|{url}"
        if line in existing:
            skipped_already += 1
            continue
        added.append(line)
        existing.add(line)

    if not added:
        print(f"[promote] nothing to add (skipped: {skipped_already} duplicates, {skipped_not_pass} non-pass)")
        return
    if dry_run:
        print(f"[promote] --dry-run: would add {len(added)} lines:")
        for line in added:
            print(f"  {line}")
        return
    with open(baseline, "a") as f:
        for line in added:
            f.write(line + "\n")
    print(f"[promote] added {len(added)} new URLs to {baseline}")
    for line in added:
        print(f"  + {line}")
    if skipped_already or skipped_not_pass:
        print(f"[promote] skipped: {skipped_already} duplicates, {skipped_not_pass} non-pass")


if __name__ == "__main__":
    main()
