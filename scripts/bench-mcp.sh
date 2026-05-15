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
You are running a single bench probe. You have the unbrowse MCP server available with tools like unbrowse_resolve, unbrowse_execute, unbrowse_feedback, etc. Use ONLY those MCP tools. Do not shell out, do not edit files, do not call other MCP servers.

Probe:
- intent: "$intent"
- contextUrl: "$url"
- lane: $lane

Procedure:
1. Call unbrowse_resolve with the intent and contextUrl. Read the shortlist.
2. Pick the endpoint most likely to satisfy the intent for THIS contextUrl. If the shortlist is empty or only contains a clearly wrong endpoint, say so and stop.
3. Call unbrowse_execute on the chosen endpoint. If it returns an error_body, you may try one other endpoint from the shortlist; do not try more than two endpoints total.
4. If execute returns auth_required, browser cookies will already have been attempted upstream. Call unbrowse_reflect with intent_status="failed" and end with: "INTENT_NOT_SATISFIED: auth_required". Do NOT call unbrowse_auth_capture in this bench run (would pop a window).
5. If execute returns a vendor block (captcha, datadome, perimeterx, cloudflare challenge), call unbrowse_reflect with intent_status="failed" and end with: "INTENT_NOT_SATISFIED: blocked".
6. After a successful execute, call unbrowse_feedback with a rating (5=right+fast, 3=incomplete, 2=wrong endpoint, 1=useless). Then call unbrowse_reflect with intent_status.
7. End your turn with a single line: the most relevant concrete data field from the response that answers the intent (e.g. one product title for "search amazon", or one ticker price for "AAPL quote"). If you cannot satisfy the intent, end with exactly: "INTENT_NOT_SATISFIED: <reason>"

Headless mode is on; you cannot open a visible browser. Do not summarize the conversation. Do not invent data. Quote actual fields from the response.
)

  printf '%s' "$prompt" > "$pdir/prompt.txt"
  printf '{"pid":"%s","lane":"%s","auth":"%s","difficulty":"%s","strategy":"%s","intent":"%s","url":"%s"}\n' \
    "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" > "$pdir/probe.json"

  local model_flag=()
  if [ -n "$MODEL" ]; then model_flag=(-m "$MODEL"); fi

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
    "${model_flag[@]}" \
    "$prompt" \
    > "$pdir/events.jsonl" 2> "$pdir/codex.stderr.log" || true

  t1=$(date +%s)
  printf '{"pid":"%s","elapsed_s":%d}\n' "$pid" "$((t1 - t0))" > "$pdir/timing.json"
  echo "bench-mcp: $pid done ${((t1-t0))}s" >&2
}

export -f run_probe
export TIMEOUT MODEL

queue_to_nul() {
  awk 'BEGIN{ORS="\0"} {gsub("\t","\0"); print}' "$1"
}

if [ "$PARALLEL" -le 1 ]; then
  while IFS=$'\t' read -r pid lane auth difficulty strategy intent url pdir; do
    run_probe "$pid" "$lane" "$auth" "$difficulty" "$strategy" "$intent" "$url" "$pdir"
  done < "$QUEUE_FILE"
else
  queue_to_nul "$QUEUE_FILE" | xargs -0 -P "$PARALLEL" -n 8 bash -c 'run_probe "$@"' _
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
