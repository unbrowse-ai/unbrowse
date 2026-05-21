#!/usr/bin/env bash
# next-blocker.sh - surface the highest-impact failing probe from the latest
# bench-gate run as a structured suggestion for the next /meta-harness call.
#
# Substrate-faithful: this script SURFACES candidates as raw evidence. The
# agent in-thread judges which (if any) to actually act on. No script ever
# decides "this is THE next fix" - it ranks by impact and prints the top N,
# the agent reads + picks.
#
# Output (one JSON object per line, sorted by impact desc):
#   {
#     "probe_id": "...", "lane": "...", "url": "...", "intent": "...",
#     "index_verdict": "...", "retrieve_verdict": "...",
#     "capture_meta": {...key fields from capture.meta.json...},
#     "suggested_fix_shape": "extractor|drift-recovery|kuri-isolation|...",
#     "suggested_meta_harness_plan": "fix the X bug ..."
#   }
#
# The "suggested_fix_shape" + plan strings are STRUCTURAL hints derived from
# the failure signal (e.g., INDEX_FAIL_NO_ENDPOINTS + dom_html_size>10k =
# "extractor missed signal in rich HTML"). The agent judges whether the
# hint matches reality before invoking /meta-harness build.

set -uo pipefail
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$(cd "$SCAFFOLD/../.." && pwd)"
cd "$PROJECT"

LIMIT="${UNBROWSE_NEXT_BLOCKER_LIMIT:-5}"
RUN_DIR="${1:-$(ls -dt .bench-gate/20260*/ 2>/dev/null | head -1)}"
RUN_DIR="${RUN_DIR%/}"

if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
  echo "[next-blocker] no bench-gate run found" >&2
  exit 1
fi

VERDICT="$RUN_DIR/verdict.json"
if [ ! -f "$VERDICT" ]; then
  echo "[next-blocker] $VERDICT not found; run verify.sh first to build it" >&2
  exit 1
fi

python3 - "$RUN_DIR" "$LIMIT" <<'PYEOF'
import json, os, sys
run_dir = sys.argv[1]
limit = int(sys.argv[2])
verdicts = json.load(open(f"{run_dir}/verdict.json")).get("verdicts", [])
manifest = json.load(open(f"{run_dir}/manifest.json")).get("probes", [])
probe_meta = {p["probe_id"]: p for p in manifest}

def impact_score(v):
    """Higher = more important to fix. Anchor lane is most load-bearing,
    INDEX failures are upstream of RETRIEVE failures, hostile/auth lanes
    are excluded from gate so they score 0."""
    lane = v.get("lane", "")
    if lane in ("hostile", "auth-gated", "auth-cookies"):
        return 0
    idx = v.get("index_verdict", "")
    ret = v.get("retrieve_verdict", "")
    score = 0
    if lane == "anchor":
        score += 100
    elif lane == "semantic-rank":
        score += 60
    elif lane == "graphql":
        score += 40
    elif lane == "ssr-list":
        score += 50
    if idx.startswith("INDEX_FAIL"):
        score += 50
    elif idx.startswith("INDEX_PASS") and not ret.startswith("RETRIEVE_PASS"):
        score += 20
    if ret.startswith("RETRIEVE_FAIL"):
        score += 30
    return score

def suggested_fix_shape(probe_id, idx, ret, meta):
    cap = meta.get("capture_meta", {})
    diag = cap.get("capture_diagnostic", {}) or {}
    blocks = cap.get("browser_block_signals", []) or []
    iso = cap.get("iso_self_check", {}) or {}
    if isinstance(blocks, list) and ("crashed_during_collect" in blocks or "empty_snapshot" in blocks):
        return "kuri-stability"
    if iso.get("host_match") is False:
        return "kuri-session-isolation"
    if idx == "INDEX_FAIL_NO_ENDPOINTS":
        dom_html = diag.get("dom_html_size", 0) or 0
        if dom_html > 10000:
            return "extractor-missed-signal-in-rich-html"
        return "capture-empty-dom"
    if ret == "RETRIEVE_FAIL_WRONG_SHAPE":
        return "ranker-or-extractor-junk-shape"
    if ret == "RETRIEVE_FAIL_WRONG_ENTITY":
        return "ranker-intent-overlap"
    if ret == "RETRIEVE_FAIL_ERROR_BODY":
        return "execute-returned-error-page"
    if ret == "RETRIEVE_FAIL_EMPTY":
        return "extraction-produced-empty"
    return "unknown"

def suggested_plan_text(probe_id, lane, url, intent, idx, ret, fix_shape):
    return (
        f"Fix the {lane}-lane regression on probe {probe_id}: "
        f"intent={intent!r}, url={url}, index_verdict={idx}, retrieve_verdict={ret}, "
        f"fix-shape={fix_shape}. Use /unbrowse-improvement-loop or a scoped "
        f"single-file substrate fix. Verify via the bench-gate harness re-iterate."
    )

ranked = []
for v in verdicts:
    pid = v.get("probe_id", "")
    pmeta = probe_meta.get(pid, {})
    cap_meta_path = f"{run_dir}/{pid}/capture.meta.json"
    cap_meta = {}
    if os.path.exists(cap_meta_path):
        try:
            cap_meta = json.load(open(cap_meta_path))
        except Exception:
            cap_meta = {}
    score = impact_score({"lane": pmeta.get("lane", ""), "index_verdict": v.get("index_verdict"), "retrieve_verdict": v.get("retrieve_verdict")})
    if score == 0:
        continue
    fix_shape = suggested_fix_shape(pid, v.get("index_verdict",""), v.get("retrieve_verdict",""), {"capture_meta": cap_meta})
    plan = suggested_plan_text(pid, pmeta.get("lane",""), pmeta.get("url",""), pmeta.get("intent",""), v.get("index_verdict",""), v.get("retrieve_verdict",""), fix_shape)
    ranked.append({
        "score": score,
        "probe_id": pid,
        "lane": pmeta.get("lane",""),
        "url": pmeta.get("url",""),
        "intent": pmeta.get("intent",""),
        "index_verdict": v.get("index_verdict",""),
        "retrieve_verdict": v.get("retrieve_verdict",""),
        "capture_meta": {
            "indexed": cap_meta.get("indexed"),
            "mode": cap_meta.get("mode"),
            "n_operations": cap_meta.get("n_operations", 0),
            "total_endpoints_captured": cap_meta.get("total_endpoints_captured", 0),
            "browser_block_signals": cap_meta.get("browser_block_signals", []),
            "iso_self_check": cap_meta.get("iso_self_check", {}),
            "capture_diagnostic": cap_meta.get("capture_diagnostic", {}),
        },
        "suggested_fix_shape": fix_shape,
        "suggested_meta_harness_plan": plan,
    })

ranked.sort(key=lambda r: -r["score"])
for row in ranked[:limit]:
    print(json.dumps(row))
PYEOF
