#!/usr/bin/env python3
"""Cross-reference bench-local results against inspect-page-signals ground truth.

Reads:
  .bench-local/results.jsonl      — live-capture outcomes from bench-local.sh
  <inspect_json_file>             — `inspect-page-signals.py - < urls.txt` dump

Emits per-URL lines grouped by delta class:

  EXTRACTION_GAP — inspect says data is there (spa_*, jsonld, label_values)
                    but bench has 0 ops or all dom-fallback-only.
  PRODUCT_WIN    — inspect says browser_block/thin_body but bench got real ops
                    (Kuri stealth bypassed the curl-level block).
  BLOCKED_BOTH   — curl blocked AND bench zero ops.
  CONFIRMED_PASS — inspect said data available, bench captured real ops.

Use this instead of staring at the bench output row by row. Lets the agent
immediately see which URLs are extraction regressions vs genuine blocks vs
wins. Harness collects, agent judges — this is the collector.
"""
import json
import sys


def load_rows(path: str) -> list[dict]:
    return [json.loads(line) for line in open(path) if line.strip()]


def load_inspect(path: str) -> dict[str, dict]:
    txt = open(path).read()
    decoder = json.JSONDecoder()
    out: dict[str, dict] = {}
    idx = 0
    n = len(txt)
    while idx < n:
        while idx < n and txt[idx] in " \n\r\t":
            idx += 1
        if idx >= n:
            break
        obj, end = decoder.raw_decode(txt, idx)
        idx = end
        if "url" in obj:
            out[obj["url"]] = obj
    return out


def classify(row: dict, inspect: dict) -> str:
    n_ops = int(row.get("n_operations") or 0)
    has_ops = row.get("has_available_operations") in (True, "True", "true")
    dom_fb = row.get("all_ops_dom_fallback") in (True, "True", "true")
    trace_ok = row.get("trace_success") in (True, "True", "true")
    src = row.get("source") or ""
    # Real data = ops captured AND not all dom-fallback.
    bench_has_data = has_ops and n_ops > 0 and not dom_fb
    # Dom-fallback path = source reported as dom-fallback OR all ops are page-artifacts.
    bench_dom_fallback = dom_fb or (trace_ok and src == "dom-fallback")
    bench_empty = (not has_ops or n_ops == 0) and not bench_dom_fallback
    verdict = (inspect or {}).get("verdict", "")

    inspect_has_data = any(
        verdict.startswith(p)
        for p in (
            "spa_present",
            "jsonld_present",
            "label_value_candidates",
            "og_meta_only",
            "no_structured_signals",
        )
    )
    inspect_blocked = verdict.startswith("browser_block") or verdict == "thin_body_no_data" or verdict == "fetch_failed"

    if inspect_blocked and bench_has_data:
        return "PRODUCT_WIN"
    if inspect_blocked and bench_dom_fallback:
        return "PRODUCT_WIN_DOM_FALLBACK"
    if inspect_blocked and bench_empty:
        return "BLOCKED_BOTH"
    if inspect_has_data and bench_empty:
        return "EXTRACTION_GAP"
    if inspect_has_data and bench_dom_fallback:
        return "DOM_FALLBACK_WHEN_REAL_AVAILABLE"
    if inspect_has_data and bench_has_data:
        return "CONFIRMED_PASS"
    return "UNKNOWN"


def main() -> None:
    argv = sys.argv[1:]
    results_path = ".bench-local/results.jsonl"
    inspect_path = None
    for a in argv:
        if a.endswith(".jsonl"):
            results_path = a
        elif a.endswith(".json"):
            inspect_path = a
    if not inspect_path:
        print("usage: bench-vs-inspect.py [results.jsonl] <inspect.json>", file=sys.stderr)
        sys.exit(2)

    rows = load_rows(results_path)
    inspect = load_inspect(inspect_path)

    from collections import defaultdict
    buckets: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    for r in rows:
        ins = inspect.get(r.get("url", ""), {})
        buckets[classify(r, ins)].append((r, ins))

    total = len(rows)
    print(f"\n=== bench-vs-inspect: {total} rows, {len(inspect)} inspect signals ===\n")

    for bucket in (
        "CONFIRMED_PASS",
        "PRODUCT_WIN",
        "PRODUCT_WIN_DOM_FALLBACK",
        "EXTRACTION_GAP",
        "DOM_FALLBACK_WHEN_REAL_AVAILABLE",
        "BLOCKED_BOTH",
        "UNKNOWN",
    ):
        items = buckets.get(bucket, [])
        if not items:
            continue
        print(f"{bucket}  ({len(items)})")
        for r, ins in items:
            url = r.get("url", "?")[:85]
            bench_bits = []
            if r.get("n_operations"):
                bench_bits.append(f"ops={r['n_operations']}")
            if r.get("all_ops_dom_fallback"):
                bench_bits.append("DOM_FB")
            if r.get("source"):
                bench_bits.append(f"src={r['source']}")
            bench = " ".join(bench_bits) or "empty"
            v = (ins or {}).get("verdict", "?")
            print(f"  {url}")
            print(f"    bench={bench}")
            print(f"    inspect={v}")
        print()

    # Top-line numbers
    product_reachable = sum(
        1 for b in (
            "CONFIRMED_PASS",
            "PRODUCT_WIN",
            "PRODUCT_WIN_DOM_FALLBACK",
            "EXTRACTION_GAP",
            "DOM_FALLBACK_WHEN_REAL_AVAILABLE",
        )
        for _ in buckets.get(b, [])
    )
    real_passes = len(buckets["CONFIRMED_PASS"]) + len(buckets["PRODUCT_WIN"])
    any_data = real_passes + len(buckets["PRODUCT_WIN_DOM_FALLBACK"]) + len(buckets["DOM_FALLBACK_WHEN_REAL_AVAILABLE"])
    print(f"reachable (data or extractable): {product_reachable}/{total}")
    print(f"real-api pass:                   {real_passes}/{total} ({100*real_passes/total:.0f}% of total)")
    print(f"any data returned (real+fb):     {any_data}/{total} ({100*any_data/total:.0f}% of total)")
    if product_reachable:
        print(f"real-api / reachable:            {real_passes}/{product_reachable} ({100*real_passes/product_reachable:.0f}%)")
        print(f"any data / reachable:            {any_data}/{product_reachable} ({100*any_data/product_reachable:.0f}%)")


if __name__ == "__main__":
    main()
