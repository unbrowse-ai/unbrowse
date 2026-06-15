#!/usr/bin/env bash
# Agent CLI marketplace gate: pack/install the shipped CLI, smoke the packaged
# Kuri/Chrome launch under a synthetic HOME, then let an LLM agent drive only
# the installed `unbrowse` binary through single-command natural-language tasks.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${UNBROWSE_AGENT_CLI_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/unbrowse-agent-cli-gate.XXXXXX")}"
PACK_DIR="$WORK/pack"
PREFIX="$WORK/prefix"
HOME_DIR="$WORK/home"
OUT_DIR="${UNBROWSE_AGENT_CLI_OUT_DIR:-$HERE/results-agent-cli-$TS}"
mkdir -p "$PACK_DIR" "$PREFIX" "$HOME_DIR" "$OUT_DIR"

echo "[gate] work=$WORK"
echo "[gate] out=$OUT_DIR"

export npm_config_cache="$WORK/npm-cache"
export UNBROWSE_NO_AUTO_UPDATE=1
export UNBROWSE_DISABLE_AUTO_UPDATE=1
export UNBROWSE_NON_INTERACTIVE=1
export UNBROWSE_TOS_ACCEPTED=1
export UNBROWSE_SKIP_WALLET_SETUP=1
export UNBROWSE_REBUILD_KURI="${UNBROWSE_REBUILD_KURI:-1}"
export UNBROWSE_ALLOW_KURI_PLACEHOLDER="${UNBROWSE_ALLOW_KURI_PLACEHOLDER:-1}"

echo "[gate] npm pack workspace package (source -> tarball)"
npm pack --workspace packages/skill --pack-destination "$PACK_DIR" >"$OUT_DIR/npm-pack.log" 2>&1
TARBALL="$(ls -1t "$PACK_DIR"/unbrowse-*.tgz | head -1)"
echo "[gate] tarball=$TARBALL"

echo "[gate] install tarball into temp prefix"
npm install -g "$TARBALL" --prefix "$PREFIX" >"$OUT_DIR/npm-install.log" 2>&1
BIN="$PREFIX/bin/unbrowse"
if [ ! -x "$BIN" ]; then
  echo "[gate] FAIL: installed binary missing: $BIN" >&2
  exit 1
fi
"$BIN" --version >"$OUT_DIR/version.txt" 2>&1 || true

host_kuri_dir() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo "darwin-arm64" ;;
    Darwin-x86_64) echo "darwin-x64" ;;
    Linux-x86_64) echo "linux-x64" ;;
    Linux-aarch64|Linux-arm64) echo "linux-arm64" ;;
    MINGW*|MSYS*|CYGWIN*) echo "win-x64" ;;
    *) echo "" ;;
  esac
}

free_port() {
  python3 - <<'PY'
import socket
s=socket.socket()
s.bind(("127.0.0.1",0))
print(s.getsockname()[1])
s.close()
PY
}

smoke_packaged_kuri_keychain_flags() {
  local dir name kuri k_home log port kp psout
  dir="$(host_kuri_dir)"
  if [ -z "$dir" ]; then
    echo "[kuri-smoke] SKIP: unsupported host $(uname -s)-$(uname -m)" | tee "$OUT_DIR/kuri-smoke.txt"
    return 0
  fi
  name="kuri"
  [ "$dir" = "win-x64" ] && name="kuri.exe"
  kuri="$PREFIX/lib/node_modules/unbrowse/vendor/kuri/$dir/$name"
  if [ ! -x "$kuri" ]; then
    echo "[kuri-smoke] FAIL: packaged kuri missing or not executable: $kuri" | tee "$OUT_DIR/kuri-smoke.txt" >&2
    return 1
  fi

  k_home="$WORK/kuri-home"
  log="$OUT_DIR/kuri.log"
  rm -rf "$k_home"
  mkdir -p "$k_home/.config"
  port="$(free_port)"
  echo "[kuri-smoke] launch $kuri PORT=$port HOME=$k_home" | tee "$OUT_DIR/kuri-smoke.txt"
  HOME="$k_home" XDG_CONFIG_HOME="$k_home/.config" PORT="$port" HOST=127.0.0.1 "$kuri" >"$log" 2>&1 &
  kp=$!
  trap 'kill "$kp" >/dev/null 2>&1 || true; pkill -f "$WORK/kuri-home" >/dev/null 2>&1 || true' RETURN

  for _ in $(seq 1 80); do
    if curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  sleep 0.5
  psout="$(ps -axo pid,ppid,command | grep -F "$k_home" | grep -v grep || true)"
  printf '%s\n' "$psout" >"$OUT_DIR/kuri-chrome-ps.txt"
  kill "$kp" >/dev/null 2>&1 || true
  pkill -f "$WORK/kuri-home" >/dev/null 2>&1 || true
  trap - RETURN

  if ! grep -q -- "--password-store=basic" "$OUT_DIR/kuri-chrome-ps.txt"; then
    echo "[kuri-smoke] FAIL: Chrome command lacks --password-store=basic" >&2
    cat "$OUT_DIR/kuri-chrome-ps.txt" >&2
    return 1
  fi
  if [ "$(uname -s)" = "Darwin" ] && ! grep -q -- "--use-mock-keychain" "$OUT_DIR/kuri-chrome-ps.txt"; then
    echo "[kuri-smoke] FAIL: Chrome command lacks --use-mock-keychain on macOS" >&2
    cat "$OUT_DIR/kuri-chrome-ps.txt" >&2
    return 1
  fi
  if grep -qi "keychain not found\\|A keychain cannot be found" "$log"; then
    echo "[kuri-smoke] FAIL: keychain prompt text appeared in Kuri log" >&2
    return 1
  fi
  echo "[kuri-smoke] PASS: packaged Chrome launch has keychain-safe flags" | tee -a "$OUT_DIR/kuri-smoke.txt"
}

smoke_packaged_kuri_keychain_flags

KEY_FILE="$HOME/.config/unbrowse-bench/openrouter.key"
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -z "${OPENROUTER_KEY:-}" ] && [ ! -s "$KEY_FILE" ]; then
  echo "[gate] BLOCKED: missing OpenRouter key ($KEY_FILE or OPENROUTER_API_KEY)" >&2
  exit 3
fi

echo "[gate] run LLM agent against installed CLI only"
export UNBROWSE_REPO_ROOT="$ROOT"
python3 "$HERE/agent_cli_harness.py" \
  --bin "$BIN" \
  --home "$HOME_DIR" \
  --out "$OUT_DIR/agent-results.jsonl" \
  --timeout "${UNBROWSE_AGENT_CLI_TIMEOUT:-210}" \
  | tee "$OUT_DIR/agent-harness.log"

python3 - "$OUT_DIR/agent-results.jsonl" "$OUT_DIR/summary.md" <<'PY'
import json, sys
inp, out = sys.argv[1], sys.argv[2]
rows = [json.loads(line) for line in open(inp) if line.strip()]
fail = [r for r in rows if not r.get("ok")]
with open(out, "w") as f:
    f.write("# Agent CLI Marketplace Gate\n\n")
    f.write("This gate packs and installs unbrowse, then lets an LLM agent call only the installed CLI binary.\n\n")
    f.write("| id | result | args | notes |\n|---|---|---|---|\n")
    for r in rows:
        notes = "; ".join(r.get("reasons") or []) or (r.get("final") or "")[:120].replace("\n", " ")
        f.write(f"| {r['id']} | {'PASS' if r.get('ok') else 'FAIL'} | `{json.dumps(r.get('args'))}` | {notes} |\n")
print(f"[gate] wrote {out}")
if fail:
    print("[gate] FAIL rows:")
    for r in fail:
        print(f"  {r['id']}: {'; '.join(r.get('reasons') or [])}")
    sys.exit(1)
PY

echo "[gate] PASS: packaged CLI agent harness + Kuri keychain smoke"
