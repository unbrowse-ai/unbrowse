#!/usr/bin/env bash
# Per-probe worker called by xargs -P from bench-gate.sh.
# Reads a tab-separated probe spec on argv: <pid> <lane> <intent> <url> <pdir>
set -uo pipefail

# Re-parse CLI_ARGS from the exported string (xargs strips array environment).
read -r -a CLI_ARGS <<< "${CLI_ARGS_STR:-}"
TIMEOUT="${TIMEOUT:-90}"

# Strip optional surrounding whitespace.
pid="$1"; lane="$2"; intent="$3"; url="$4"; pdir="$5"

err() { echo "$*" >&2; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000; }

if [ "${BENCH_ISOLATE_WORKER:-1}" = "1" ]; then
  idx="${pid%%_*}"
  idx_num=$((10#$idx))
  export UNBROWSE_URL="http://127.0.0.1:$((6969 + idx_num))"
  export KURI_PORT="$((7700 + idx_num))"
  timeout 10 "${CLI_ARGS[@]}" stop --force >/dev/null 2>&1 || true
  cleanup_worker_runtime() {
    timeout 10 "${CLI_ARGS[@]}" stop --force >/dev/null 2>&1 || true
  }
  trap cleanup_worker_runtime EXIT
fi

err "[$pid] $lane | $intent | $url"

# ── Phase 1: capture ─────────────────────────────────────────────────────
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

# ── Phase 1b: wait for indexing to drain ─────────────────────────────────
# The capture's drain happens on a detached worker. Resolve queries the
# local skill index, which is populated by that worker. Without an explicit
# wait, resolve fires BEFORE the just-captured skill is indexed and returns
# empty. Poll the pending queue (max 15s) so resolve sees the fresh skill.
captured_skill_id="$(jq -r '.skill_id // empty' < "$pdir/capture.out" 2>/dev/null || true)"
if [ -n "$captured_skill_id" ]; then
  QPEND="${HOME:-/tmp}/.unbrowse/queue/pending"
  SNAPSHOT_DIR="${UNBROWSE_SKILL_SNAPSHOT_DIR:-${HOME:-/tmp}/.unbrowse/skill-snapshots}"
  deadline=$(( $(now_ms) + 15000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    # The snapshot filename is a hash of the scoped cache key, not the skill id.
    # Scan the isolated snapshot dir so resolve only runs after this probe's
    # freshly-captured skill is indexed and queryable.
    if find "$SNAPSHOT_DIR" -maxdepth 1 -name '*.json' -print0 2>/dev/null \
      | xargs -0 jq -e --arg id "$captured_skill_id" 'select(.skill_id == $id)' >/dev/null 2>&1; then
      break
    fi
    pending=$(ls "$QPEND"/*.json 2>/dev/null | wc -l | tr -d ' ')
    if [ "$pending" = "0" ]; then
      # Queue drained but the expected snapshot is absent. Keep polling briefly;
      # this catches the small gap between worker dequeue and snapshot write.
      sleep 0.2
      continue
    fi
    sleep 0.2
  done
fi

# ── Phase 2a: resolve ────────────────────────────────────────────────────
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

# ── Phase 2b: execute --raw ──────────────────────────────────────────────
skill_id="$(jq -r '.skill_id // empty' < "$pdir/resolve.pick.json" 2>/dev/null || true)"
endpoint_id="$(jq -r '.endpoint_id // empty' < "$pdir/resolve.pick.json" 2>/dev/null || true)"
t4=$(now_ms); t5="$t4"
if [ -n "$skill_id" ] && [ -n "$endpoint_id" ]; then
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
  echo '{"skipped":"no_skill_or_endpoint_from_resolve"}' > "$pdir/execute.meta.json"
  : > "$pdir/execute.out"
  : > "$pdir/execute.response.raw"
fi

printf '{"capture_ms":%d,"resolve_ms":%d,"execute_ms":%d}\n' \
  "$((t1-t0))" "$((t3-t2))" "$((t5-t4))" > "$pdir/timings.json"
