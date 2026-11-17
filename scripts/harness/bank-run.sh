#!/bin/sh
# Runs the regression bank on a scratch node built from the current checkout, then counts its calls by rung.
#   sh scripts/harness/bank-run.sh <scratch folder> <census file> [sites csv]
#
# Each answer's own lines are kept in <scratch folder>/samples, outside the repository: read them before trusting a
# verdict, which is the rule's and no person's. KEEP_NODE=1 leaves the scratch node running afterwards, to ask it more.
#
# Keep <scratch folder> short (the browser's socket path holds it). CHROME names the browser when none is on the path.
# It goes to live sites, read only, at the bank's own pace: run it alone, and not while anything else is building.
set -eu
dir=${1:?scratch folder}
census=${2:?census file}
root=$(cd "$(dirname "$0")/../.." && pwd)
bank=$root/test-banks/popular-sites
sites=${3:-$(python3 -I -c "import json;print(','.join(json.load(open('$bank/regression.json'))['sites']))")}
# What warm calls are timed against (run_bank.py --browser-program): the built agent-browser by default, as CI runs it.
# WARM=none skips the timing, on a machine too short of memory to hold a second browser beside the node's.
warm=${WARM:-auto}

cd "$root"
cargo build --locked --manifest-path unbrowse-node/Cargo.toml --bin unbrowse-node 2>&1 | tail -1
# Always, not only when it is missing: a browser program built from an earlier checkout is not this checkout's.
cargo build --locked --manifest-path unbrowse-browser/cli/Cargo.toml 2>&1 | tail -1

# A node already on the scratch port would answer this run's calls from another build and another home.
if curl -s -o /dev/null -m 3 "http://127.0.0.1:${PORT:-17810}/v1/health"; then
  echo "a node already answers on port ${PORT:-17810}: stop it first" >&2
  exit 1
fi
rm -rf "$dir"
sh "$bank/scratch-node.sh" "$dir"
# node.pid names the shell that started the node, so the node is its child: both are stopped, or the node stays on
# the port and answers the next run's calls.
stop_node() {
  pid=$(cat "$dir/node.pid" 2>/dev/null) || return 0
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
}
[ "${KEEP_NODE:-0}" = 1 ] || trap stop_node EXIT

cd "$bank"
echo "$sites" | tr ',' '\n' | paste -d, - - - - - | sed 's/,*$//' | while read -r batch; do
  echo "== batch $batch"
  python3 run_bank.py run --node http://127.0.0.1:17810 --token-file "$dir/token" --cases search-cases.json \
    --sites "$batch" --seed "$(date -u +%F)" --out "$dir/reads.json" --node-home "$dir/home/node" \
    --node-log "$dir/node.log" --guard-log "$dir/guard.log" --samples "$dir/samples" --browser-program "$warm" 2>&1 | tail -4 || echo "batch failed: $batch"
done
python3 run_bank.py compare --out "$dir/reads.json" --summary "$dir/reads.md" || true
python3 run_bank.py census --node-home "$dir/home/node" --out "$dir/reads.json" --commit "$(git -C "$root" rev-parse --short HEAD)" --census "$census"
echo BANK_RUN_DONE
