#!/usr/bin/env bash
# bench-converge/orchestrate.sh — wave-based codex-yolo convergence loop.
#
# Per wave:
#   1. Spawn N codex workers in parallel (xargs -P PARALLEL) — one per
#      non-PASS probe. Each worker has its OWN UNBROWSE_HOME (per-probe
#      dir) so the 50 bun-src-mcp processes don't share state. Each
#      worker runs `codex exec --yolo --json` so its full event stream
#      (every MCP tool call + response) lands in codex-trace.jsonl,
#      and writes its verdict to result.json per the worker prompt.
#   2. When all workers complete (or time out): if every probe is PASS
#      or EXCLUDED, write `.bench-gate/stamp.mcp.json` and exit 0.
#   3. Otherwise spawn ONE codex aggregator that reads every probe's
#      result.json + codex-trace.jsonl and writes a ranked `bugs.md`
#      grouping failures by ROOT CAUSE (not by site).
#   4. Loop bugs.md top to bottom. For each bug spawn ONE codex fix-
#      agent (serial, never parallel — they all commit to the same
#      branch). After each fix, re-smoke the 4 anchors; if any anchor
#      goes red, `git revert` the fix and skip the bug. Stop when bugs
#      list exhausted or wall-budget exceeded.
#   5. Next wave re-runs ONLY the still-non-PASS probes against the
#      new commits. Resumable via ledger.jsonl.
#
# Per CLAUDE.md: harness collects + agent judges; substrate enables,
# never prescribes. This script never decides PASS/FAIL or root cause;
# the codex worker judges its own probe and the codex aggregator
# groups failures across workers.
#
# Usage:
#   bash scripts/bench-converge/orchestrate.sh
#   bash scripts/bench-converge/orchestrate.sh --parallel 50
#   bash scripts/bench-converge/orchestrate.sh --limit 10
#   bash scripts/bench-converge/orchestrate.sh --max-waves 3
#   bash scripts/bench-converge/orchestrate.sh --no-fix
#   bash scripts/bench-converge/orchestrate.sh --dry-run --limit 5
#   bash scripts/bench-converge/orchestrate.sh --resume <run-id>
#
# Env:
#   CODEX_BIN                                   path to codex
#   BENCH_CONVERGE_PARALLEL                     default 50
#   BENCH_CONVERGE_WORKER_TIMEOUT_S             default 300 (5 min)
#   BENCH_CONVERGE_MAX_WAVES                    default 4
#   BENCH_CONVERGE_BUDGET_SECONDS               default 14400 (4h)
#   BENCH_CONVERGE_THRESHOLD_INDEX              default 0.80
#   BENCH_CONVERGE_THRESHOLD_RETRIEVE           default 0.65
#
set -uo pipefail

export REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

CORPUS="${CORPUS:-harness/probes/corpus-gate.txt}"
LIMIT="${LIMIT:-0}"
RESUME=""
export DRY_RUN=0
NO_FIX=0
export CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
export BENCH_CONVERGE_PARALLEL="${BENCH_CONVERGE_PARALLEL:-50}"
export WORKER_TIMEOUT_S="${BENCH_CONVERGE_WORKER_TIMEOUT_S:-300}"
MAX_WAVES="${BENCH_CONVERGE_MAX_WAVES:-4}"
BUDGET_SECONDS="${BENCH_CONVERGE_BUDGET_SECONDS:-14400}"
THRESH_INDEX="${BENCH_CONVERGE_THRESHOLD_INDEX:-0.80}"
THRESH_RETRIEVE="${BENCH_CONVERGE_THRESHOLD_RETRIEVE:-0.65}"

while [ $# -gt 0 ]; do
  case "$1" in
    --corpus)     CORPUS="$2"; shift 2 ;;
    --limit)      LIMIT="$2"; shift 2 ;;
    --resume)     RESUME="$2"; shift 2 ;;
    --parallel)   BENCH_CONVERGE_PARALLEL="$2"; export BENCH_CONVERGE_PARALLEL; shift 2 ;;
    --max-waves)  MAX_WAVES="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; export DRY_RUN; shift ;;
    --no-fix)     NO_FIX=1; shift ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *)            echo "[bench-converge] unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Anchor probe_ids (corpus-gate.txt ordering). MUST stay green; any fix
# breaking these is reverted. Pick anchors that are stable + no-auth +
# no anti-bot.
ANCHOR_IDS=("001_anchor" "004_anchor" "006_anchor" "007_anchor")

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yel() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
grn() { printf '\033[32m%s\033[0m\n' "$*" >&2; }
log() { printf '[bench-converge] %s\n' "$*" >&2; }

if [ -z "$CODEX_BIN" ] && [ "$DRY_RUN" = "0" ]; then
  red "codex binary not found in PATH. Install codex-cli or pass CODEX_BIN=/path/to/codex."
  exit 2
fi
if ! command -v xargs >/dev/null 2>&1; then
  red "xargs required for parallel fan-out"; exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  red "jq required"; exit 2
fi

# ── run dir + ledger ──────────────────────────────────────────────────
if [ -n "$RESUME" ]; then
  RUN_ID="$RESUME"
  export RUN_DIR=".bench-converge/runs/$RUN_ID"
  if [ ! -d "$RUN_DIR" ]; then red "resume target $RUN_DIR not found"; exit 2; fi
  log "resuming run $RUN_ID"
else
  RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
  export RUN_DIR=".bench-converge/runs/$RUN_ID"
  mkdir -p "$RUN_DIR/probes" "$RUN_DIR/waves"
  log "starting run $RUN_ID -> $RUN_DIR (parallel=$BENCH_CONVERGE_PARALLEL, max_waves=$MAX_WAVES)"
fi
LEDGER="$RUN_DIR/ledger.jsonl"
touch "$LEDGER"

# ── parse corpus ──────────────────────────────────────────────────────
export PROBES_JSONL="$RUN_DIR/probes.jsonl"
: > "$PROBES_JSONL"
i=0
while IFS='|' read -r lane c2 c3 c4 c5 c6 _rest; do
  lane="${lane## }"; lane="${lane%% }"
  case "$lane" in ''|\#*) continue ;; esac
  intent="${c5## }"; intent="${intent%% }"
  url="${c6## }"; url="${url%% }"
  i=$((i+1))
  [ "$LIMIT" -gt 0 ] && [ "$i" -gt "$LIMIT" ] && break
  probe_id="$(printf '%03d_%s' "$i" "$lane")"
  jq -nc --arg pid "$probe_id" --arg lane "$lane" --arg intent "$intent" --arg url "$url" \
    '{probe_id:$pid, lane:$lane, intent:$intent, url:$url}' >> "$PROBES_JSONL"
done < "$CORPUS"
N_PROBES=$(wc -l < "$PROBES_JSONL" | tr -d ' ')
log "queued $N_PROBES probe(s)"

# ── helpers ───────────────────────────────────────────────────────────

# pending_probes -> JSONL of probes that are NOT yet PASS in the ledger
pending_probes() {
  if [ ! -s "$LEDGER" ]; then
    cat "$PROBES_JSONL"; return
  fi
  local passed
  passed="$(jq -r 'select(.verdict=="PASS") | .probe_id' < "$LEDGER" | sort -u)"
  if [ -z "$passed" ]; then cat "$PROBES_JSONL"; return; fi
  # filter out PASS rows
  jq -c --argjson p "$(jq -R -s -c 'split("\n") | map(select(length>0))' <<<"$passed")" \
    'select((.probe_id|IN($p[])) | not)' < "$PROBES_JSONL"
}

# coverage -> JSON object computed from the ledger
coverage() {
  if [ ! -s "$LEDGER" ]; then
    echo '{"index_pass":0,"retrieve_pass":0,"denom":0,"index_rate":0,"retrieve_rate":0,"total":0,"excluded":0,"failed":0}'; return
  fi
  jq -s '
    # Use only the LATEST row per probe_id, bound to $rows so every
    # subsequent map/length pipeline reads the same array (without the
    # binding, `map(...) | length as $excluded` would consume the array
    # and the next `map(...)` would see the integer instead of the rows).
    group_by(.probe_id) | map(sort_by(.ts // "") | last) as $rows
    | ($rows | length) as $total
    | ($rows | map(select(.verdict | test("^EXCLUDED"))) | length) as $excluded
    | ($total - $excluded) as $denom
    | ($rows | map(select(.verdict=="PASS")) | length) as $pass
    | ($rows | map(select(.verdict=="PASS" and .indexed==true)) | length) as $idx_pass
    | ($rows | map(select(.verdict | test("^FAIL"))) | length) as $failed
    | { total: $total, excluded: $excluded, denom: $denom, failed: $failed,
        index_pass: $idx_pass, retrieve_pass: $pass,
        index_rate:    (if $denom > 0 then ($idx_pass / $denom) else 0 end),
        retrieve_rate: (if $denom > 0 then ($pass    / $denom) else 0 end) }
  ' < "$LEDGER"
}

# write_ledger_row <probe_id> <wave>
# Reads $RUN_DIR/probes/<probe_id>/result.json and appends a row.
write_ledger_row() {
  local pid="$1" wave="$2"
  local rp="$RUN_DIR/probes/$pid/result.json"
  if [ ! -s "$rp" ]; then
    jq -nc --arg run "$RUN_ID" --arg pid "$pid" --arg wave "$wave" \
           --arg sha "$(git rev-parse HEAD)" --arg ts "$(date -u +%FT%TZ)" \
      '{run_id:$run, wave:($wave|tonumber), probe_id:$pid, verdict:"WORKER_CRASH",
        indexed:false, reason:"no result.json after worker run",
        head_sha:$sha, ts:$ts}' >> "$LEDGER"
    return
  fi
  local outc reason indexed lane intent url
  outc="$(jq -r '.outcome' < "$rp")"
  reason="$(jq -r '.outcome_reason // ""' < "$rp")"
  indexed="$(jq -r '(.phases.browse_close.indexed // false) | tostring' < "$rp")"
  lane="$(jq -r '.lane'   < "$rp")"
  intent="$(jq -r '.intent' < "$rp")"
  url="$(jq -r '.url'    < "$rp")"
  jq -nc --arg run "$RUN_ID" --arg pid "$pid" --arg wave "$wave" \
         --arg lane "$lane" --arg intent "$intent" --arg url "$url" \
         --arg verdict "$outc" --arg reason "$reason" \
         --arg sha "$(git rev-parse HEAD)" --arg ts "$(date -u +%FT%TZ)" \
         --argjson indexed "$indexed" \
    '{run_id:$run, wave:($wave|tonumber), probe_id:$pid, lane:$lane, intent:$intent,
      url:$url, verdict:$verdict, indexed:$indexed, reason:$reason,
      head_sha:$sha, ts:$ts}' >> "$LEDGER"
}

# anchor_smoke -> 0 if every anchor probe still PASSes (re-runs them now).
anchor_smoke() {
  local wave="$1"
  log "  anchor smoke (wave $wave): ${ANCHOR_IDS[*]}"
  for aid in "${ANCHOR_IDS[@]}"; do
    if ! jq -e --arg p "$aid" 'select(.probe_id==$p)' < "$PROBES_JSONL" >/dev/null 2>&1; then
      continue
    fi
    bash "$REPO/scripts/bench-converge/run-worker.sh" "$aid" || true
    local outc; outc="$(jq -r '.outcome' < "$RUN_DIR/probes/$aid/result.json" 2>/dev/null || echo "")"
    if [ "$outc" != "PASS" ]; then
      red "  anchor $aid went red ($outc) — regression"
      return 1
    fi
  done
  return 0
}

# run_wave_workers <wave_num>
# Reads pending_probes(), fans them out via xargs -P, writes ledger rows.
run_wave_workers() {
  local wave="$1"
  local wave_dir="$RUN_DIR/waves/wave-$wave"
  mkdir -p "$wave_dir"
  pending_probes > "$wave_dir/pending.jsonl"
  local n; n=$(wc -l < "$wave_dir/pending.jsonl" | tr -d ' ')
  if [ "$n" = "0" ]; then return 0; fi
  log "wave $wave: dispatching $n worker(s) at parallel=$BENCH_CONVERGE_PARALLEL"
  jq -r '.probe_id' < "$wave_dir/pending.jsonl" \
    | xargs -P "$BENCH_CONVERGE_PARALLEL" -I {} \
        bash "$REPO/scripts/bench-converge/run-worker.sh" "{}" \
    2> "$wave_dir/workers.stderr"
  # Ingest results into the ledger
  while IFS= read -r row; do
    local pid; pid="$(jq -r '.probe_id' <<<"$row")"
    write_ledger_row "$pid" "$wave"
  done < "$wave_dir/pending.jsonl"
  local cov; cov="$(coverage)"
  log "wave $wave coverage: $cov"
  echo "$cov" > "$wave_dir/coverage.json"
}

# run_aggregator <wave_num> -> writes wave-dir/bugs.md
run_aggregator() {
  local wave="$1"
  local wave_dir="$RUN_DIR/waves/wave-$wave"
  local bugs_path="$wave_dir/bugs.md"
  local n; n=$(wc -l < "$wave_dir/pending.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
  if [ "$DRY_RUN" = "1" ]; then
    cat > "$bugs_path" <<EOF
# Bench-converge bugs — run $RUN_ID (dry-run)

Wave summary: synthetic dry-run wave; no real bugs to report.
EOF
    return 0
  fi
  if [ -z "$CODEX_BIN" ]; then return 2; fi
  log "wave $wave: spawning aggregator over $n probe traces"
  local prompt
  prompt="$(sed \
    -e "s|{{RUN_ID}}|$RUN_ID|g" \
    -e "s|{{RUN_DIR}}|$RUN_DIR|g" \
    -e "s|{{BUGS_PATH}}|$bugs_path|g" \
    -e "s|{{N_PROBES}}|$n|g" \
    "$REPO/scripts/bench-converge/prompts/aggregate-bugs.md")"
  timeout --foreground 900 \
    "$CODEX_BIN" exec \
      --yolo \
      --cd "$REPO" \
      --output-last-message "$wave_dir/aggregator.last-message.txt" \
      "$prompt" \
    > "$wave_dir/aggregator-trace.jsonl" 2>&1 || true
  [ -s "$bugs_path" ]
}

# run_fix_for_bug <wave> <bug_index> <bug_block>
# bug_block is the raw markdown for that bug (lines from `## Bug N` to next `## `).
run_fix_for_bug() {
  local wave="$1" idx="$2" bug_block="$3"
  if [ "$NO_FIX" = "1" ] || [ "$DRY_RUN" = "1" ]; then return 1; fi
  local fix_dir="$RUN_DIR/waves/wave-$wave/fix-$idx"
  mkdir -p "$fix_dir"
  printf '%s\n' "$bug_block" > "$fix_dir/bug.md"
  local pre_sha; pre_sha="$(git rev-parse HEAD)"
  local prompt
  prompt="$(sed \
    -e "s|{{RUN_ID}}|$RUN_ID|g" \
    -e "s|{{BUG_PATH}}|$fix_dir/bug.md|g" \
    "$REPO/scripts/bench-converge/prompts/probe-fix.md")"
  timeout --foreground 900 \
    "$CODEX_BIN" exec \
      --yolo \
      --cd "$REPO" \
      --output-last-message "$fix_dir/last-message.txt" \
      "$prompt" \
    > "$fix_dir/codex-trace.jsonl" 2>&1 || true
  local post_sha; post_sha="$(git rev-parse HEAD)"
  if [ "$pre_sha" = "$post_sha" ]; then
    yel "  bug $idx: fix-agent produced no commit (diagnosis only)"
    return 1
  fi
  log "  bug $idx: $pre_sha -> $post_sha"
  if anchor_smoke "$wave"; then
    grn "  bug $idx: anchors green — keeping commit $post_sha"
    return 0
  else
    red "  bug $idx: anchors RED — reverting"
    git revert --no-edit "$post_sha" >/dev/null 2>&1 \
      || git reset --hard "$pre_sha"
    return 2
  fi
}

# split_bugs_md <bugs.md> -> writes one bug-block per `## Bug N` section
# to $wave_dir/fix-N/bug.md AND echoes the block to stdout via NUL records.
iter_bugs() {
  local bugs_md="$1"
  # awk: emit blocks separated by `## Bug ` headers, NUL-terminated
  awk 'BEGIN{RS=""; ORS="\0"}
       /^## Bug /{print; next}' "$bugs_md" 2>/dev/null \
    || true
}

write_stamp_if_promote() {
  local cov; cov="$(coverage)"
  local idx_rate ret_rate denom
  idx_rate="$(jq -r '.index_rate'    <<<"$cov")"
  ret_rate="$(jq -r '.retrieve_rate' <<<"$cov")"
  denom="$(jq -r '.denom'            <<<"$cov")"
  local pass_idx pass_ret
  pass_idx=$(awk -v a="$idx_rate" -v b="$THRESH_INDEX"    'BEGIN{ exit !(a+0 >= b+0) }' && echo 1 || echo 0)
  pass_ret=$(awk -v a="$ret_rate" -v b="$THRESH_RETRIEVE" 'BEGIN{ exit !(a+0 >= b+0) }' && echo 1 || echo 0)
  if [ "$pass_idx" = "1" ] && [ "$pass_ret" = "1" ] && [ "$denom" -gt 0 ]; then
    local stamp=".bench-gate/stamp.mcp.json"
    mkdir -p "$(dirname "$stamp")"
    jq -nc --arg run "$RUN_ID" --arg sha "$(git rev-parse HEAD)" \
           --arg corpus "$CORPUS" --arg ts "$(date -u +%FT%TZ)" \
           --argjson coverage "$cov" \
           --arg thr_idx "$THRESH_INDEX" --arg thr_ret "$THRESH_RETRIEVE" \
      '{gate_passed:true, run_id:$run, commit_sha:$sha, corpus:$corpus,
        stamped_at:$ts, coverage:$coverage,
        thresholds:{index:$thr_idx|tonumber, retrieve:$thr_ret|tonumber},
        transport:"codex-exec-yolo", driver:"bench-converge/orchestrate.sh"}' \
      > "$stamp"
    grn "PROMOTE: index=$idx_rate retrieve=$ret_rate denom=$denom -> wrote $stamp"
    return 0
  fi
  return 1
}

# ── main wave loop ────────────────────────────────────────────────────
START_TS="$(date +%s)"
wave=0
while [ "$wave" -lt "$MAX_WAVES" ]; do
  wave=$((wave+1))
  now="$(date +%s)"
  if [ $((now - START_TS)) -ge "$BUDGET_SECONDS" ]; then
    yel "budget exhausted ($BUDGET_SECONDS s) — stopping at wave $wave"; break
  fi

  log "═══ wave $wave / $MAX_WAVES ═══"

  # 1. workers
  run_wave_workers "$wave"

  # 2. promote check
  if write_stamp_if_promote; then
    log "next: git add .bench-gate/stamp.mcp.json && git commit -m \"chore: mcp-gate stamp $RUN_ID\""
    exit 0
  fi

  # 3. aggregate bugs
  if [ "$NO_FIX" = "1" ]; then
    yel "wave $wave: --no-fix; skipping aggregator + fix loop"
    continue
  fi
  if ! run_aggregator "$wave"; then
    yel "wave $wave: aggregator wrote no bugs.md — nothing more to fix"
    break
  fi
  bugs_md="$RUN_DIR/waves/wave-$wave/bugs.md"
  log "wave $wave: bugs.md at $bugs_md"

  # 4. iterate bugs, one fix per bug, anchor smoke between
  bug_idx=0
  # iter_bugs emits NUL-separated `## Bug N ...` blocks
  while IFS= read -r -d '' block; do
    [ -z "$block" ] && continue
    bug_idx=$((bug_idx+1))
    log "wave $wave bug $bug_idx: applying fix"
    run_fix_for_bug "$wave" "$bug_idx" "$block" || true
    # budget check between fixes
    now="$(date +%s)"
    if [ $((now - START_TS)) -ge "$BUDGET_SECONDS" ]; then
      yel "budget exhausted mid-fix"; break 2
    fi
  done < <(iter_bugs "$bugs_md")
done

# ── final verdict ─────────────────────────────────────────────────────
FINAL_COV="$(coverage)"
log "final coverage: $FINAL_COV"
echo "$FINAL_COV" > "$RUN_DIR/coverage.json"
if write_stamp_if_promote; then exit 0; fi
red "HOLD: $(jq -c . <<<"$FINAL_COV")  (need index >= $THRESH_INDEX, retrieve >= $THRESH_RETRIEVE)"
exit 1
