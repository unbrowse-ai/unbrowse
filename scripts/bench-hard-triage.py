#!/usr/bin/env python3
"""bench-hard-triage.py — read .bench-history/runs.jsonl and emit a
routing recommendation per failing URL. The skeleton (Step 3 / baptism):
minimal viable slice — one row in, one routing line out, no auto-repair.

Usage:
  python3 scripts/bench-hard-triage.py                     # latest run only
  python3 scripts/bench-hard-triage.py --run RUN_ID        # specific run
  python3 scripts/bench-hard-triage.py --next              # one row only (next to fix)
  python3 scripts/bench-hard-triage.py --json              # JSON for agent ingestion

Output (text mode), one line per failure:
  <verdict> <url>  →  <route>  (<one-line evidence>)
    repair_cmd: bash harness/repair.sh ... (or DOM/SPA/AUTH note)
    re_bench:   bash scripts/bench-hard.sh --only-url '<url>' --note 'iter N'
"""
import argparse
import json
import os
import sys
from collections import OrderedDict


def load_rows(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def latest_per_url(rows, run_id=None):
    """Return one row per URL — the latest, optionally filtered by run_id."""
    if run_id:
        rows = [r for r in rows if r.get("run_id") == run_id]
    by_url = OrderedDict()
    for r in rows:
        by_url[r.get("url", "")] = r  # later rows overwrite earlier
    return list(by_url.values())


def route(row):
    """Pure function: row → (route_label, repair_cmd, evidence_oneline).
    Honest about unknowns: when evidence is silent, return UNKNOWN_NEEDS_HUMAN.
    """
    verdict = row.get("verdict") or "UNKNOWN"
    url = row.get("url", "")
    diag = row.get("capture_diagnostic") or ""
    bs_raw = row.get("browser_block_signals") or ""
    err = row.get("error_code") or ""
    n_ops = row.get("n_operations", 0) or 0
    src = row.get("source") or ""
    all_dom = row.get("all_ops_dom_fallback")
    n_capt = row.get("total_endpoints_captured") or ""
    fr_raw = row.get("filter_rejections") or ""

    # Non-failures are not for triage.
    if verdict in ("PASS", "PASS_WEAK"):
        return None
    if verdict == "PASS_DOM_FALLBACK_ONLY":
        return (
            "DOM_FALLBACK_PROMOTE",
            "bash harness/diagnose.sh --url '" + url + "' --focus extraction-spa",
            f"only synthetic page-as-endpoint captured (src={src}, n_ops={n_ops})",
        )

    # Honest blocks — not our bug.
    if verdict == "BROWSER_BLOCK":
        return (
            "ACCEPT_BLOCK",
            "(no repair — vendor-blocked or empty capture; mark in corpus)",
            f"block_signals={bs_raw[:80]} diag={diag}",
        )
    if verdict == "AUTH_GATED":
        return (
            "ACCEPT_AUTH",
            "(no repair — site requires auth; ensure profile/vault has cookies)",
            f"err={err}",
        )

    # PRODUCT_FAIL routing by capture_diagnostic when present.
    if diag == "no_endpoints_extracted":
        # Browser ran but extractor saw nothing — could be SPA-only / GraphQL POST / shadow APIs.
        return (
            "REPAIR_EXTRACTOR",
            "bash harness/diagnose.sh --url '" + url + "' --focus extraction",
            f"diag=no_endpoints_extracted, total_captured={n_capt}",
        )
    if diag == "all_endpoints_filtered_by_noise_rules":
        # Extractor saw endpoints; ranker filters killed everything.
        return (
            "REPAIR_FILTER_RELAX",
            "bash harness/diagnose.sh --url '" + url + "' --focus filter",
            f"diag=all_filtered, rejections={fr_raw[:120]}",
        )
    if diag == "endpoints_scored_below_relevance_threshold":
        return (
            "REPAIR_RANKER",
            "bash harness/diagnose.sh --url '" + url + "' --focus rank",
            f"diag=below_threshold, total_captured={n_capt}",
        )

    # PRODUCT_FAIL with no diagnostic but with browser signals — partial block.
    if bs_raw and bs_raw != "[]" and "sparse_capture" in bs_raw:
        return (
            "REPAIR_SPARSE_CAPTURE",
            "bash harness/diagnose.sh --url '" + url + "' --focus capture-coverage",
            f"sparse_capture: bs={bs_raw[:80]} err={err}",
        )

    # Honest unknown — evidence is silent. Don't fabricate a route.
    return (
        "UNKNOWN_NEEDS_HUMAN",
        "(probe by hand: unbrowse capture --url '" + url + "' --intent '" + (row.get('goal') or '') + "')",
        f"verdict={verdict} src={src} n_ops={n_ops} err={err} bs={bs_raw[:60]} diag={diag}",
    )


def latest_run_id(rows):
    rids = [r.get("run_id", "") for r in rows if r.get("run_id")]
    return max(rids) if rids else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", default=".bench-history/runs.jsonl")
    ap.add_argument("--run", default=None, help="restrict to one run_id; default = latest")
    ap.add_argument("--next", dest="next_only", action="store_true", help="emit only the first failing row")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.history):
        print(f"[triage] no history at {args.history}", file=sys.stderr)
        sys.exit(0)

    all_rows = load_rows(args.history)
    if not all_rows:
        print("[triage] history is empty", file=sys.stderr)
        sys.exit(0)

    target_run = args.run or latest_run_id(all_rows)
    rows = latest_per_url(all_rows, run_id=target_run)
    if not rows:
        print(f"[triage] no rows in run {target_run}", file=sys.stderr)
        sys.exit(0)

    failing = []
    for r in rows:
        result = route(r)
        if result is None:
            continue
        label, repair_cmd, evidence = result
        failing.append({
            "url": r.get("url", ""),
            "goal": r.get("goal", ""),
            "verdict": r.get("verdict"),
            "route": label,
            "repair_cmd": repair_cmd,
            "evidence": evidence,
            "re_bench": f"bash scripts/bench-hard.sh --only-url '{r.get('url','')}' --note 'post-{label.lower()}'",
        })

    if args.next_only and failing:
        # Prefer routes we can actually fix (not ACCEPT_BLOCK / ACCEPT_AUTH)
        actionable = [f for f in failing if not f["route"].startswith("ACCEPT_")]
        failing = [actionable[0]] if actionable else failing[:1]

    if args.json:
        print(json.dumps({"run_id": target_run, "failing": failing, "count": len(failing)}, indent=2))
        return

    print(f"[triage] run={target_run} failing={len(failing)}")
    for f in failing:
        print(f"\n  {f['verdict']:<25} {f['url']}")
        print(f"    route:      {f['route']}")
        print(f"    evidence:   {f['evidence']}")
        print(f"    repair_cmd: {f['repair_cmd']}")
        print(f"    re_bench:   {f['re_bench']}")


if __name__ == "__main__":
    main()
