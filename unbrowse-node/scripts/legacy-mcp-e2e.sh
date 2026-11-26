#!/bin/sh
# End to end, on a real macOS or Linux machine (CI): the MCP entries an older Unbrowse (12.x) wrote keep working
# against 13 by running the node on this machine (B3), and the npm `unbrowse` command forwards `mcp --agent first`
# to the node at its default address (B9). Both old shapes, `npx -y unbrowse mcp` and `node …/dist/cli.js mcp
# --account x` (with its other flags), answer `initialize` and list the node's tools; the old hosted sign-in in
# ~/.config/unbrowse is never read or changed (sha256 before = after), so a 12.5.0 downgrade still finds it. Before
# the owner lets an agent in, an old entry still starts as an MCP server and says the one step to take.
# The node runs at the default address, 127.0.0.1:7788, with UNBROWSE_NODE unset, as an old entry starts it; on a
# machine where something else holds that port, it runs on another one with UNBROWSE_NODE set, and says so.
# usage: scripts/legacy-mcp-e2e.sh <path to unbrowse-node> <path to unb> <path to the npm package's dist/cli.js>
set -eu
abs() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }
node=$(abs "$1")
unb=$(abs "$2")
cli=$(abs "$3")
work=$(mktemp -d "${TMPDIR:-/tmp}/unb-legacy-mcp-e2e.XXXXXX")
pid=""
fail() {
  echo "FAIL: $*" >&2
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  [ -f "$work/node.log" ] && tail -20 "$work/node.log" >&2
  exit 1
}
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$work"' EXIT
unset UNBROWSE_HOME UNBROWSE_AGENT_TOKEN XDG_CONFIG_HOME UNBROWSE_CONFIG_DIR UNBROWSE_NODE
export HOME="$work/home"
mkdir -p "$HOME"
export UNBROWSE_ROOT_KEY_FILE=1
# The npm command finds unb and the node beside each other here, as the platform package keeps them.
export UNBROWSE_BIN="$(dirname "$unb")"
[ -x "$UNBROWSE_BIN/unbrowse-node" ] || fail "unbrowse-node isn't beside unb in $UNBROWSE_BIN"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
probe="/v1/node/proof?challenge=$(printf '0%.0s' $(seq 64))"
if curl -sS -o /dev/null "http://127.0.0.1:7788$probe" 2>/dev/null; then
  port=$((20000 + $$ % 20000))
  export UNBROWSE_NODE="http://127.0.0.1:$port"
  echo "note: something already answers at 127.0.0.1:7788, so the node runs at $UNBROWSE_NODE and the default address isn't exercised here"
else
  port=7788
fi
export UNBROWSE_PORT="$port"
base="http://127.0.0.1:$port"

# The 12.x CLI's hosted sign-in, as it left it: the default account and a named one.
old="$HOME/.config/unbrowse"
mkdir -p "$old/accounts/x"
key=ub_live_0123456789abcdef0123456789abcdef77e2
printf '{"apiKey":"%s","baseUrl":"https://unbrowse.ai","refreshToken":"rt_0123456789abcdef"}\n' "$key" > "$old/cli.json"
printf '{"apiKey":"%s","baseUrl":"https://unbrowse.ai"}\n' "$key" > "$old/accounts/x/cli.json"
before_default=$(sha "$old/cli.json")
before_named=$(sha "$old/accounts/x/cli.json")

# One MCP session over stdio: initialize, initialized, tools/list. Prints the tool names, one a line, or fails.
session() {
  name=$1
  shift
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"legacy-e2e","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    | "$@" > "$work/$name.out" 2> "$work/$name.err" || fail "$name exited $?: $(cat "$work/$name.err")"
  python3 -I - "$work/$name.out" <<'PY' || fail "$name: $(cat "$work/$name.out" "$work/$name.err")"
import json, sys
answers = {m.get("id"): m for m in map(json.loads, filter(str.strip, open(sys.argv[1])))}
assert "result" in answers.get(1, {}), ("initialize", answers.get(1))
tools = answers.get(2, {}).get("result", {}).get("tools")
assert tools, ("tools/list", answers.get(2))
print("\n".join(t["name"] for t in tools))
PY
}

# A fresh node.
"$node" > "$work/node.log" 2>&1 &
pid=$!
i=0
until curl -fsS "$base$probe" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 240 ] || fail "the node didn't answer at $base"
  kill -0 "$pid" 2>/dev/null || fail "the node exited"
  sleep 0.5
done

# Before the owner has let an agent in: an old entry still starts, as an MCP server that names the step.
[ ! -e "$HOME/.unbrowse/bridges/first" ] || fail "a grant exists before anyone asked for one"
session before node "$cli" mcp > "$work/before.tools"
[ "$(cat "$work/before.tools")" = "unbrowse_connect" ] || fail "with no grant, an old entry listed: $(cat "$work/before.tools")"
# It tells its person where to connect it, in the app, and never hands them a command (#822, `said_to_agents`).
grep -q "click Connect" "$work/before.out" || fail "with no grant, the old entry isn't told where to connect it: $(cat "$work/before.out")"
! grep -q "unbrowse connect" "$work/before.out" || fail "with no grant, the old entry hands its person a command"

# The owner lets the node's first agent in (on a desktop the window asks; here the root key file stands in).
i=0
until "$node" agent token >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || fail "the node made no first agent key"
  sleep 0.5
done

# `npx -y unbrowse mcp`: the npm command with no flags.
session npx node "$cli" mcp > "$work/npx.tools"
# `node …/dist/cli.js mcp --account x`, with the other flags 12.x configs carry.
session account node "$cli" mcp --account x --base-url https://unbrowse.ai > "$work/account.tools"
# The same flags straight to unb (a config that points at the platform package's unb).
session unb "$unb" mcp --account x > "$work/unb.tools"
# B9: what `unbrowse connect` writes, through the npm command.
session agent node "$cli" mcp --agent first > "$work/agent.tools"
for s in npx account unb agent; do
  grep -qx "unbrowse_do" "$work/$s.tools" || fail "$s didn't list the node's tools: $(tr '\n' ' ' < "$work/$s.tools")"
  cmp -s "$work/$s.tools" "$work/agent.tools" || fail "$s listed other tools than the node's: $(tr '\n' ' ' < "$work/$s.tools")"
done

# The hosted sign-in: never read into anything said, never changed.
if grep -q "ub_live\|rt_0123" "$work"/*.out "$work"/*.err "$work/node.log"; then fail "the old hosted key reached the output"; fi
[ "$(sha "$old/cli.json")" = "$before_default" ] || fail "~/.config/unbrowse/cli.json changed"
[ "$(sha "$old/accounts/x/cli.json")" = "$before_named" ] || fail "~/.config/unbrowse/accounts/x/cli.json changed"

kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null || true
pid=""
echo "old entries list $(wc -l < "$work/agent.tools" | tr -d ' ') node tools at $base; sign-in sha256 $before_default unchanged"
echo "LEGACY_MCP_E2E_PASSED"
