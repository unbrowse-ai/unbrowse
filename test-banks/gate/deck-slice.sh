#!/bin/sh
# The gate's short slice on a pull request to staging, run on the Deck by its hub (UNB-208, Lewis 17 Nov 23:14): the
# model runs on the Deck's own Claude login, so no model key sits in a pull_request workflow. Each call takes one open
# pull request into staging whose head has no `unb-208/task-slice` status yet (or SLICE_PR=<n>), builds that head
# (debug: test-banks/popular-sites/scratch-node.sh takes no other), starts a scratch node on it, runs the slice's
# tasks through its MCP with the bank's runner and judge, and posts the gate's verdict as the commit status.
#
# The runner, judge, bank, slice, scratch-node script and gate come from HARNESS_REF (origin/staging), never from the
# pull request: a pull request can't change how it is judged. Only pull requests from this repository are taken (no
# forks): the head's code runs on the Deck. Nothing starts while Claude's week is at 94% or more, or the box has less
# than 4 GB free; such a call posts nothing and the next one tries again.
#
#   sh deck-slice.sh                 # one pull request, the oldest without a status
#   SLICE_PR=621 sh deck-slice.sh    # that one, even if it has a status
# Settings (env): SLICE_SRC (worktree the head is built in), SLICE_TARGET (its cargo target), SLICE_WORK (scratch),
# SLICE_RUNS (kept results, one folder per head), SLICE_PORT, CHROME, NODE_BIN (folder holding a `node` for signing),
# HARNESS_REF, HUB (the hub's address, for the usage reading).
set -eu
REPO=unbrowse-ai/unbrowse-core
CTX=unb-208/task-slice
SRC=${SLICE_SRC:-$HOME/work/unbrowse-core-slice}
export CARGO_TARGET_DIR=${SLICE_TARGET:-$HOME/cargo-target-pr-slice}
WORK=${SLICE_WORK:-/tmp/unb208-slice}
RUNS=${SLICE_RUNS:-$HOME/u208-slice-runs}
PORT=${SLICE_PORT:-17840}
CHROME=${CHROME:-$HOME/.agent-browser/browsers/chrome-157.0.8103.78/chrome}
HARNESS_REF=${HARNESS_REF:-origin/staging}
HUB=${HUB:-http://127.0.0.1:8084}
NODE_BIN=${NODE_BIN:-$HOME/work/unb165-node26/node-v26.13.1-linux-x64/bin}
[ -d "$NODE_BIN" ] && PATH=$NODE_BIN:$PATH
unset UNBROWSE_RELEASE

say() { echo "deck-slice: $*"; }
status() { # state description
  gh api -X POST "repos/$REPO/statuses/$sha" -f state="$1" -f context="$CTX" -f description="$(printf %s "$2" | cut -c1-140)" > /dev/null
  say "status $1 on $sha: $2"
}

week=$(curl -s -m 10 "$HUB/api/usage?demand=0" | python3 -c "import json,sys; print(int(json.load(sys.stdin)['seven_day']['utilization_pct']))" 2>/dev/null || echo 0)
[ "$week" -lt 94 ] || { say "Claude's week at $week%: not starting"; exit 0; }
free_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
[ "$free_kb" -ge 4000000 ] || { say "box has $((free_kb / 1024)) MB free: not starting"; exit 0; }

# The pull request: SLICE_PR, else the oldest open one into staging, from this repository, with no status of ours.
prs=$(gh pr list --repo "$REPO" --base staging --state open --limit 100 --json number,headRefOid,isCrossRepository \
  --jq 'sort_by(.number) | .[] | select(.isCrossRepository | not) | "\(.number) \(.headRefOid)"')
pr= sha=
while read -r n h; do
  [ -n "$n" ] || continue
  if [ -n "${SLICE_PR:-}" ]; then
    [ "$n" = "$SLICE_PR" ] && { pr=$n sha=$h; break; }
    continue
  fi
  seen=$(gh api "repos/$REPO/commits/$h/statuses?per_page=100" --jq "[.[] | select(.context == \"$CTX\")] | length")
  [ "$seen" = 0 ] && { pr=$n sha=$h; break; }
done <<EOF
$prs
EOF
[ -n "$pr" ] || { say "no pull request waiting"; exit 0; }
say "PR #$pr head $sha"
status pending "Deck hub: building the head and running the slice"

out=$RUNS/$(printf %s "$sha" | cut -c1-12)
rm -rf "$WORK" "$out"
mkdir -p "$WORK/bin/debug" "$WORK/h" "$out"
node_pid=
cleanup() { [ -n "$node_pid" ] && kill "$node_pid" 2>/dev/null; cp "$WORK/node/node.log" "$out/" 2>/dev/null || true; }
trap cleanup EXIT

# Build the head. A build that fails is the pull request's, not the slice's: status error.
git -C "$SRC" fetch -q origin "$sha" staging
git -C "$SRC" checkout -q --detach "$sha"
if ! (cd "$SRC/unbrowse-node" && { [ -d vendor/btls-sys ] || sh scripts/apply-tls-patch.sh; } \
      && nice -n 10 cargo build -j4 --locked --bin unbrowse-node --bin unb \
      && cd ../unbrowse-browser/cli && nice -n 10 cargo build -j4 --locked) > "$out/build.log" 2>&1; then
  status error "the head did not build on the Deck (debug); see $out/build.log there"
  exit 1
fi
cp "$CARGO_TARGET_DIR/debug/unbrowse-node" "$CARGO_TARGET_DIR/debug/unb" "$CARGO_TARGET_DIR/debug/agent-browser" "$WORK/bin/debug/"

# The harness, from staging.
git -C "$SRC" archive "$HARNESS_REF" test-banks/gate test-banks/popular-sites/scratch-node.sh .github/scripts/promotion_gate.py | tar -x -C "$WORK/h"
H=$WORK/h
NODE=$WORK/bin/debug/unbrowse-node BROWSER_PROGRAM=$WORK/bin/debug/agent-browser CHROME=$CHROME PORT=$PORT \
  sh "$H/test-banks/popular-sites/scratch-node.sh" "$WORK/node" > "$out/node-start.log" 2>&1 \
  || { status error "the head's node did not start on the Deck; see $out/node-start.log there"; exit 1; }
node_pid=$(cat "$WORK/node/node.pid")
umask 077
cat > "$WORK/mcp.json" <<JSON
{"mcpServers": {"unbrowse": {"command": "$WORK/bin/debug/unb", "args": ["mcp"],
  "env": {"UNBROWSE_NODE": "http://127.0.0.1:$PORT", "UNBROWSE_AGENT_TOKEN": "$(cat "$WORK/node/token")"}}}}
JSON

# The slice; a task that met infrastructure trouble (no server, no verdict) is run once more.
for _ in 1 2; do
  python3 "$H/test-banks/gate/run_gate.py" run --mcp "$WORK/mcp.json" --out "$out/results.jsonl" \
    --slice "$H/test-banks/gate/slice.json" --jobs 3 --timeout 900 --build "PR #$pr $sha debug" >> "$out/run.log" 2>&1
done

G=$H/test-banks/gate
set +e
python3 "$H/.github/scripts/promotion_gate.py" check --tasks-only --bank "$G/bank.json" --bank-results "$out/results.jsonl" \
  --slice "$G/slice.json" --baseline "$G/promoted.json" --rereads "$G/rereads.json" --md "$out/verdict.md" > "$out/verdict.txt" 2>&1
rc=$?
set -e
counts=$(python3 - "$out/results.jsonl" <<'PY'
import collections, json, sys
last = {}
for line in open(sys.argv[1]):
    if line.strip():
        r = json.loads(line)
        last[r["id"]] = r["outcome"]
c = collections.Counter(last.values())
print(", ".join(f"{n} {k.replace('_', ' ')}" for k, n in sorted(c.items(), key=lambda kv: -kv[1])))
PY
)
if [ "$rc" = 0 ]; then
  status success "slice: $counts"
else
  status failure "slice: $counts; $(grep -c '^REFUSE' "$out/verdict.txt") rule(s) unmet (Deck: $out/verdict.txt)"
fi
cat "$out/verdict.txt"
