#!/usr/bin/env python3
"""Suggest the next primitive to build based on observed gaps.

Reads:
  .bench-local/results.jsonl   — rows with row.verdict
  .bench-local/inspect.jsonl   — inspect ground-truth rows

Per URL where the bench verdict is NOT PASS/PASS_WEAK, emits a
concrete suggestion for what to fix/build next. The suggestion is
derived from the inspect signals — if __NEXT_DATA__ is present past
truncation, suggest the extraction fix; if cloudflare_challenge, flag
as legit browser-block; if jsonld_present with low relevance, suggest
JSON-LD type handler; etc.

This is the harness-harness speaking to the agent: "look at what I
saw, these are the gaps, here's a first guess at what to build."

Usage:
  python3 scripts/gap-analyzer.py
  python3 scripts/gap-analyzer.py --only extraction
  python3 scripts/gap-analyzer.py --json

Output: one suggestion per failing URL, grouped by suggestion kind.
"""
import json
import os
import sys
from collections import defaultdict


def load_jsonl(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    return [json.loads(line) for line in open(path) if line.strip()]


def inspect_by_url(rows: list[dict]) -> dict[str, dict]:
    return {r.get("url", ""): r for r in rows if "url" in r}


def suggest_for_row(row: dict, inspect: dict) -> dict:
    """Return a suggestion dict: { kind, action, rationale, priority }."""
    bench_verdict = row.get("verdict") or ""
    url = row.get("url", "")
    insp = inspect or {}
    insp_verdict = insp.get("verdict", "")
    spa = insp.get("spa_markers") or {}

    # 1. SPA present past truncation → already fixed but validate the fix
    if insp_verdict.startswith("spa_present_past_truncation"):
        return {
            "kind": "validate_existing_fix",
            "action": "re-run --force-capture with cache cleared",
            "rationale": f"inspect saw {insp_verdict} — MAX_HTML_SIZE fix should handle it",
            "priority": "low",
        }

    # 2. SPA present, bench dom-fallback → intent scorer or unwrap issue
    if insp_verdict.startswith("spa_present") and bench_verdict == "PASS_DOM_FALLBACK_ONLY":
        hint = ""
        for name, info in spa.items():
            if info.get("parse_ok") and info.get("page_props_keys"):
                keys = info["page_props_keys"]
                if "dehydratedState" in keys:
                    hint = "React Query dehydratedState unwrap should fire — check data.queries[0] has intent-matching content"
                elif "apolloState" in keys or "__APOLLO_STATE__" in keys:
                    hint = "Apollo state present — may need cache-key-aware extraction"
                else:
                    hint = f"pageProps keys: {keys[:5]} — custom unwrap may be needed"
        return {
            "kind": "extraction",
            "action": "refine SPA unwrap or intent scorer",
            "rationale": f"inspect saw {insp_verdict}; bench chose DOM despite SPA data. {hint}",
            "priority": "medium",
        }

    # 3. JSON-LD present but bench missed it
    if insp_verdict == "jsonld_present" and bench_verdict in ("PASS_DOM_FALLBACK_ONLY", "PRODUCT_FAIL"):
        types = insp.get("jsonld_types") or []
        return {
            "kind": "extraction",
            "action": f"audit JSON-LD handler for types: {types}",
            "rationale": f"inspect found JSON-LD {types}, bench didn't use them",
            "priority": "medium",
        }

    # 4. Cloudflare challenge confirmed both sides → legit browser block
    if insp_verdict.startswith("browser_block:cloudflare") and bench_verdict == "BROWSER_BLOCK":
        return {
            "kind": "legit_browser_block",
            "action": "no fix — spec exception (unless we upgrade Kuri stealth)",
            "rationale": "both curl and Kuri were blocked",
            "priority": "none",
        }

    # 5. Cloudflare challenge in inspect but bench got ops → product win, document
    if insp_verdict.startswith("browser_block:cloudflare") and bench_verdict in ("PASS", "PASS_WEAK"):
        return {
            "kind": "product_win",
            "action": "no fix — Kuri stealth already bypassing",
            "rationale": "curl blocked, Kuri succeeded",
            "priority": "none",
        }

    # 6. CLI timeout → tune timeout or investigate why capture hung
    if row.get("cli_timeout"):
        return {
            "kind": "timeout",
            "action": "bump --timeout for this URL, or add auth-wall detection",
            "rationale": "CLI hit the 100-120s bench-local timeout mid-capture",
            "priority": "low",
        }

    # 7. Product fail with no inspect signal
    if bench_verdict == "PRODUCT_FAIL":
        return {
            "kind": "investigate",
            "action": f"inspect signals: {insp_verdict or 'unknown'} — read the .out file and decide",
            "rationale": "bench marked PRODUCT_FAIL",
            "priority": "high",
        }

    # 8. thin body in inspect but bench got real data → product win
    if insp_verdict == "thin_body_no_data" and bench_verdict in ("PASS", "PASS_WEAK"):
        return {
            "kind": "product_win",
            "action": "no fix — bench bypassed curl-level thin body",
            "rationale": "curl got <1KB; bench captured real endpoints",
            "priority": "none",
        }

    return {
        "kind": "review",
        "action": "manually review row",
        "rationale": f"bench={bench_verdict}, inspect={insp_verdict}",
        "priority": "low",
    }


def main() -> None:
    argv = sys.argv[1:]
    json_out = "--json" in argv
    only_kind = None
    if "--only" in argv:
        i = argv.index("--only")
        only_kind = argv[i + 1] if i + 1 < len(argv) else None

    rows = load_jsonl(".bench-local/results.jsonl")
    insp_rows = load_jsonl(".bench-local/inspect.jsonl")
    insp_map = inspect_by_url(insp_rows)

    suggestions: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    for row in rows:
        v = row.get("verdict") or ""
        # Skip already-passing rows; only suggest on gaps.
        if v in ("PASS", "PASS_WEAK"):
            continue
        url = row.get("url", "")
        insp = insp_map.get(url, {})
        sug = suggest_for_row(row, insp)
        if only_kind and sug["kind"] != only_kind:
            continue
        suggestions[sug["kind"]].append((url, sug))

    if json_out:
        payload = {
            k: [{"url": url, **sug} for url, sug in items]
            for k, items in suggestions.items()
        }
        print(json.dumps(payload, indent=2))
        return

    if not suggestions:
        print("no gaps to report (all rows PASS or PASS_WEAK)")
        return

    PRIORITY_ORDER = ["high", "medium", "low", "none"]
    print("\n=== gap-analyzer: next-primitive suggestions ===\n")
    for kind in (
        "investigate",
        "extraction",
        "timeout",
        "validate_existing_fix",
        "review",
        "legit_browser_block",
        "product_win",
    ):
        items = suggestions.get(kind, [])
        if not items:
            continue
        print(f"{kind}  ({len(items)})")
        # Sort by priority
        items.sort(key=lambda t: PRIORITY_ORDER.index(t[1]["priority"]) if t[1]["priority"] in PRIORITY_ORDER else 99)
        for url, sug in items:
            print(f"  [{sug['priority']}] {url[:85]}")
            print(f"    action: {sug['action']}")
            print(f"    why:    {sug['rationale']}")
        print()


if __name__ == "__main__":
    main()
