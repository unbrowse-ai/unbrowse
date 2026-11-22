#!/bin/sh
# A node of its own for QA, as an agent's machine would have it (UNB-235: the agent QA and the MCP check both start one).
#
#   sh .github/qa/start-node.sh <unbrowse-node> <unb> <home>
#
# An agent key, a login in the vault for the sign-in check, telemetry and reports on but sent to an address nothing
# answers (the node is off the network: no QA run ever files a real issue), and a browser (the node downloads Chrome for
# Testing when the runner has none). Writes, under <home>: token (the agent key, 0600), mcp.json (`unb mcp` signing
# with it, as a shipped setup gives it), chromium (the browser's path), node.log and node.pid. On GitHub it masks the
# token and sets UNBROWSE_HOME, UNB, UNBROWSE_NODE, VAULT_READY and QA_CHROME for later steps. Holds no secret of the
# workflow's.
#
# The node listens on PORT (default 17830), never the owner's 7788: on a runner that is someone's own Mac, their node
# already holds 7788 ("port 7788: Address already in use", run 44870008228 on lewis-macbook-pro). The port goes in the
# node's own settings.json (`api_port`), which the node, the agent setup it prints and the window all read.
# UNBROWSE_PORT is not used: it rewrites settings to the default (test-banks/popular-sites/scratch-node.sh).
set -eu
node=$1 unb=$2 home=$3
port=${PORT:-17830}
case "$port" in
  '' | *[!0-9]* | 0*) echo "::error::PORT must be a number with no leading zero, not $port"; exit 1 ;;
esac
[ "$port" != 7788 ] || { echo "::error::7788 is the owner's port"; exit 1; }
mkdir -p "$home"
export UNBROWSE_HOME="$home"
export UNBROWSE_NODE="http://127.0.0.1:$port"
env_out=${GITHUB_ENV:-/dev/null}
if curl -sf -m 3 -o /dev/null "$UNBROWSE_NODE/v1/health"; then
  echo "::error::a node already answers on port $port"
  exit 1
fi

# A setting written at its current value makes the node write its whole settings file, at the format's own version;
# then only the port changes. `agent bearer off` is already the default and asks no one.
"$node" agent bearer off > /dev/null
jq --argjson port "$port" '.api_port = $port' "$home/settings.json" > "$home/settings.json.new"
mv "$home/settings.json.new" "$home/settings.json"
[ "$(jq -r .api_port "$home/settings.json")" = "$port" ] || { echo "::error::the node's settings don't hold port $port"; exit 1; }

if printf 'SuperSecretPassword!\n' | "$node" vault add the-internet.herokuapp.com tomsmith --stored; then
  vault=yes
else
  vault=no
fi
# The setup names the key by its number, never its token: read the token by that number.
index=$("$node" agent new qa 2>/dev/null | grep -o -- '--agent [0-9]*' | head -n 1 | cut -d' ' -f2)
token=$([ -n "$index" ] && "$node" agent token "$index" || true)
[ -n "$token" ] || { echo "::error::couldn't make an agent key"; exit 1; }
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$token"
umask 077
printf '%s' "$token" > "$home/token"

UNBROWSE_TELEMETRY=1 UNBROWSE_TELEMETRY_URL=http://127.0.0.1:9/v1/events \
UNBROWSE_REPORTS=1 UNBROWSE_REPORTS_URL=http://127.0.0.1:9/v1/reports UNBROWSE_DEVNET_PORT=$((port + 1)) \
  nohup "$node" > "$home/node.log" 2>&1 &
echo $! > "$home/node.pid"

# `unb` signs each request with the token, as every client does: the node takes no bearer token.
for _ in $(seq 60); do
  UNBROWSE_AGENT_TOKEN="$token" "$unb" whoami > /dev/null 2>&1 && break
  sleep 2
done
UNBROWSE_AGENT_TOKEN="$token" "$unb" whoami > /dev/null || { cat "$home/node.log"; exit 1; }

using=
for _ in $(seq 120); do
  using=$("$node" browser status --json | jq -r '.chromium // empty')
  [ -n "$using" ] && break
  sleep 5
done
[ -n "$using" ] || { echo "::error::the node has no browser"; cat "$home/node.log"; exit 1; }
echo "Browsing in $using"
printf '%s' "$using" > "$home/chromium"

jq -n --arg unb "$unb" --arg token "$token" --arg node "$UNBROWSE_NODE" \
  '{mcpServers: {unbrowse: {command: $unb, args: ["mcp"], env: {UNBROWSE_NODE: $node, UNBROWSE_AGENT_TOKEN: $token}}}}' \
  > "$home/mcp.json"

{
  echo "UNBROWSE_HOME=$home"
  echo "UNB=$unb"
  echo "UNBROWSE_NODE=$UNBROWSE_NODE"
  echo "VAULT_READY=$vault"
  echo "QA_CHROME=$using"
} >> "$env_out"
