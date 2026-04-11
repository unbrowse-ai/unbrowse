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
    # SSR-embedded SPA data is real structured payload, not a dom fallback.
    # bench-local.sh writes all_ops_dom_fallback already accounting for
    # this exception, so we trust the row's pre-computed flag.

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

    REAL_BLOCK_VENDORS = ("vendor:cloudflare", "vendor:perimeterx", "vendor:datadome",
                          "vendor:akamai_bot_manager", "vendor:imperva_incapsula",
                          "vendor:shape_security", "vendor:kasada")
    has_real_vendor = bs and any(v in bs for v in REAL_BLOCK_VENDORS)
    if bs and ("challenge_title" in bs or "no_html_many_apis" in bs or "low_capture" in bs or "empty_capture" in bs or has_real_vendor):
        return "BROWSER_BLOCK"
    # captcha_vendor alone + thin text → still block
    try:
        text_bytes_for_cv = int(row.get("captured_text_bytes") or 0)
    except (ValueError, TypeError):
        text_bytes_for_cv = 0
    if bs and "vendor:captcha_vendor" in bs and text_bytes_for_cv < 2000:
        return "BROWSER_BLOCK"
    diag = row.get("capture_diagnostic") or ""
    if diag in ("no_endpoints_extracted", "all_endpoints_filtered_by_noise_rules"):
        return "BROWSER_BLOCK"
    if diag == "endpoints_scored_below_relevance_threshold":
        try:
            tec = int(row.get("total_endpoints_captured") or 0)
        except (ValueError, TypeError):
            tec = 0
        if tec <= 2:
            return "BROWSER_BLOCK"
    # Empty row — no source, no trace, no ops. CLI never returned a
    # top-level response, almost always a clean timeout. Treat as block.
    if not src and trace_raw in (None, "None", "") and not has_ops:
        return "BROWSER_BLOCK"
    # Explicit timeout marker from the harness. CLI was killed at the
    # bench-local TIMEOUT cap — usually a heavy JS-rendered page that the
    # browser is still settling. Classify as browser-block so it doesn't
    # inflate product_fail; re-running with a longer timeout may recover.
    if row.get("cli_timeout") in (True, "True", "true"):
        return "BROWSER_BLOCK"
    if err == "auth_required" or row.get("auth_recommended") in (True, "True", "true"):
        return "AUTH_GATED"
    if has_ops and n_ops > 0:
        # Distinguish real API captures from dom-fallback-only synthetic
        # "captured page artifact" endpoints. The rubric used to lie by
        # treating both as PASS; now dom-fallback-only gets its own bucket.
        if row.get("all_ops_dom_fallback") in (True, "True", "true"):
            return "PASS_DOM_FALLBACK_ONLY"
        return "PASS"
    if trace_ok and src == "dom-fallback":
        return "PASS_DOM_FALLBACK_ONLY"
    if trace_ok and src == "direct-fetch":
        return "PASS"
    if src == "browse-session":
        return "PASS"
    # Rich HTML content with no HARD block signals and no intent-mismatch.
    # sparse_capture_mostly_noise is OK — it means the API capture was
    # noisy, not that the HTML is missing. Observed on cheat.sh/tar:
    # 569KB HTML / 3.6KB text / 9 apis / sparse signal. The page IS the
    # data; agent can read it directly.
    try:
        text_bytes = int(row.get("captured_text_bytes") or 0)
    except (ValueError, TypeError):
        text_bytes = 0
    intent_verdict = row.get("captured_intent_verdict") or ""
    # captcha_vendor is often included defensively without blocking
    # (e.g. reCAPTCHA script present but page content loaded fine).
    # Other vendors (cloudflare/perimeterx/datadome/etc) actively block.
    REAL_BLOCK_VENDORS = ("vendor:cloudflare", "vendor:perimeterx", "vendor:datadome",
                          "vendor:akamai_bot_manager", "vendor:imperva_incapsula",
                          "vendor:shape_security", "vendor:kasada")
    hard_block = bs and (any(s in bs for s in ("challenge_title", "no_html_many_apis", "low_capture", "empty_capture"))
                          or any(v in bs for v in REAL_BLOCK_VENDORS))
    if not has_ops and not hard_block and text_bytes >= 2000 and intent_verdict != "fail":
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
    real_passes = len(buckets["PASS"])
    fallback_passes = len(buckets["PASS_DOM_FALLBACK_ONLY"])
    total_passes = real_passes + fallback_passes
    blocked = len(buckets["BROWSER_BLOCK"]) + len(buckets["AUTH_GATED"])
    reachable = total - blocked

    if json_out:
        summary = {
            "total": total,
            "pass_real_api": real_passes,
            "pass_dom_fallback_only": fallback_passes,
            "pass_total": total_passes,
            "product_fail": len(buckets["PRODUCT_FAIL"]),
            "sparse_review": len(buckets["SPARSE_REVIEW"]),
            "browser_block": len(buckets["BROWSER_BLOCK"]),
            "auth_gated": len(buckets["AUTH_GATED"]),
            "reachable": reachable,
            "real_api_rate": round(real_passes / reachable, 4) if reachable else 0,
            "dom_fallback_rate": round(fallback_passes / reachable, 4) if reachable else 0,
            "total_pass_rate": round(total_passes / reachable, 4) if reachable else 0,
            "buckets": {k: [r.get("url") for r in v] for k, v in buckets.items()},
        }
        print(json.dumps(summary, indent=2))
        return

    print(f"\n=== bench-local triage: {path} ===\n")
    for k in ("PASS", "PASS_DOM_FALLBACK_ONLY", "PRODUCT_FAIL", "SPARSE_REVIEW", "BROWSER_BLOCK", "AUTH_GATED"):
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

    print(f"raw pass (real+fallback): {total_passes}/{total} ({100*total_passes/total:.0f}%)")
    if reachable > 0:
        print(f"REAL-API pass:          {real_passes}/{reachable} ({100*real_passes/reachable:.0f}%)  — actual API endpoints captured")
        print(f"dom-fallback-only:      {fallback_passes}/{reachable} ({100*fallback_passes/reachable:.0f}%)  — page HTML returned, no real API")
        print(f"product-reachable total: {total_passes}/{reachable} ({100*total_passes/reachable:.0f}%)")


if __name__ == "__main__":
    main()
