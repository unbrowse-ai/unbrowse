#!/usr/bin/env bash
# bench-gate.sh — release-gate harness. Collects evidence. Never renders a verdict.
# See docs/release-gate-bench-plan.md + .claude/jesus-loop.default.firmament.md
#
# Invariants (Step 2 firmament):
#   - emits zero verdicts (no PASS / FAIL / score columns)
#   - never opens an LLM
#   - writes only to .bench-gate/<run-id>/
#
# Output layout per probe:
#   .bench-gate/<run-id>/
#     manifest.json
#     <probe-id>/
#       capture.out             raw stdout of `unbrowse capture` (JSON)
#       capture.meta.json       derived signals
#       capture.html.excerpt    first 8KB of captured HTML (or empty)
#       index.store.json        evidence that the captured skill reached the local index
#       resolve.shortlist.json  raw stdout of `unbrowse resolve --no-execute`
#       resolve.pick.json       top-1 endpoint pick (delegated to product ranker)
#       execute.input.json      exact skill/endpoint/intent/url passed into execute
#       execute.out             raw stdout of `unbrowse execute --raw`
#       execute.response.raw    response body extracted from execute.out
#       execute.meta.json       status_code, response_bytes, decision_trace
#       timings.json            per-phase ms

set -uo pipefail

CORPUS="${CORPUS:-harness/probes/corpus-gate.txt}"
OUT_DIR="${OUT_DIR:-.bench-gate}"
CLI_CMD="${UNBROWSE:-unbrowse}"
# Split multi-word UNBROWSE (e.g. "bun src/cli.ts") into an array so the
# `timeout` callsites pass each token as a separate argv slot. Quoting the
# whole string makes `timeout` look for an executable literally named
# "bun src/cli.ts", which silently fails on every probe.
read -r -a CLI_ARGS <<< "$CLI_CMD"
TIMEOUT="${TIMEOUT:-90}"
LIMIT="${LIMIT:-0}"   # 0 = no limit; otherwise stop after N probes

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$OUT_DIR/$RUN_ID"
mkdir -p "$RUN_DIR"

err() { echo "$*" >&2; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000; }

probe_slug() {
  local lane="$1" url="$2"
  printf '%s_%s' "$lane" "$(printf '%s' "$url" | tr '/:?&=.#' '_' | cut -c1-60)"
}

err "bench-gate: run-id=$RUN_ID corpus=$CORPUS out=$RUN_DIR cli=$CLI_CMD"

PARALLEL="${PARALLEL:-1}"   # >1 enables parallel probe execution
HEALTH_FLOOR="${HEALTH_FLOOR:-0}"  # >0 enables aggregate fast-fail: if first 10 probes have fewer than this many non-empty capture.meta.json, abort
CLEAN_SLATE="${CLEAN_SLATE:-1}"  # 1=isolate skill snapshots per run + clear pending queue; 0=keep existing state
err "bench-gate: parallel=$PARALLEL health_floor=$HEALTH_FLOOR clean_slate=$CLEAN_SLATE"

# Clean-slate enforcement: every probe must start from a known empty state so
# resolve picks the JUST-CAPTURED skill, not a stale snapshot from a prior
# bench run. Per-run isolation via UNBROWSE_SKILL_SNAPSHOT_DIR keeps the
# canonical user state untouched.
if [ "$CLEAN_SLATE" = "1" ]; then
  export UNBROWSE_LOCAL_CACHES=1
  export UNBROWSE_INLINE_INDEX=1
  export UNBROWSE_SKILL_SNAPSHOT_DIR="$RUN_DIR/.skill-snapshots"
  mkdir -p "$UNBROWSE_SKILL_SNAPSHOT_DIR"
  err "bench-gate: isolated skill snapshots → $UNBROWSE_SKILL_SNAPSHOT_DIR"
  err "bench-gate: stopping local server so first probe starts with isolated cache env"
  timeout 20 "${CLI_ARGS[@]}" stop --force >/dev/null 2>&1 || true
  # Clear the queue + heartbeat so stale jobs from a prior interrupted run
  # don't poison the indexer.
  QHOME="${HOME:-/tmp}/.unbrowse/queue/pending"
  if [ -d "$QHOME" ]; then
    rm -f "$QHOME"/*.json "$QHOME"/*.lock "$QHOME/.heartbeat" 2>/dev/null || true
    err "bench-gate: cleared pending queue at $QHOME"
  fi
fi

# Phase 1: build the probe queue (lane|intent|url|pid|pdir) so we can run each
# probe block as a self-contained function and feed them to a parallel pool.
QUEUE_FILE="$(mktemp -t bench-gate-queue.XXXXXX)"
trap 'rm -f "$QUEUE_FILE"' EXIT
i=0
while IFS='|' read -r lane c2 c3 c4 c5 c6 _rest; do
  lane="${lane## }"; lane="${lane%% }"
  case "$lane" in ''|\#*) continue ;; esac
  if [ -n "${c6:-}" ]; then
    auth="${c2## }"; auth="${auth%% }"
    difficulty="${c3## }"; difficulty="${difficulty%% }"
    strategy="${c4## }"; strategy="${strategy%% }"
    intent="${c5## }"; intent="${intent%% }"
    url="${c6## }"; url="${url%% }"
  else
    auth=""
    difficulty=""
    strategy=""
    intent="${c2## }"; intent="${intent%% }"
    url="${c3## }"; url="${url%% }"
  fi
  i=$((i+1))
  if [ "$LIMIT" -gt 0 ] && [ "$i" -gt "$LIMIT" ]; then break; fi
  pid="$(printf '%03d_%s' "$i" "$(probe_slug "$lane" "$url")")"
  pdir="$RUN_DIR/$pid"
  mkdir -p "$pdir"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" "$pdir" >> "$QUEUE_FILE"
done < "$CORPUS"
N_PROBES="$(wc -l < "$QUEUE_FILE" | tr -d ' ')"
err "bench-gate: queued $N_PROBES probe(s)"

# Per-probe pipeline as a function so xargs/parallel can call it.
# Exports its own copies of CLI_ARGS and other env via the parent shell scope.
export -f probe_slug 2>/dev/null || true
export TIMEOUT
run_probe() {
  local pid="$1" lane="$2" auth="$3" difficulty="$4" strategy="$5" intent="$6" url="$7" pdir="$8"
  local t0 t1 t2 t3 t4 t5 cap_meta cap_path pick skill_id endpoint_id
  err "[$pid] $lane | $intent | $url"

  # ── Phase 1: capture ──────────────────────────────────────────────────
  t0=$(now_ms)
  timeout "$TIMEOUT" "${CLI_ARGS[@]}" capture --url "$url" --intent "$intent" \
    </dev/null > "$pdir/capture.out" 2> "$pdir/capture.stderr.log" || true
  t1=$(now_ms)
  cap_meta='{}'
  if head -c 1 "$pdir/capture.out" 2>/dev/null | grep -q '{' ; then
    cap_meta="$(jq -c '{
      skill_id, endpoints_discovered, marketplace_published,
      next_step, error, captured_meta, capture_pattern,
      browser_block_signals: (.captured_meta.browser_block_signals // []),
      filter_rejections: (.captured_meta.filter_rejections // {}),
      total_endpoints_captured: (.captured_meta.total_endpoints_captured // .endpoints_discovered // 0),
      captured_title: (.captured_meta.captured_title // null),
      capture_path
    }' < "$pdir/capture.out" 2>/dev/null || echo '{}')"
  fi
  printf '%s\n' "$cap_meta" > "$pdir/capture.meta.json"

  cap_path="$(jq -r '.capture_path // empty' < "$pdir/capture.meta.json" 2>/dev/null || true)"
  if [ -n "$cap_path" ] && [ -f "$cap_path" ]; then
    head -c 8192 "$cap_path" > "$pdir/capture.html.excerpt" 2>/dev/null || true
  else
    : > "$pdir/capture.html.excerpt"
  fi

  captured_skill_id="$(jq -r '.skill_id // empty' < "$pdir/capture.out" 2>/dev/null || true)"
  snapshot_path=""
  if [ -n "$captured_skill_id" ]; then
    QPEND="${HOME:-/tmp}/.unbrowse/queue/pending"
    SNAPSHOT_DIR="${UNBROWSE_SKILL_SNAPSHOT_DIR:-${HOME:-/tmp}/.unbrowse/skill-snapshots}"
    deadline=$(( $(now_ms) + 15000 ))
    while [ "$(now_ms)" -lt "$deadline" ]; do
      snapshot_path="$(find "$SNAPSHOT_DIR" -maxdepth 1 -name '*.json' -print 2>/dev/null | while IFS= read -r f; do
        if jq -e --arg id "$captured_skill_id" '.skill_id == $id' "$f" >/dev/null 2>&1; then
          printf '%s\n' "$f"
          break
        fi
      done)"
      if [ -n "$snapshot_path" ]; then break; fi
      pending=$(ls "$QPEND"/*.json 2>/dev/null | wc -l | tr -d ' ')
      if [ "$pending" = "0" ]; then sleep 0.2; continue; fi
      sleep 0.2
    done
  fi
  if [ -n "$captured_skill_id" ]; then
    stored=false
    endpoint_count=0
    intent_signature=""
    if [ -n "$snapshot_path" ] && [ -f "$snapshot_path" ]; then
      stored=true
      endpoint_count="$(jq -r '(.endpoints // []) | length' "$snapshot_path" 2>/dev/null || echo 0)"
      intent_signature="$(jq -r '.intent_signature // empty' "$snapshot_path" 2>/dev/null || true)"
    fi
    pending_count="$(ls "${HOME:-/tmp}/.unbrowse/queue/pending"/*.json 2>/dev/null | wc -l | tr -d ' ')"
    jq -nc \
      --arg skill_id "$captured_skill_id" \
      --arg snapshot_dir "${UNBROWSE_SKILL_SNAPSHOT_DIR:-${HOME:-/tmp}/.unbrowse/skill-snapshots}" \
      --arg snapshot_path "$snapshot_path" \
      --arg intent_signature "$intent_signature" \
      --argjson stored "$stored" \
      --argjson endpoint_count "${endpoint_count:-0}" \
      --argjson pending_count "${pending_count:-0}" \
      '{captured_skill_id:$skill_id, stored:$stored, snapshot_dir:$snapshot_dir, snapshot_endpoint_count:$endpoint_count, pending_queue_count:$pending_count}
        + (if $snapshot_path|length > 0 then {snapshot_path:$snapshot_path} else {} end)
        + (if $intent_signature|length > 0 then {snapshot_intent_signature:$intent_signature} else {} end)' \
      > "$pdir/index.store.json"
  else
    echo '{"stored":false,"reason":"capture_did_not_emit_skill_id"}' > "$pdir/index.store.json"
  fi

  # ── Phase 2a: resolve ─────────────────────────────────────────────────
  t2=$(now_ms)
  timeout "$TIMEOUT" "${CLI_ARGS[@]}" resolve --intent "$intent" --url "$url" --no-execute \
    </dev/null > "$pdir/resolve.shortlist.json" 2> "$pdir/resolve.stderr.log" || true
  t3=$(now_ms)

  pick="$(jq -c '
    (.available_endpoints // .result.available_endpoints // []) as $eps
    | {
        skill_id: ($eps[0].skill_id // .trace.skill_id // .result.skill_id // .skill_id // null),
        endpoint_id: ($eps[0].endpoint_id // $eps[0].id // .trace.endpoint_id // .result.endpoint_id // .endpoint_id // null),
        score: ($eps[0].score // null),
        url: ($eps[0].url // null),
        reasoning: (if ($eps|length) > 0 then "first candidate from available_endpoints" else "no available_endpoints in resolve envelope" end)
      }
  ' < "$pdir/resolve.shortlist.json" 2>/dev/null || echo 'null')"
  printf '%s\n' "$pick" > "$pdir/resolve.pick.json"

  # ── Phase 2b: execute --raw ───────────────────────────────────────────
  skill_id="$(jq -r '.skill_id // empty' < "$pdir/resolve.pick.json" 2>/dev/null || true)"
  endpoint_id="$(jq -r '.endpoint_id // empty' < "$pdir/resolve.pick.json" 2>/dev/null || true)"
  t4=$(now_ms); t5="$t4"
  if [ -n "$skill_id" ] && [ -n "$endpoint_id" ]; then
    jq -nc \
      --arg skill_id "$skill_id" --arg endpoint_id "$endpoint_id" \
      --arg intent "$intent" --arg url "$url" \
      '{skill_id:$skill_id, endpoint_id:$endpoint_id, intent:$intent, context_url:$url, raw:true}' \
      > "$pdir/execute.input.json"
    timeout "$TIMEOUT" "${CLI_ARGS[@]}" execute --skill "$skill_id" --endpoint "$endpoint_id" --raw \
      </dev/null > "$pdir/execute.out" 2> "$pdir/execute.stderr.log" || true
    t5=$(now_ms)
    jq -c '{
      status_code: (.result.status // .status // null),
      response_bytes: (.result.body | tostring | length),
      decision_trace: (.trace // .decision_trace // [])
    }' < "$pdir/execute.out" > "$pdir/execute.meta.json" 2>/dev/null || echo '{}' > "$pdir/execute.meta.json"
  jq -r 'if (.result | type) == "object" and (.result | has("body")) then .result.body else (.result // empty) end' \
    < "$pdir/execute.out" > "$pdir/execute.response.raw" 2>/dev/null || : > "$pdir/execute.response.raw"
  else
    jq -nc --arg intent "$intent" --arg url "$url" \
      '{skipped:"no_skill_or_endpoint_from_resolve", intent:$intent, context_url:$url}' \
      > "$pdir/execute.input.json"
    echo '{"skipped":"no_skill_or_endpoint_from_resolve"}' > "$pdir/execute.meta.json"
    : > "$pdir/execute.out"
    : > "$pdir/execute.response.raw"
  fi

  printf '{"capture_ms":%d,"resolve_ms":%d,"execute_ms":%d}\n' \
    "$((t1-t0))" "$((t3-t2))" "$((t5-t4))" > "$pdir/timings.json"
}

# Run probes — parallel or sequential.
WORKER_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bench-gate-probe-worker.sh"
export CLI_ARGS_STR="${CLI_ARGS[*]}"
export TIMEOUT RUN_DIR
if [ "$PARALLEL" -le 1 ]; then
  while IFS=$'\t' read -r pid lane auth difficulty strategy intent url pdir; do
    run_probe "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" "$pdir"
  done < "$QUEUE_FILE"
else
  err "bench-gate: launching pool of $PARALLEL workers (xargs -P)"
  # Convert tab-separated queue to NUL-separated for xargs -0 -n 8. NUL lets
  # us pass args with embedded spaces (intent strings) without splitting.
  queue_to_nul() {
    awk -F'\t' '{for(i=1;i<=NF;i++){printf "%s%c", $i, 0}}' "$1"
  }
  if [ "$HEALTH_FLOOR" -gt 0 ] && [ "$N_PROBES" -gt 10 ]; then
    HEAD_FILE="$(mktemp -t bench-gate-head.XXXXXX)"
    TAIL_FILE="$(mktemp -t bench-gate-tail.XXXXXX)"
    head -n 10 "$QUEUE_FILE" > "$HEAD_FILE"
    tail -n +11 "$QUEUE_FILE" > "$TAIL_FILE"
    err "bench-gate: phase 1 — first 10 probes (health gate)"
    queue_to_nul "$HEAD_FILE" | xargs -0 -P "$PARALLEL" -n 8 "$WORKER_SCRIPT"
    non_empty=$(grep -l '"skill_id":' "$RUN_DIR"/*/capture.meta.json 2>/dev/null | wc -l | tr -d ' ')
    err "bench-gate: health gate — $non_empty/10 non-empty captures (floor=$HEALTH_FLOOR)"
    if [ "$non_empty" -lt "$HEALTH_FLOOR" ]; then
      err "bench-gate: FAIL-FAST — only $non_empty/10 captures produced data, aborting"
      rm -f "$HEAD_FILE" "$TAIL_FILE"
      printf '%s\n' "$RUN_DIR"
      exit 2
    fi
    err "bench-gate: phase 2 — remaining $((N_PROBES - 10)) probes"
    queue_to_nul "$TAIL_FILE" | xargs -0 -P "$PARALLEL" -n 8 "$WORKER_SCRIPT"
    rm -f "$HEAD_FILE" "$TAIL_FILE"
  else
  queue_to_nul "$QUEUE_FILE" | xargs -0 -P "$PARALLEL" -n 8 "$WORKER_SCRIPT"
  fi
fi

# Build probes_json from queue (preserves original order).
probes_json="["
first=1
while IFS=$'\t' read -r pid lane auth difficulty strategy intent url pdir; do
  if [ $first -eq 0 ]; then probes_json="$probes_json,"; fi
  first=0
  probes_json="$probes_json$(jq -nc \
    --arg id "$pid" --arg lane "$lane" --arg intent "$intent" --arg url "$url" \
    --arg auth "$auth" --arg difficulty "$difficulty" --arg strategy "$strategy" \
    '{probe_id:$id, lane:$lane, intent:$intent, url:$url}
      + (if $auth|length > 0 then {auth:$auth} else {} end)
      + (if $difficulty|length > 0 then {difficulty:$difficulty} else {} end)
      + (if $strategy|length > 0 then {strategy:$strategy} else {} end)')"
done < "$QUEUE_FILE"
probes_json="$probes_json]"

# ── manifest.json (NO verdict field anywhere) ───────────────────────────
cli_version="$("${CLI_ARGS[@]}" --version 2>/dev/null || echo unknown)"
node_version="$(node --version 2>/dev/null || echo unknown)"
jq -nc \
  --arg run_id "$RUN_ID" --arg corpus "$CORPUS" \
  --arg cli_version "$cli_version" --arg node_version "$node_version" \
  --arg started "$(date -u +%FT%TZ)" --argjson probes "$probes_json" \
  '{run_id:$run_id, corpus:$corpus, cli_version:$cli_version, node_version:$node_version, started_at:$started, probes:$probes}' \
  > "$RUN_DIR/manifest.json"

err "bench-gate: wrote $RUN_DIR/manifest.json with $N_PROBES probe(s)"
printf '%s\n' "$RUN_DIR"
