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
#       resolve.shortlist.json  raw stdout of `unbrowse resolve --no-execute`
#       resolve.pick.json       top-1 endpoint pick (delegated to product ranker)
#       execute.out             raw stdout of `unbrowse execute --raw`
#       execute.response.raw    response body extracted from execute.out
#       execute.meta.json       status_code, response_bytes, decision_trace
#       timings.json            per-phase ms

set -uo pipefail

CORPUS="${CORPUS:-harness/probes/corpus-gate.txt}"
OUT_DIR="${OUT_DIR:-.bench-gate}"
CLI_CMD="${UNBROWSE:-unbrowse}"
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

probes_json="["
first=1
i=0
while IFS='|' read -r lane intent url; do
  lane="${lane## }"; lane="${lane%% }"
  intent="${intent## }"; intent="${intent%% }"
  url="${url## }"; url="${url%% }"
  case "$lane" in ''|\#*) continue ;; esac
  i=$((i+1))
  if [ "$LIMIT" -gt 0 ] && [ "$i" -gt "$LIMIT" ]; then break; fi

  pid="$(printf '%03d_%s' "$i" "$(probe_slug "$lane" "$url")")"
  pdir="$RUN_DIR/$pid"
  mkdir -p "$pdir"
  err "[$i] $lane | $intent | $url"

  # ── Phase 1: capture ──────────────────────────────────────────────────
  t0=$(now_ms)
  timeout "$TIMEOUT" "$CLI_CMD" capture --url "$url" --intent "$intent" \
    </dev/null > "$pdir/capture.out" 2> "$pdir/capture.stderr.log" || true
  t1=$(now_ms)
  # Derive signals from capture.out. If it's not JSON we still keep the raw
  # text — the judge can read it.
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

  # HTML excerpt — try to read capture_path if it's a file, else best-effort blank
  cap_path="$(jq -r '.capture_path // empty' < "$pdir/capture.meta.json" 2>/dev/null || true)"
  if [ -n "$cap_path" ] && [ -f "$cap_path" ]; then
    head -c 8192 "$cap_path" > "$pdir/capture.html.excerpt" 2>/dev/null || true
  else
    : > "$pdir/capture.html.excerpt"
  fi

  # ── Phase 2a: resolve (no auto-execute; harness controls execute) ─────
  t2=$(now_ms)
  timeout "$TIMEOUT" "$CLI_CMD" resolve --intent "$intent" --url "$url" --no-execute \
    </dev/null > "$pdir/resolve.shortlist.json" 2> "$pdir/resolve.stderr.log" || true
  t3=$(now_ms)

  # ── Pick: delegate to product ranker; we take the first candidate ─────
  # NB: NO heuristic scoring here. Product's resolve output is already ranked.
  # Try multiple shapes — resolve returns different envelopes per status.
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
    timeout "$TIMEOUT" "$CLI_CMD" execute --skill "$skill_id" --endpoint "$endpoint_id" --raw \
      </dev/null > "$pdir/execute.out" 2> "$pdir/execute.stderr.log" || true
    t5=$(now_ms)
    jq -c '{
      status_code: (.result.status // .status // null),
      response_bytes: (.result.body | tostring | length),
      decision_trace: (.trace // .decision_trace // [])
    }' < "$pdir/execute.out" > "$pdir/execute.meta.json" 2>/dev/null || echo '{}' > "$pdir/execute.meta.json"
    jq -r '.result.body // .result // empty' < "$pdir/execute.out" > "$pdir/execute.response.raw" 2>/dev/null || : > "$pdir/execute.response.raw"
  else
    echo '{"skipped":"no_skill_or_endpoint_from_resolve"}' > "$pdir/execute.meta.json"
    : > "$pdir/execute.out"
    : > "$pdir/execute.response.raw"
  fi

  printf '{"capture_ms":%d,"resolve_ms":%d,"execute_ms":%d}\n' \
    "$((t1-t0))" "$((t3-t2))" "$((t5-t4))" > "$pdir/timings.json"

  if [ $first -eq 0 ]; then probes_json="$probes_json,"; fi
  first=0
  probes_json="$probes_json$(jq -nc \
    --arg id "$pid" --arg lane "$lane" --arg intent "$intent" --arg url "$url" \
    '{probe_id:$id, lane:$lane, intent:$intent, url:$url}')"
done < "$CORPUS"
probes_json="$probes_json]"

# ── manifest.json (NO verdict field anywhere) ───────────────────────────
cli_version="$($CLI_CMD --version 2>/dev/null || echo unknown)"
node_version="$(node --version 2>/dev/null || echo unknown)"
jq -nc \
  --arg run_id "$RUN_ID" --arg corpus "$CORPUS" \
  --arg cli_version "$cli_version" --arg node_version "$node_version" \
  --arg started "$(date -u +%FT%TZ)" --argjson probes "$probes_json" \
  '{run_id:$run_id, corpus:$corpus, cli_version:$cli_version, node_version:$node_version, started_at:$started, probes:$probes}' \
  > "$RUN_DIR/manifest.json"

err "bench-gate: wrote $RUN_DIR/manifest.json with $i probe(s)"
printf '%s\n' "$RUN_DIR"
