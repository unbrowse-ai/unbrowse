#!/bin/sh
# One fresh scratch node per round of tasks, all started now, and each client run's arguments written for the clients'
# step (gate-bank.yml). Each round's node is stopped when its round ends: on 17 Nov 2026 one debug node grew from 57 MB
# to 3.6 GB in 13 minutes of bank tasks (programme 887958, BASELINE.md §4), and a node that big times tasks out.
#
#   start-rounds.sh <runs dir> <node folder prefix> <first port> [run_gate.py's left/prepare options ...]
#
# The first run passes nothing more; the run again (UNB-307) passes `--again <ids file>` and its own folders and ports,
# so its tasks start on nodes that never saw the first run. Reads GATE, SCOPE, SHARD, SITES, CLAUDE_BIN, GITHUB_SHA,
# GITHUB_WORKSPACE and RUNNER_TEMP from the job.
set -eu
runs=$1 nodes=$2 port=$3
shift 3
mkdir -p "$GATE"
case "$SCOPE" in
  slice) set -- "$@" --slice test-banks/gate/slice.json; per=6 ;;
  top1k) set -- "$@" --bank test-banks/popular-sites/top-1000.json --shard "$SHARD" ${SITES:+--first "$SITES"}; per=12 ;;
  *) per=12 ;;
esac
left=$(python3 -I test-banks/gate/run_gate.py left --out "$GATE/results.jsonl" "$@")
rounds=$(( (left + per - 1) / per ))
# SCRATCH_NODE and PER are the test's stand-in. A job leaves both unset, so a stray PER cannot resize a round.
scratch=test-banks/popular-sites/scratch-node.sh
if [ -n "${SCRATCH_NODE:-}" ]; then
  scratch=$SCRATCH_NODE
  per=${PER:-$per}
  rounds=$(( (left + per - 1) / per ))
fi
# Jobs that start together would all probe the hint. A run steps its own pair past it. 400 pairs from 17810
# stay under the again-run's hint, 18810.
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  port=$((port + (GITHUB_RUN_ID % 400) * 2))
fi
# Anything accepting a connection counts, including a devnet that is not this node's /v1/health.
taken() {
  python3 -c 'import socket,sys
s=socket.socket(); s.settimeout(0.2)
try:
    raise SystemExit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
finally:
    s.close()' "$1"
}
# A scratch node also binds the next port for its devnet, so a free port is a free pair. 7788 is the owner's
# node: never connect to it, and never take 7787, whose devnet would be it.
free_pair() {
  p=$1
  if [ "$p" -lt 1024 ] || [ "$p" -gt 65533 ]; then
    return 1
  fi
  if [ "$p" -eq 7788 ] || [ $((p + 1)) -eq 7788 ]; then
    return 1
  fi
  if taken "$p" || taken $((p + 1)); then
    return 1
  fi
  return 0
}
mcps=""
r=0
while [ "$r" -lt "$rounds" ]; do
  dir="$RUNNER_TEMP/$nodes$r"
  try=$port
  got=""
  step=0
  while [ "$step" -lt 64 ]; do
    if free_pair "$try"; then
      if PORT=$try sh "$scratch" "$dir" > "$GATE/$nodes-node-$r.log" 2>&1; then
        got=$try
        break
      fi
      # The port went between the look and the start. scratch-node refuses before it writes; try the next one.
      if grep -q "already answers" "$GATE/$nodes-node-$r.log"; then
        try=$((try + 1))
        step=$((step + 1))
        continue
      fi
      cat "$GATE/$nodes-node-$r.log" >&2
      exit 1
    fi
    try=$((try + 1))
    step=$((step + 1))
  done
  if [ -z "$got" ]; then
    echo "scratch-node: no free port from $port" >&2
    exit 1
  fi
  echo "round $r on 127.0.0.1:$got"
  token=$(cat "$dir/token")
  echo "::add-mask::$token"
  if [ "${HISTORICAL_BEARER_MCP:-0}" = 1 ]; then
    mcp_command=$(command -v python3)
    mcp_args=$(jq -cn --arg script "$GITHUB_WORKSPACE/test-banks/gate/historical_mcp.py" '["-I", $script]')
  else
    mcp_command="${UNB_MCP:-$GITHUB_WORKSPACE/unbrowse-node/target/debug/unb}"
    mcp_args='["mcp"]'
  fi
  jq -n --arg command "$mcp_command" --argjson args "$mcp_args" --arg token "$token" --arg node "http://127.0.0.1:$got" \
    '{mcpServers: {unbrowse: {command: $command, args: $args, env: {UNBROWSE_NODE: $node, UNBROWSE_AGENT_TOKEN: $token}}}}' > "$dir/mcp.json"
  rm -f "$dir/token"
  mcps="$mcps --mcp $dir/mcp.json"
  port=$((got + 2))
  r=$((r + 1))
done
[ "$rounds" -gt 0 ] || { echo "nothing left to run"; mkdir -p "$runs"; exit 0; }
# shellcheck disable=SC2086 # one --mcp per round
python3 -I test-banks/gate/run_gate.py prepare --dir "$runs" $mcps --per "$per" "$@" \
  --out "$GATE/results.jsonl" --claude "$CLAUDE_BIN" --build "$GITHUB_SHA debug"
echo "$left task(s) in $rounds round(s)"
