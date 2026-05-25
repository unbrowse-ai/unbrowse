#!/usr/bin/env bash
# bench-coverage.sh — pure evidence collector for Unbrowse CLI coverage bench.
#
# Runs all corpus probes in parallel via `bun src/cli.ts run` (source CLI).
# Saves raw stdio per probe to <out-dir>/probes/<idx>.json.
# Writes a manifest to <out-dir>/bench-manifest.json with per-probe metadata
# extracted from the raw output (source, bytes, trace_success, excerpt).
#
# NO verdict, NO classification, NO coverage%. The agent reads the manifest
# and probes and judges coverage in-thread. (harness-collects-agent-judges)
#
# Usage:
#   bash scripts/bench-coverage.sh [--corpus-file <path>] [--timeout <s>] [--dry-run]
#   bash scripts/bench-coverage.sh [--out-dir <path>] [--staging]

set -uo pipefail

CORPUS_FILE="scripts/corpus/bench-on-change.txt"
TIMEOUT=35
DRY_RUN=0
OUT_DIR=".bench-local"
STAGING=0
CONCURRENCY=0   # 0 = unbounded (legacy behavior: all probes parallel)
USE_CONTRACT_FETCH=0   # 1 = call bun src/contract-fetch.ts (stateless-stdio Layer-1 primitive)
                       # instead of bun src/cli.ts run for each probe — validates the
                       # contract-fetch wedge against the full bench corpus

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus-file)         CORPUS_FILE="$2"; shift 2 ;;
    --timeout)             TIMEOUT="$2";     shift 2 ;;
    --out-dir)             OUT_DIR="$2";     shift 2 ;;
    --concurrency)         CONCURRENCY="$2"; shift 2 ;;
    --use-contract-fetch)  USE_CONTRACT_FETCH=1; shift ;;
    --staging)             STAGING=1;        shift   ;;
    --dry-run)             DRY_RUN=1;        shift   ;;
    *) echo "[bench-coverage] unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "bench-coverage ready"
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
mkdir -p "$OUT_DIR" "$OUT_DIR/probes"

export PATH="$HOME/.npm-global/bin:/opt/nanobrew/prefix/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Kill any stale unbrowse servers before running so parallel bun processes don't
# race a wedged daemon. Narrowed set per CLAUDE.md.
pkill -9 -f 'unbrowse (serve|mcp)( |$)' 2>/dev/null || true
pkill -9 -f 'bun .*src/mcp\.ts' 2>/dev/null || true
pkill -9 -f 'node .*unbrowse/dist/server' 2>/dev/null || true
pkill -9 -f 'unbrowse __drain-queue' 2>/dev/null || true
pkill -9 -f '/\.unbrowse/bin/kuri( |$)' 2>/dev/null || true
pkill -9 -f '/\.kuri/bin/kuri( |$)' 2>/dev/null || true
sleep 1

if [[ "$STAGING" -eq 1 ]]; then
  export UNBROWSE_BACKEND_URL="https://unbrowse-backend-staging.lewis-6d8.workers.dev"
  echo "[bench-coverage] staging mode: UNBROWSE_BACKEND_URL=$UNBROWSE_BACKEND_URL" >&2
fi

TMP_DIR="$(mktemp -d /tmp/bench-coverage-XXXXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Canary probe — fixed reliable endpoint, independent of corpus.
# Tests that bun src/cli.ts starts and can make a network call.
# CF_GATED / antibot first-probe corpora would false-positive if we used
# the first corpus entry, so we always use a known-good public REST API.
CANARY_TIMEOUT=$(( TIMEOUT < 15 ? TIMEOUT : 15 ))
CANARY_URL="https://randomuser.me/api/"
CANARY_INTENT="get random user (canary)"
CANARY_OUT="$TMP_DIR/canary.json"
timeout "$CANARY_TIMEOUT" bun src/cli.ts run "$CANARY_URL" "$CANARY_INTENT" \
  > "$CANARY_OUT" 2>/dev/null
CANARY_BYTES=$(wc -c < "$CANARY_OUT" 2>/dev/null || echo 0)
if [[ "$CANARY_BYTES" -eq 0 ]]; then
  echo "" >&2
  echo "=== BENCH EARLY-STOP ===" >&2
  echo "  Canary probe produced 0 bytes within ${CANARY_TIMEOUT}s." >&2
  echo "  url: $CANARY_URL" >&2
  echo "" >&2
  echo "  Possible causes:" >&2
  echo "    1. bun src/cli.ts fails to start (check: bun src/cli.ts --version)" >&2
  echo "    2. UNBROWSE_BACKEND_URL unreachable (staging misconfigured?)" >&2
  echo "    3. Timeout too short — try --timeout 30" >&2
  echo "" >&2
  exit 1
fi
echo "[bench-coverage] canary OK (${CANARY_BYTES}B)" >&2


# Phase 1: read corpus, spawn all probes in parallel
INTENTS_FILE="$TMP_DIR/intents.txt"
URLS_FILE="$TMP_DIR/urls.txt"
touch "$INTENTS_FILE" "$URLS_FILE"

IDX=0
while IFS='|' read -r intent url || [[ -n "${intent:-}" ]]; do
  [[ -z "${intent:-}" || "${intent:-}" =~ ^[[:space:]]*# ]] && continue
  intent="${intent# }"; intent="${intent% }"
  url="${url# }"; url="${url% }"
  [[ -z "${url:-}" ]] && continue

  echo "$intent" >> "$INTENTS_FILE"
  echo "$url"    >> "$URLS_FILE"

  PROBE_OUT="$OUT_DIR/probes/${IDX}.json"

  if [[ "$USE_CONTRACT_FETCH" -eq 1 ]]; then
    # Stateless-stdio Layer-1 primitive. Single ephemeral subprocess per
    # call (curl_cffi). Zero shared state. Validates the contract-fetch
    # wedge against the full corpus at chosen concurrency.
    (
      echo "{\"url\":\"$url\",\"intent\":\"$intent\"}" \
        | timeout "$TIMEOUT" bun src/contract-fetch.ts \
        > "$PROBE_OUT" 2>/dev/null
      echo $? > "$TMP_DIR/exit-${IDX}.txt"
    ) &
  else
    (
      timeout "$TIMEOUT" bun src/cli.ts run "$url" "$intent" \
        > "$PROBE_OUT" 2>/dev/null
      echo $? > "$TMP_DIR/exit-${IDX}.txt"
    ) &
  fi

  # Batch concurrency control. When --concurrency N is set (N>0), wait for
  # the running pool to drop below N before spawning the next probe. This
  # trades wallclock for measurement honesty: the bench measures product
  # capability at a chosen concurrency level instead of system saturation.
  if [[ "$CONCURRENCY" -gt 0 ]]; then
    while (( $(jobs -rp | wc -l) >= CONCURRENCY )); do
      wait -n 2>/dev/null || sleep 0.5
    done
  fi

  IDX=$(( IDX + 1 ))
done < "$CORPUS_FILE"

TOTAL=$IDX
if [[ "$CONCURRENCY" -gt 0 ]]; then
  echo "[bench-coverage] $TOTAL probes batched at concurrency=$CONCURRENCY (timeout=${TIMEOUT}s each)..." >&2
else
  echo "[bench-coverage] $TOTAL probes running in parallel (timeout=${TIMEOUT}s each)..." >&2
fi
wait

# Phase 2: build manifest — extract raw signals, no verdict
MANIFEST="$OUT_DIR/bench-manifest.json"
INTENTS_F="$INTENTS_FILE"
URLS_F="$URLS_FILE"
TMP_D="$TMP_DIR"
OUT_D="$OUT_DIR"
CORPUS_F="$CORPUS_FILE"
TOTAL_N="$TOTAL"

python3 << PYEOF
import json, sys, os, datetime

intents = open("$INTENTS_F").read().splitlines()
urls    = open("$URLS_F").read().splitlines()
total   = int("$TOTAL_N")
out_dir = "$OUT_D"
ts      = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')

probes = []
for i in range(total):
    probe_path = f"{out_dir}/probes/{i}.json"
    exit_path  = f"$TMP_D/exit-{i}.txt"
    raw        = ""
    exit_code  = -1

    if os.path.exists(probe_path):
        raw = open(probe_path).read()
    if os.path.exists(exit_path):
        try: exit_code = int(open(exit_path).read().strip())
        except: pass

    bytes_out = len(raw.encode())

    source       = ""
    trace_success = None
    error        = None
    excerpt      = ""

    json_lines = [l for l in raw.split("\n") if l.strip().startswith("{")]
    if json_lines:
        try:
            r = json.loads(json_lines[-1])
            source        = r.get("source") or ""
            trace         = r.get("trace") or {}
            trace_success = trace.get("success")
            error         = r.get("error") or r.get("error_code") or None
            result = r.get("result")
            if result and isinstance(result, dict):
                for field in ("text_excerpt","markdown","content","data","results"):
                    v = result.get(field)
                    if v:
                        excerpt = str(v)[:200]
                        break
                if not excerpt and result.get("html_bytes"):
                    excerpt = f"[html {result.get('html_bytes')} bytes]"
            elif r.get("available_operations"):
                ops = r["available_operations"]
                excerpt = f"[{len(ops)} operations available]"
        except Exception as e:
            error = f"parse_error: {e}"

    probes.append({
        "idx":           i,
        "intent":        intents[i] if i < len(intents) else "",
        "url":           urls[i]    if i < len(urls)    else "",
        "bytes":         bytes_out,
        "exit":          exit_code,
        "source":        source,
        "trace_success": trace_success,
        "error":         error,
        "excerpt":       excerpt,
    })

manifest = {"ts": ts, "corpus": "$CORPUS_F", "total": total, "probes": probes}

with open("$MANIFEST", "w") as f:
    json.dump(manifest, f, indent=2)

print("")
print("=== Unbrowse Bench — Raw Evidence (agent judges) ===")
print(f"corpus: $CORPUS_F  total: {total}  ts: {ts}")
print("")
hdr = f"  {'#':>3}  {'bytes':>7}  {'x':>3}  {'source':<22}  {'ok':>2}  {'intent':<32}  excerpt[:100]"
print(hdr)
print("  " + "-"*130)
for p in probes:
    ok   = "Y" if p["trace_success"] is True else ("?" if p["trace_success"] is None else "N")
    src  = (p["source"] or "-")[:22]
    exc  = (p["excerpt"] or p.get("error") or "")[:100]
    intent = p["intent"][:32]
    print(f"  {p['idx']:>3}  {p['bytes']:>7}  {p['exit']:>3}  {src:<22}  {ok:>2}  {intent:<32}  {exc}")

print("")
print(f"manifest -> $MANIFEST")
print(f"probes   -> $OUT_D/probes/<idx>.json  (raw CLI stdio, persistent)")
print("")
print("AGENT: read manifest above. For each probe, judge: did the CLI return")
print("       useful data for the stated intent? Count PASS/FAIL/BLOCK.")
print("       Report genuine coverage% = PASS / (PASS + FAIL + BLOCK).")
PYEOF
