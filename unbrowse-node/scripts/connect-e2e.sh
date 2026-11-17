#!/bin/sh
# End to end, on a real macOS or Linux machine (CI): a fresh node started over a home an older Unbrowse used leaves
# its `~/.unbrowse/config.json` (the v1 key) byte-identical (B6), and `unb connect` moves a hosted entry to the node:
# without a terminal or --yes it only shows the plan; --yes checks the new entry against the running node's MCP
# (initialize and tools/list), replaces the old entry, and puts no token on a command line; --undo --purge puts the
# old entry back exactly and deletes the backup. Claude Code is a stand-in that keeps ~/.claude.json the way its CLI
# does (UNBROWSE_CLAUDE), so a machine without Claude can run this; set UNBROWSE_CLAUDE to a real `claude` to use it.
# usage: scripts/connect-e2e.sh <path to unbrowse-node> <path to unb>
set -eu
abs() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }
node=$(abs "$1")
unb=$(abs "$2")
work=$(mktemp -d "${TMPDIR:-/tmp}/unb-connect-e2e.XXXXXX")
pid=""
fail() {
  echo "FAIL: $*" >&2
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  [ -f "$work/node.log" ] && tail -20 "$work/node.log" >&2
  exit 1
}
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$work"' EXIT
unset UNBROWSE_HOME UNBROWSE_AGENT_TOKEN XDG_CONFIG_HOME CLAUDE_CONFIG_DIR CODEX_HOME UNBROWSE_CONFIG_DIR
export HOME="$work/home"
mkdir -p "$HOME/.unbrowse"
port=$((20000 + $$ % 20000))
export UNBROWSE_PORT="$port" UNBROWSE_NODE="http://127.0.0.1:$port" UNBROWSE_ROOT_KEY_FILE=1
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
key=ub_live_0123456789abcdef0123456789abcdefa1f3

# The v1 CLI's key, as an older install left it.
printf '{"api_key": "ubr_%s"}\n' abababababababababababababababababababababababababababababababababababab > "$HOME/.unbrowse/config.json"
v1=$(sha "$HOME/.unbrowse/config.json")

# The hosted service's entry, with its key, beside an entry that isn't ours.
cat > "$HOME/.claude.json" <<EOF
{
  "mcpServers": {
    "unbrowse": { "type": "http", "url": "https://unbrowse.ai/mcp", "headers": { "Authorization": "Bearer $key" } },
    "unbrowse-acme": { "type": "http", "url": "https://mcp.acme.example/u" }
  }
}
EOF
cp "$HOME/.claude.json" "$work/claude.before.json"

if [ -z "${UNBROWSE_CLAUDE:-}" ]; then
  # Claude Code's CLI, for what connect asks of it: add (stdio, --env), add-json, remove, plugin. Each command line is
  # kept in claude.log.
  cat > "$work/claude" <<'PY'
#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
with open(os.environ["FAKE_CLAUDE_LOG"], "a") as log:
    log.write(" ".join(a) + "\n")
path = os.path.join(os.environ["HOME"], ".claude.json")
cfg = json.load(open(path)) if os.path.exists(path) else {}
def servers(scope):
    if scope == "local":
        return cfg.setdefault("projects", {}).setdefault(os.getcwd(), {}).setdefault("mcpServers", {})
    return cfg.setdefault("mcpServers", {})
if a[:2] == ["mcp", "add"]:
    scope, name, rest = a[3], a[4], a[5:]
    dash = rest.index("--")
    env = dict(p.split("=", 1) for p in rest[1:dash:2])
    if name in servers(scope):
        sys.exit("MCP server %s already exists" % name)
    servers(scope)[name] = {"type": "stdio", "command": rest[dash + 1], "args": rest[dash + 2:], "env": env}
elif a[:2] == ["mcp", "add-json"]:
    servers(a[3])[a[4]] = json.loads(a[5])
elif a[:2] == ["mcp", "remove"]:
    if servers(a[3]).pop(a[4], None) is None:
        sys.exit("No MCP server named %s" % a[4])
elif a[:1] == ["plugin"]:
    pass
else:
    sys.exit("unknown: %s" % a)
json.dump(cfg, open(path, "w"), indent=2)
PY
  chmod +x "$work/claude"
  export UNBROWSE_CLAUDE="$work/claude"
fi
export FAKE_CLAUDE_LOG="$work/claude.log"
: > "$FAKE_CLAUDE_LOG"

# A fresh node over that home.
"$node" > "$work/node.log" 2>&1 &
pid=$!
i=0
until curl -fsS "$UNBROWSE_NODE/v1/node/proof?challenge=$(printf '0%.0s' $(seq 64))" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 240 ] || fail "the node didn't answer at $UNBROWSE_NODE"
  kill -0 "$pid" 2>/dev/null || fail "the node exited"
  sleep 0.5
done
i=0
until "$node" agent token >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || fail "the node made no first agent key"
  sleep 0.5
done
[ "$(sha "$HOME/.unbrowse/config.json")" = "$v1" ] || fail "the fresh node changed ~/.unbrowse/config.json"

# Without a terminal and without --yes: the plan is shown and nothing changes.
"$unb" connect < /dev/null > "$work/out1" 2>&1 || fail "connect without --yes: $(cat "$work/out1")"
grep -q "Nothing was changed" "$work/out1" || fail "connect without a terminal went ahead: $(cat "$work/out1")"
grep -q "key …a1f3" "$work/out1" || fail "the plan doesn't name the old key by its last 4: $(cat "$work/out1")"
[ ! -s "$FAKE_CLAUDE_LOG" ] || fail "connect without --yes ran claude: $(cat "$FAKE_CLAUDE_LOG")"
cmp -s "$HOME/.claude.json" "$work/claude.before.json" || fail "connect without --yes changed ~/.claude.json"

# --dry-run: the same.
"$unb" connect --dry-run --yes < /dev/null > "$work/out2" 2>&1 || fail "dry run: $(cat "$work/out2")"
grep -q "Dry run: nothing was changed" "$work/out2" || fail "dry run went ahead"
[ ! -s "$FAKE_CLAUDE_LOG" ] || fail "a dry run ran claude"

# --yes: checked against the node, then replaced.
"$unb" connect --yes < /dev/null > "$work/out3" 2>&1 || fail "connect --yes: $(cat "$work/out3")"
grep -Eq "✓ Claude Code: unbrowse → your node \(checked: [0-9]+ tools\)" "$work/out3" || fail "no checked entry: $(cat "$work/out3")"
if grep -q "ub_live\|Bearer" "$work/out3" "$FAKE_CLAUDE_LOG"; then fail "a token was shown or on a command line"; fi
token=$("$node" agent token)
if grep -qF "$token" "$work/out3" "$FAKE_CLAUDE_LOG" "$HOME/.claude.json"; then fail "the agent's token is in the output, a command line or the config"; fi
python3 -I - "$HOME/.claude.json" "$unb" "$UNBROWSE_NODE" <<'PY' || fail "the new entry isn't the node's bridge"
import json, sys
cfg = json.load(open(sys.argv[1]))
s = cfg["mcpServers"]
assert s["unbrowse"]["args"] == ["mcp", "--agent", "first"] and s["unbrowse"]["command"] == sys.argv[2], s["unbrowse"]
assert s["unbrowse"]["env"] == {"UNBROWSE_NODE": sys.argv[3]}, s["unbrowse"]
assert "unbrowse-next" not in s and s["unbrowse-acme"] == {"type": "http", "url": "https://mcp.acme.example/u"}, s
PY
ls -d "$HOME"/.unbrowse/migration/*/ >/dev/null 2>&1 || fail "no backup"

# --undo --purge: the old entry back exactly, the backup gone.
"$unb" connect --undo --purge < /dev/null > "$work/out4" 2>&1 || fail "undo: $(cat "$work/out4")"
python3 -I - "$HOME/.claude.json" "$work/claude.before.json" <<'PY' || fail "undo didn't put the old entries back exactly"
import json, sys
now, before = (json.load(open(p))["mcpServers"] for p in sys.argv[1:3])
assert now == before, (now, before)
PY
if ls -d "$HOME"/.unbrowse/migration/*/ >/dev/null 2>&1; then fail "--purge left the backup"; fi

[ "$(sha "$HOME/.unbrowse/config.json")" = "$v1" ] || fail "~/.unbrowse/config.json changed"
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null || true
pid=""
if [ -n "${UNB_E2E_SHOW:-}" ]; then cat "$work/out1" "$work/out3" "$work/out4" "$FAKE_CLAUDE_LOG"; fi
echo "CONNECT_E2E_PASSED"
