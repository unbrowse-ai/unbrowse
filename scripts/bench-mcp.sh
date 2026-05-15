#!/usr/bin/env bash
# bench-mcp.sh — agentic bench: run codex CLI with the LOCAL unbrowse MCP server
# for each probe in the corpus. The agent calls unbrowse_resolve, picks an
# endpoint, calls unbrowse_execute, and returns a final answer. The harness
# only captures the trajectory; the human/agent judges from artifacts.
set -uo pipefail

CORPUS="${CORPUS:-harness/probes/corpus-gate.txt}"
TIMEOUT="${TIMEOUT:-180}"
PARALLEL="${PARALLEL:-1}"
LIMIT="${LIMIT:-}"
MODEL="${BENCH_MCP_MODEL:-}"
OUT_BASE="${OUT_BASE:-.bench-mcp}"

if [ ! -f "$CORPUS" ]; then
  echo "corpus not found: $CORPUS" >&2
  exit 2
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not in PATH" >&2
  exit 2
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$OUT_BASE/$RUN_ID"
mkdir -p "$RUN_DIR"
echo "bench-mcp: run-id=$RUN_ID out=$RUN_DIR cli=codex" >&2

QUEUE_FILE="$(mktemp)"
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
    auth=""; difficulty=""; strategy=""
    intent="${c2## }"; intent="${intent%% }"
    url="${c3## }"; url="${url%% }"
  fi
  i=$((i+1))
  if [ -n "$LIMIT" ] && [ "$i" -gt "$LIMIT" ]; then break; fi
  pid="$(printf '%03d_%s_%s' "$i" "$lane" "$url" | tr -c '[:alnum:]_' '_' | cut -c1-72)"
  pdir="$RUN_DIR/$pid"
  mkdir -p "$pdir"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" "$pdir" \
    >> "$QUEUE_FILE"
done < "$CORPUS"

N=$(wc -l < "$QUEUE_FILE" | tr -d ' ')
echo "bench-mcp: queued $N probe(s) parallel=$PARALLEL timeout=$TIMEOUT" >&2

run_probe() {
  local pid="$1" lane="$2" auth="$3" difficulty="$4" strategy="$5" intent="$6" url="$7" pdir="$8"
  local t0 t1
  t0=$(date +%s)

  local prompt
  prompt=$(cat <<EOF
You are running a single bench probe. You have the unbrowse MCP server available. Use ONLY unbrowse_* MCP tools. Do not shell out, do not edit files, do not call other MCP servers.

The MCP server is pointed at the STAGING marketplace (clean baseline: 0 skills). Every probe starts cold — there is nothing cached for this URL yet. Your job is the full flywheel: index this URL into staging, then retrieve from it.

Probe:
- intent: "$intent"
- contextUrl: "$url"
- lane: $lane

Single-trajectory procedure (capture → publish → resolve → execute → quote):
1. Call unbrowse_go with the contextUrl to open a headless browse session. The session passively captures HAR + fetch/XHR traffic.
2. (Optional) Call unbrowse_snap once to confirm the page loaded. If the snap shows a vendor-block / captcha shell, skip to step 7 with INTENT_NOT_SATISFIED: blocked.
3. Call unbrowse_close. This triggers the full enrichment pipeline (extractEndpoints, augment, buildSkillOperationGraph, cachePublishedSkill, queueBackgroundIndex). It publishes a skill to STAGING marketplace. Note the skill_id / endpoint count in the response.
4. Call unbrowse_resolve with the same intent and contextUrl. The just-published skill should now appear in the shortlist (marketplace winner instead of probe). If the shortlist is still empty, this is the bug we want to surface — say "INTENT_NOT_SATISFIED: publish_did_not_index" and stop. Do not retry.
5. Pick the endpoint from the shortlist that best matches the intent for THIS contextUrl. Call unbrowse_execute on it. If it returns an error_body, you may try one other endpoint from the shortlist; do not try more than two total.
5a. If unbrowse_execute returns "stale_endpoint" or any structured error with a "commands" / "next_step" array, you may follow it ONCE. The browse session from step 1 is still open — prefer unbrowse_text or unbrowse_markdown over reopening (skip the redundant unbrowse_go). Quote concrete data from the rendered DOM in step 7 instead of repeating the intent_not_satisfied loop.
6. After a successful execute OR a successful text/markdown read, call unbrowse_feedback (5=right+fast, 3=incomplete, 2=wrong endpoint, 1=useless). Then call unbrowse_reflect with intent_status (achieved/partial/failed).
7. End your turn with a single line: the most relevant concrete data field from the execute response (or text/markdown fallback) that answers the intent (e.g. one product title for "search amazon", one ticker price for "AAPL quote", one post title for "top hacker news stories"). If you cannot satisfy the intent, end with exactly: "INTENT_NOT_SATISFIED: <reason>"

Auth: if unbrowse_close or unbrowse_execute returns auth_required, call unbrowse_reflect intent_status=failed and end with "INTENT_NOT_SATISFIED: auth_required". Do NOT call unbrowse_auth_capture (would pop a window).
Vendor block: if you see captcha / datadome / perimeterx / cloudflare-challenge in any tool result, end with "INTENT_NOT_SATISFIED: blocked".

Headless mode is on; you cannot open a visible browser. Do not summarize the conversation. Do not invent data. Quote actual fields from the execute response.
EOF
)

  printf '%s' "$prompt" > "$pdir/prompt.txt"
  printf '{"pid":"%s","lane":"%s","auth":"%s","difficulty":"%s","strategy":"%s","intent":"%s","url":"%s"}\n' \
    "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" > "$pdir/probe.json"

  local model_flag=()
  if [ -n "$MODEL" ]; then model_flag=(-m "$MODEL"); fi

  # Staging marketplace URL (override default beta-api.unbrowse.ai). Set
  # UNBROWSE_BENCH_API_URL env to point at a different staging if needed.
  local bench_api_url="${UNBROWSE_BENCH_API_URL:-https://unbrowse-backend-staging.lewis-6d8.workers.dev}"

  # Redirect codex stdin to /dev/null so it cannot consume rows from the
  # while-read queue (BSD/macOS bash leaves stdin inherited even for foreground
  # children inside `while read; done <FILE`). The same issue bit the parallel
  # path via background-job stdin inheritance; belt-and-suspenders here.
  timeout "$TIMEOUT" codex exec \
    --json \
    --skip-git-repo-check \
    --dangerously-bypass-approvals-and-sandbox \
    --output-last-message "$pdir/last-message.txt" \
    -c 'mcp_servers.unbrowse.command="bun"' \
    -c "mcp_servers.unbrowse.args=[\"$(pwd)/src/cli.ts\",\"mcp\"]" \
    -c 'mcp_servers.unbrowse.env.UNBROWSE_BENCH_MCP="1"' \
    -c 'mcp_servers.unbrowse.env.HEADLESS="1"' \
    -c 'mcp_servers.unbrowse.env.KURI_HEADLESS="1"' \
    -c "mcp_servers.unbrowse.env.UNBROWSE_API_URL=\"$bench_api_url\"" \
    ${model_flag[@]+"${model_flag[@]}"} \
    "$prompt" \
    </dev/null \
    > "$pdir/events.jsonl" 2> "$pdir/codex.stderr.log" || true

  t1=$(date +%s)
  printf '{"pid":"%s","elapsed_s":%d}\n' "$pid" "$((t1 - t0))" > "$pdir/timing.json"
  echo "bench-mcp: $pid done $((t1-t0))s" >&2
}

export -f run_probe
export TIMEOUT MODEL

run_one() {
  local pid="$1" lane="$2" auth="$3" difficulty="$4" strategy="$5" intent="$6" url="$7" pdir="$8"
  run_probe "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" "$pdir"
}
export -f run_one

if [ "$PARALLEL" -le 1 ]; then
  while IFS=$'\t' read -r pid lane auth difficulty strategy intent url pdir; do
    run_one "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" "$pdir"
  done < "$QUEUE_FILE"
else
  # Portable bounded-parallelism: launch up to $PARALLEL background jobs, wait for
  # any slot to free before launching the next. BSD/macOS bash 3.2 compatible.
  # The previous xargs -0 -n 8 path lost positional args because BSD xargs collapses
  # adjacent NULs differently than GNU xargs, leaving $pdir empty.
  pids=()
  while IFS=$'\t' read -r pid lane auth difficulty strategy intent url pdir; do
    while [ "${#pids[@]}" -ge "$PARALLEL" ]; do
      new_pids=()
      for p in ${pids[@]+"${pids[@]}"}; do
        if kill -0 "$p" 2>/dev/null; then
          new_pids+=("$p")
        fi
      done
      pids=(${new_pids[@]+"${new_pids[@]}"})
      if [ "${#pids[@]}" -ge "$PARALLEL" ]; then sleep 0.5; fi
    done
    run_one "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" "$pdir" </dev/null &
    pids+=("$!")
  done < "$QUEUE_FILE"
  wait
fi

# Build manifest
{
  printf '{\n'
  printf '  "run_id": %s,\n' "\"$RUN_ID\""
  printf '  "corpus": %s,\n' "\"$CORPUS\""
  printf '  "started_at": %s,\n' "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  printf '  "probes": [\n'
  first=1
  while IFS=$'\t' read -r pid lane auth difficulty strategy intent url pdir; do
    if [ $first -eq 0 ]; then printf ',\n'; fi
    first=0
    printf '    {"probe_id":"%s","lane":"%s","auth":"%s","difficulty":"%s","strategy":"%s","intent":"%s","url":"%s"}' \
      "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url"
  done < "$QUEUE_FILE"
  printf '\n  ]\n'
  printf '}\n'
} > "$RUN_DIR/manifest.json"

echo "bench-mcp: manifest written $RUN_DIR/manifest.json" >&2
echo "$RUN_DIR"
