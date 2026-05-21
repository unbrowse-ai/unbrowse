#!/usr/bin/env bash
# auto-classify.sh - derive verdict.json from per-probe artifacts using the
# CLAUDE.md "bench-local" rubric (structural buckets, NOT a per-probe LLM
# judgment). This unlocks autonomous benchmax cycles by removing the
# human-in-the-loop verdict-fill step.
#
# Substrate-faithful note: this is a STRUCTURAL ROUGH-CUT, not the final
# verdict. The agent in-thread is still expected to read judge.bundle.md
# and override per-probe verdicts when the structural bucket disagrees
# with the qualitative truth. The auto-classifier just lets the gate
# verdict + next-blocker surface fire without waiting on an agent to
# manually fill 66 rows.
#
# Rubric (matches CLAUDE.md "bench-local Agent rubric"):
#   BROWSER_BLOCK / AUTH excluded from gate denominator
#   INDEX_PASS if indexed=True AND n_operations > 0
#   INDEX_PASS if source == "dom-fallback" / "direct-fetch" with non-empty
#   INDEX_FAIL_NO_ENDPOINTS otherwise on non-excluded lanes
#   RETRIEVE_PASS if execute returned 200 with non-empty data
#   RETRIEVE_FAIL_* on shape / error / empty failures
#
# Output: writes verdict.json into the run dir.

set -uo pipefail
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$(cd "$SCAFFOLD/../.." && pwd)"
cd "$PROJECT"

RUN_DIR="${1:-$(ls -dt .bench-gate/20260*/ 2>/dev/null | head -1)}"
RUN_DIR="${RUN_DIR%/}"
if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
  echo "[auto-classify] no run dir" >&2
  exit 1
fi
if [ ! -f "$RUN_DIR/manifest.json" ]; then
  echo "[auto-classify] $RUN_DIR/manifest.json missing" >&2
  exit 1
fi

python3 - "$RUN_DIR" <<'PYEOF'
import json, os, sys
run_dir = sys.argv[1]
manifest = json.load(open(f"{run_dir}/manifest.json"))
probes = manifest.get("probes", [])

def classify(probe, cap_meta, exec_meta, exec_raw_bytes):
    lane = probe.get("lane", "")
    blocks = cap_meta.get("browser_block_signals", []) or []
    diag = cap_meta.get("capture_diagnostic", {}) or {}
    iso = cap_meta.get("iso_self_check", {}) or {}
    indexed = cap_meta.get("indexed", False)
    n_ops = cap_meta.get("n_operations", 0) or 0
    mode = cap_meta.get("mode", "") or ""

    # Auth-gated lanes are always excluded (they need real cookies)
    if lane in ("auth-gated", "auth-cookies"):
        return ("INDEX_EXCLUDED_AUTH", "RETRIEVE_EXCLUDED_AUTH")
    # Hostile lane is excluded by design (browser-blocked)
    if lane == "hostile":
        return ("INDEX_EXCLUDED_BLOCKED", "RETRIEVE_EXCLUDED_BLOCKED")

    # Crash / vendor block / cross-contamination
    if "crashed_during_collect" in blocks:
        return ("INDEX_EXCLUDED_BLOCKED", "RETRIEVE_EXCLUDED_BLOCKED")
    vendor_blocked = any(b.startswith("vendor:") or b == "challenge_title" for b in blocks)
    if vendor_blocked:
        return ("INDEX_EXCLUDED_BLOCKED", "RETRIEVE_EXCLUDED_BLOCKED")
    if iso.get("host_match") is False:
        return ("INDEX_EXCLUDED_BLOCKED", "RETRIEVE_EXCLUDED_BLOCKED")

    # Index verdict
    if indexed and n_ops > 0:
        index_verdict = "INDEX_PASS"
    elif indexed and mode == "dom":
        index_verdict = "INDEX_PASS"
    else:
        index_verdict = "INDEX_FAIL_NO_ENDPOINTS"

    # Retrieve verdict from execute artifact
    status = exec_meta.get("status_code")
    resolve_status = exec_meta.get("resolve_status")
    if resolve_status == "no_match":
        retrieve_verdict = "RETRIEVE_FAIL_ERROR_BODY"
    elif status == 200:
        if exec_raw_bytes < 50:
            retrieve_verdict = "RETRIEVE_FAIL_EMPTY"
        elif exec_raw_bytes < 200:
            # Could be tiny shell shape; agent should review
            retrieve_verdict = "RETRIEVE_FAIL_WRONG_SHAPE"
        else:
            retrieve_verdict = "RETRIEVE_PASS"
    elif status is None:
        retrieve_verdict = "RETRIEVE_FAIL_ERROR_BODY"
    elif status >= 400:
        retrieve_verdict = "RETRIEVE_FAIL_ERROR_BODY"
    else:
        retrieve_verdict = "RETRIEVE_FAIL_ERROR_BODY"
    return (index_verdict, retrieve_verdict)

verdicts = []
for probe in probes:
    pid = probe["probe_id"]
    pdir = f"{run_dir}/{pid}"
    cap_meta = {}
    exec_meta = {}
    exec_raw_bytes = 0
    if os.path.exists(f"{pdir}/capture.meta.json"):
        try: cap_meta = json.load(open(f"{pdir}/capture.meta.json"))
        except: pass
    if os.path.exists(f"{pdir}/execute.meta.json"):
        try: exec_meta = json.load(open(f"{pdir}/execute.meta.json"))
        except: pass
    if os.path.exists(f"{pdir}/execute.response.raw"):
        exec_raw_bytes = os.path.getsize(f"{pdir}/execute.response.raw")
    iv, rv = classify(probe, cap_meta, exec_meta, exec_raw_bytes)
    verdicts.append({
        "probe_id": pid,
        "lane": probe.get("lane", ""),
        "url": probe.get("url", ""),
        "intent": probe.get("intent", ""),
        "index_verdict": iv,
        "index_reasoning": f"auto-classified from capture.meta.json (indexed={cap_meta.get('indexed')}, n_ops={cap_meta.get('n_operations',0)}, mode={cap_meta.get('mode','')!r})",
        "retrieve_verdict": rv,
        "retrieve_reasoning": f"auto-classified from execute.meta.json (status={exec_meta.get('status_code')}, resolve={exec_meta.get('resolve_status')}, bytes={exec_raw_bytes})",
        "evidence_quote": "structural classification (auto-classify.sh); agent should override per-probe when qualitative judgment differs",
        "suspicious": False,
    })

out = {
    "run_id": manifest.get("run_id"),
    "cli_version": manifest.get("cli_version", "auto-classified"),
    "verdicts": verdicts,
}
json.dump(out, open(f"{run_dir}/verdict.json", "w"), indent=2)
print(f"[auto-classify] wrote {len(verdicts)} verdicts to {run_dir}/verdict.json", file=sys.stderr)
PYEOF
