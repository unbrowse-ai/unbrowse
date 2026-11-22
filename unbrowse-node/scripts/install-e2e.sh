#!/bin/sh
# End to end, the install with no terminal (docs/design/mac-installer.md): over a fresh home with Claude Code, Claude
# Desktop, Cursor and Codex set up the way their installers leave them, and only a GUI app's PATH (no claude, node or
# npm), the node is started the way the window starts it, and the window's Connect is sent as the window sends it
# (`POST /owner/agent_connect`). Then:
#   - every client's config holds `<unb> mcp --agent first`, every other server and setting it had is still there, and
#     the entry, started as the client starts it, answers `initialize` and lists the node's tools;
#   - no file, answer or log line holds the agent's token;
#   - with the node stopped, a client starting the entry brings the node back (`unb mcp` starts it);
#   - `agent_connect_undo` puts every file back as it was.
# With --dmg on macOS it first mounts the disk image, checks it holds the app beside a link to /Applications, copies
# the app out as the owner's drag does, checks its signature, and runs the programs inside it.
#
#   usage: scripts/install-e2e.sh <path to unbrowse-node> <path to unb>
#          scripts/install-e2e.sh --dmg <Unbrowse-<version>-macos-<arch>.dmg>
#
# Prints INSTALL_E2E_OK, and MAC_INSTALL_E2E_OK when it ran from a disk image.
set -eu
abs() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }
work=$(mktemp -d "${TMPDIR:-/tmp}/unb-install-e2e.XXXXXX")
pid=""
mnt=""
fail() {
  echo "FAIL: $*" >&2
  [ -f "$work/node.log" ] && tail -20 "$work/node.log" >&2
  [ -f "$HOME/.unbrowse/node.log" ] && tail -20 "$HOME/.unbrowse/node.log" >&2
  exit 1
}
stop_nodes() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  # A node `unb mcp` started is detached from this script: found by its program's path, which is this run's alone.
  pkill -f "^$node" 2>/dev/null || true
  pid=""
}
cleanup() {
  stop_nodes
  [ -n "$mnt" ] && hdiutil detach -quiet "$mnt" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

dmg=""
if [ "${1:-}" = --dmg ]; then
  [ "$(uname -s)" = Darwin ] || fail "--dmg runs on macOS"
  dmg=$(abs "$2")
  mnt="$work/mnt"
  mkdir -p "$mnt" "$work/Applications"
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null || fail "hdiutil couldn't mount $dmg"
  [ -d "$mnt/Unbrowse.app" ] || fail "the disk image holds no Unbrowse.app"
  [ -L "$mnt/Applications" ] || fail "the disk image has no Applications link to drag onto"
  ditto "$mnt/Unbrowse.app" "$work/Applications/Unbrowse.app"
  hdiutil detach -quiet "$mnt" || true
  mnt=""
  app="$work/Applications/Unbrowse.app"
  codesign --verify --strict "$app" || fail "the copied app's signature doesn't verify"
  for p in unbrowse-window unbrowse-node unb; do [ -x "$app/Contents/MacOS/$p" ] || fail "the app has no $p"; done
  node="$app/Contents/MacOS/unbrowse-node"
  unb="$app/Contents/MacOS/unb"
else
  # Side by side in a folder of this run's own, as the app keeps them: `unb` finds the node beside itself, and a node
  # it starts is this run's alone.
  mkdir -p "$work/bin"
  cp "$1" "$work/bin/unbrowse-node"
  cp "$2" "$work/bin/unb"
  node="$work/bin/unbrowse-node"
  unb="$work/bin/unb"
fi

unset UNBROWSE_HOME UNBROWSE_AGENT_TOKEN XDG_CONFIG_HOME CLAUDE_CONFIG_DIR CODEX_HOME UNBROWSE_CONFIG_DIR
export HOME="$work/home"
mkdir -p "$HOME"
port=$((20000 + $$ % 20000))
export UNBROWSE_PORT="$port" UNBROWSE_NODE="http://127.0.0.1:$port" UNBROWSE_ROOT_KEY_FILE=1
# What an app opened from the Dock or Finder has: launchd's PATH, so neither claude nor node nor npm.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export UNBROWSE_CLAUDE=none
command -v python3 >/dev/null || fail "python3 isn't in /usr/bin"

# The four clients, as their installers leave them, each with something of its own. A client counts as installed by
# its program, not its folder (connect.rs `Client::found`): Claude Code by its ~/.claude.json, the other three by a
# command where installers put them, which the node looks in although a GUI app's PATH doesn't reach it.
mkdir -p "$HOME/.local/bin"
for p in claude-desktop cursor codex; do printf '#!/bin/sh\n' > "$HOME/.local/bin/$p"; chmod +x "$HOME/.local/bin/$p"; done
mkdir -p "$HOME/.claude" "$HOME/.hermes/skills"
printf '{"numStartups": 2, "mcpServers": {"github": {"command": "gh-mcp"}}}\n' > "$HOME/.claude.json"
if [ "$(uname -s)" = Darwin ]; then desktop="$HOME/Library/Application Support/Claude"; else desktop="$HOME/.config/Claude"; fi
mkdir -p "$desktop"
mkdir -p "$HOME/.cursor"
printf '{"mcpServers": {"linear": {"url": "https://mcp.linear.app/sse"}}}\n' > "$HOME/.cursor/mcp.json"
mkdir -p "$HOME/.codex"
printf 'model = "o4"\n\n[profiles.fast]\nmodel = "mini"\n' > "$HOME/.codex/config.toml"
mkdir -p "$work/before"
cp "$HOME/.claude.json" "$work/before/claude.json"
cp "$HOME/.cursor/mcp.json" "$work/before/cursor.json"
cp "$HOME/.codex/config.toml" "$work/before/codex.toml"

proof() { curl -fsS "$UNBROWSE_NODE/v1/node/proof?challenge=$(printf '0%.0s' $(seq 64))" >/dev/null 2>&1; }

# The node, as the window starts it: from beside itself, with its output in a log.
"$node" > "$work/node.log" 2>&1 &
pid=$!
i=0
until proof && [ -s "$HOME/.unbrowse/owner.token" ]; do
  i=$((i + 1))
  [ "$i" -lt 240 ] || fail "the node didn't answer at $UNBROWSE_NODE"
  kill -0 "$pid" 2>/dev/null || fail "the node exited"
  sleep 0.5
done
# The window's call, signed as the window signs it (`unbrowse_core::signed`): the owner's token names itself by its key
# and signs each request, and is never sent. Python has no Keccak-256, so it is here, from the spec.
cat > "$work/owner.py" <<'PY'
import hashlib, hmac, json, os, sys, time, urllib.error, urllib.request
RC = [0x1, 0x8082, 0x800000000000808A, 0x8000000080008000, 0x808B, 0x80000001, 0x8000000080008081, 0x8000000000008009,
      0x8A, 0x88, 0x80008009, 0x8000000A, 0x8000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
      0x8000000000008002, 0x8000000000000080, 0x800A, 0x800000008000000A, 0x8000000080008081, 0x8000000000008080,
      0x80000001, 0x8000000080008008]
ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
M = (1 << 64) - 1
def rol(v, n):
    return ((v << n) | (v >> (64 - n))) & M if n else v
def keccak256(data):
    a = [[0] * 5 for _ in range(5)]
    rate = 136
    data = bytearray(data) + b"\x01" + b"\x00" * ((-len(data) - 1) % rate)
    data[-1] |= 0x80
    for off in range(0, len(data), rate):
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(data[off + 8 * i:off + 8 * i + 8], "little")
        for rc in RC:
            c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
            d = [c[(x - 1) % 5] ^ rol(c[(x + 1) % 5], 1) for x in range(5)]
            a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
            b = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    b[y][(2 * x + 3 * y) % 5] = rol(a[x][y], ROT[x][y])
            a = [[b[x][y] ^ (~b[(x + 1) % 5][y] & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
            a[0][0] ^= rc
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
home, base, cmd, body = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].encode()
token = open(home + "/.unbrowse/owner.token").read().strip()
authority = base.split("://", 1)[1].rstrip("/").lower()
target = "/owner/" + cmd
t, nonce = str(int(time.time())), os.urandom(16).hex()
parts = [b"unbrowse/request/v2", b"POST", authority.encode(), target.encode(), hashlib.sha256(body).hexdigest().encode(), t.encode(), nonce.encode()]
sig = hmac.new(token.encode(), b"\n".join(parts), hashlib.sha256).hexdigest()
req = urllib.request.Request(base + target, data=body, method="POST", headers={
    "content-type": "application/json", "x-unbrowse-key": keccak256(b"unbrowse/node-key\n" + token.encode()).hex(),
    "x-unbrowse-time": t, "x-unbrowse-nonce": nonce, "x-unbrowse-signature": sig})
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        sys.stdout.write(r.read().decode())
except urllib.error.HTTPError as e:
    sys.stdout.write(e.read().decode())
    sys.exit(1)
PY
owner() { python3 -I "$work/owner.py" "$HOME" "$UNBROWSE_NODE" "$1" "$2"; }
i=0
until owner agents_list '{}' > "$work/agents.json" 2>&1 && grep -q '"index"' "$work/agents.json"; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || fail "the node made no first agent key: $(head -c 400 "$work/agents.json")"
  sleep 0.5
done

owner agent_clients '{}' > "$work/clients1.json"
python3 -I - "$work/clients1.json" <<'PY' || fail "agent_clients: $(cat "$work/clients1.json")"
import json, sys
every = {x["id"]: x for x in json.load(open(sys.argv[1]))["clients"]}
four = ["claude_code", "claude_desktop", "codex", "cursor"]
c = {k: every[k] for k in four}
assert all(x["found"] and not x["connected"] for x in c.values()), c
# A client with only its settings folder isn't installed: a skills sync makes ~/.hermes/skills with no Hermes.
assert not every["hermes"]["found"], every["hermes"]
PY

# The owner's click on Connect.
owner agent_connect '{"clients": ["claude_code", "claude_desktop", "cursor", "codex"]}' > "$work/connect.json"
python3 -I - "$work/connect.json" <<'PY' || fail "agent_connect: $(cat "$work/connect.json")"
import json, sys
r = {x["id"]: x for x in json.load(open(sys.argv[1]))["results"]}
assert all(x["ok"] and x["error"] is None for x in r.values()) and len(r) == 4, r
assert sorted(k for k, x in r.items() if x["restart_needed"]) == ["claude_desktop", "cursor"], r
PY

# Each client's entry, read from its own config, and what else it kept.
python3 -I - "$HOME" "$desktop" "$unb" "$UNBROWSE_NODE" "$work/entries.json" <<'PY' || fail "a client's config is wrong"
import json, re, sys
home, desktop, unb, node, out = sys.argv[1:6]
want = {"command": unb, "args": ["mcp", "--agent", "first"], "env": {"UNBROWSE_NODE": node}}
cc = json.load(open(home + "/.claude.json"))
assert cc["numStartups"] == 2 and cc["mcpServers"]["github"] == {"command": "gh-mcp"}, cc
d = json.load(open(desktop + "/claude_desktop_config.json"))
cu = json.load(open(home + "/.cursor/mcp.json"))
assert cu["mcpServers"]["linear"] == {"url": "https://mcp.linear.app/sse"}, cu
toml = open(home + "/.codex/config.toml").read()
assert 'model = "o4"' in toml and "[profiles.fast]" in toml, toml
section = toml.split("[mcp_servers.unbrowse]", 1)[1]
codex = {
    "command": json.loads(re.search(r'^command = (".*")$', section, re.M).group(1)),
    "args": json.loads(re.search(r"^args = (\[.*\])$", section, re.M).group(1)),
    "env": {"UNBROWSE_NODE": json.loads(re.search(r'^UNBROWSE_NODE = (".*")$', section, re.M).group(1))},
}
entries = {"claude_code": cc["mcpServers"]["unbrowse"], "claude_desktop": d["mcpServers"]["unbrowse"], "cursor": cu["mcpServers"]["unbrowse"], "codex": codex}
for k, e in entries.items():
    assert {x: e.get(x) for x in want} == want, (k, e)
json.dump(entries, open(out, "w"))
PY

# A client starting its entry: `initialize`, then `tools/list`, answered with the node's tools.
cat > "$work/mcp_check.py" <<'PY'
import json, os, signal, subprocess, sys
entry = json.loads(sys.argv[1])
signal.alarm(int(sys.argv[2]) if len(sys.argv) > 2 else 60)
env = dict(os.environ, **entry.get("env", {}))
p = subprocess.Popen([entry["command"]] + entry["args"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
def ask(i, method, params=None):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
    p.stdin.flush()
    for line in p.stdout:
        m = json.loads(line)
        if m.get("id") == i:
            assert "result" in m, m
            return m["result"]
    raise SystemExit("it stopped before answering " + method)
ask(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "install-e2e", "version": "1"}})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
tools = [t["name"] for t in ask(2, "tools/list")["tools"]]
p.kill()
assert len(tools) > 1 and "unbrowse_connect" not in tools, tools
print(len(tools))
PY
for c in claude_code claude_desktop cursor codex; do
  e=$(python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[sys.argv[2]]))' "$work/entries.json" "$c")
  n=$(python3 -I "$work/mcp_check.py" "$e" 90) || fail "$c's entry didn't answer with the node's tools"
  echo "ok: $c answers with $n tools"
done

owner agent_clients '{}' > "$work/clients2.json"
python3 -I -c 'import json,sys; c=[x for x in json.load(open(sys.argv[1]))["clients"] if x["id"] in ("claude_code","claude_desktop","cursor","codex")]; assert len(c) == 4 and all(x["connected"] for x in c), c' "$work/clients2.json" || fail "agent_clients doesn't say every client is connected"

# No token anywhere connect wrote, answered or logged.
for t in "$HOME"/.unbrowse/bridges/agent-*.token; do
  token=$(cat "$t")
  if grep -rqF "$token" "$HOME/.claude.json" "$desktop" "$HOME/.cursor" "$HOME/.codex" "$HOME/.unbrowse/connect" "$work"/*.json "$work/node.log"; then
    fail "the agent's token is in a config, a record, an answer or the node's log"
  fi
done

# After a reboot: no node runs, and the client's entry brings it back.
stop_nodes
i=0
while proof; do
  i=$((i + 1))
  [ "$i" -lt 40 ] || fail "the node didn't stop"
  sleep 0.5
done
e=$(python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["claude_desktop"]))' "$work/entries.json")
n=$(python3 -I "$work/mcp_check.py" "$e" 120) || fail "with the node stopped, the entry didn't start it and answer"
proof || fail "the entry answered but no node runs"
echo "ok: a stopped node is started by the client's entry ($n tools)"

# Undo: every file as it was.
owner agent_connect_undo '{}' > "$work/undo.json"
python3 -I - "$work/undo.json" "$HOME" "$desktop" "$work/before" <<'PY' || fail "undo didn't put every file back: $(cat "$work/undo.json")"
import json, os, sys
undo, home, desktop, before = sys.argv[1:5]
assert len(json.load(open(undo))["restored"]) == 4
assert not os.path.exists(desktop + "/claude_desktop_config.json"), "the file connect made is still there"
assert open(home + "/.cursor/mcp.json").read() == open(before + "/cursor.json").read()
assert open(home + "/.codex/config.toml").read() == open(before + "/codex.toml").read()
assert json.load(open(home + "/.claude.json")) == json.load(open(before + "/claude.json"))
PY

stop_nodes
echo "INSTALL_E2E_OK"
[ -n "$dmg" ] && echo "MAC_INSTALL_E2E_OK"
exit 0
