#!/usr/bin/env bash
#
# mcp-chain-depth.sh — witness for the `unbrowse mcp` process-chain collapse.
#
# WHAT IT PROVES
#   One logical `unbrowse mcp` server used to be FOUR node processes:
#
#       node bin/unbrowse-wrapper.mjs mcp     (L1 — the PID the client holds)
#         └─ node bin/unbrowse.js mcp         (L2 — spawnSync, event loop blocked)
#              └─ node runtime/cli.js mcp     (L3)
#                   └─ node runtime/mcp.js    (L4 — the actual server)
#
#   No hop forwarded a signal, so a client SIGTERM to L1 killed L1 and orphaned
#   L2..L4 forever (~176MB RSS per orphaned tree). This script launches a REAL
#   MCP server from a patched package tree, drives a real `initialize` over
#   stdio, measures the actual depth of the resulting node chain, and fails
#   unless the depth is <= 2.
#
# SAFETY
#   - Never touches the user's live global install; it runs whatever tree
#     UNBROWSE_PKG points at (default: the staged patched copy in /tmp).
#   - Snapshots every pre-existing unbrowse PID BEFORE launching and refuses to
#     signal any of them. Other agents on this host have live MCP servers; this
#     script must never disturb them.
#   - Cleans up everything it started via an EXIT trap, including on failure.
#
# USAGE
#   bin/mcp-chain-depth.sh                      # uses UNBROWSE_PKG or /tmp/ub-patched
#   UNBROWSE_PKG=/path/to/pkg bin/mcp-chain-depth.sh
#
set -uo pipefail

PKG="${UNBROWSE_PKG:-/tmp/ub-patched}"
WRAPPER="$PKG/bin/unbrowse-wrapper.mjs"
MAX_DEPTH="${MAX_DEPTH:-2}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-90}"

if [[ ! -f "$WRAPPER" ]]; then
  echo "FAIL: no wrapper at $WRAPPER (set UNBROWSE_PKG to a package tree)" >&2
  exit 2
fi

# Refuse to grade the user's live global install — we must never kill its PIDs.
case "$(readlink -f "$PKG")" in
  /home/*/.local/lib/node_modules/unbrowse|/usr/*|/opt/*)
    echo "FAIL: refusing to run against the live install ($PKG). Stage a copy first." >&2
    exit 2
    ;;
esac

WORKDIR="$(mktemp -d)"
OUT="$WORKDIR/mcp.stdout"
ERR="$WORKDIR/mcp.stderr"
: >"$OUT"; : >"$ERR"

# Isolate all on-disk state so a witness run cannot pollute the real ~/.unbrowse.
export UNBROWSE_HOME="$WORKDIR/home"
export UNBROWSE_LOCAL_ONLY=1
mkdir -p "$UNBROWSE_HOME"

# ---------------------------------------------------------------------------
# PID safety: snapshot everything that already exists, so cleanup can only ever
# touch processes THIS script created.
# ---------------------------------------------------------------------------
declare -A PREEXISTING=()
while read -r pid; do
  [[ -n "$pid" ]] && PREEXISTING["$pid"]=1
done < <(ps -eo pid= 2>/dev/null | tr -d ' ')
PREEXISTING_COUNT=${#PREEXISTING[@]}

ROOT=""
cleanup() {
  local pid
  # Kill deepest-first so parents cannot respawn/reparent as we go.
  for pid in $(descendants_of "${ROOT:-0}" | tac) "${ROOT:-}"; do
    [[ -z "$pid" ]] && continue
    if [[ -n "${PREEXISTING[$pid]:-}" ]]; then
      echo "  [cleanup] SKIP pre-existing pid $pid (not ours)" >&2
      continue
    fi
    kill -TERM "$pid" 2>/dev/null
  done
  sleep 1
  for pid in $(descendants_of "${ROOT:-0}" | tac) "${ROOT:-}"; do
    [[ -z "$pid" ]] && continue
    [[ -n "${PREEXISTING[$pid]:-}" ]] && continue
    kill -KILL "$pid" 2>/dev/null
  done
  rm -rf "$WORKDIR"
}

# ---------------------------------------------------------------------------
# Process-tree helpers. PS_SNAP is refreshed explicitly so a walk is consistent.
# ---------------------------------------------------------------------------
PS_SNAP=""
refresh_ps() { PS_SNAP="$(ps -eo pid=,ppid= 2>/dev/null | awk '{print $1" "$2}')"; }

children_of() { # $1=pid
  awk -v p="$1" '$2==p {print $1}' <<<"$PS_SNAP"
}

descendants_of() { # $1=pid — all transitive children, breadth-first
  refresh_ps
  local queue=("$1") pid child
  while ((${#queue[@]})); do
    pid="${queue[0]}"; queue=("${queue[@]:1}")
    for child in $(children_of "$pid"); do
      echo "$child"
      queue+=("$child")
    done
  done
}

# Is this PID part of the unbrowse launch chain (as opposed to a worker the
# server legitimately spawns, e.g. the kuri broker or Chrome)? We count only
# node processes running code from the package tree under test.
belongs_to_chain() { # $1=pid
  local cmd
  cmd="$(tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null)" || return 1
  [[ "$cmd" == *"$PKG"* ]] || return 1
  [[ "$cmd" == *node* || "$cmd" == *unbrowse* ]] || return 1
  return 0
}

chain_depth() { # $1=pid $2=depth-so-far -> longest chain of chain-member procs
  local pid="$1" depth="$2" best="$2" child d
  for child in $(children_of "$pid"); do
    if belongs_to_chain "$child"; then
      d="$(chain_depth "$child" $((depth + 1)))"
      ((d > best)) && best="$d"
    fi
  done
  echo "$best"
}

print_tree() { # $1=pid $2=indent
  local pid="$1" indent="$2" cmd child
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)"
  [[ -z "$cmd" ]] && return
  local rss
  rss="$(awk '{print $1}' <(ps -o rss= -p "$pid" 2>/dev/null) )"
  printf '%s%s [pid %s, rss %sKB] %s\n' "$indent" "└─" "$pid" "${rss:-?}" "$(cut -c1-110 <<<"$cmd")"
  for child in $(children_of "$pid"); do
    belongs_to_chain "$child" && print_tree "$child" "$indent   "
  done
}

trap cleanup EXIT

echo "== unbrowse mcp chain-depth witness =="
echo "package under test : $PKG"
echo "wrapper            : $WRAPPER"
echo "node               : $(node --version)"
echo "pre-existing PIDs  : $PREEXISTING_COUNT (all protected from cleanup)"
echo

# ---------------------------------------------------------------------------
# Launch a REAL MCP server and drive a REAL initialize handshake over stdio.
# In a bash pipeline `$!` is the LAST element, i.e. the node process itself.
# The trailing sleep holds stdin open so the server's readline loop stays live.
# ---------------------------------------------------------------------------
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"chain-depth-witness","version":"1"}}}'

{ printf '%s\n' "$INIT"; sleep "$BOOT_TIMEOUT"; } | node "$WRAPPER" mcp >"$OUT" 2>"$ERR" &
ROOT=$!
echo "launched root pid  : $ROOT"

# Wait for a real JSON-RPC response — proof the server actually came up, not
# merely that a process exists.
READY=0
for _ in $(seq 1 $((BOOT_TIMEOUT * 2))); do
  if grep -q '"jsonrpc"' "$OUT" 2>/dev/null; then READY=1; break; fi
  if ! kill -0 "$ROOT" 2>/dev/null; then break; fi
  sleep 0.5
done

if [[ "$READY" != 1 ]]; then
  echo "FAIL: MCP server never answered initialize within ${BOOT_TIMEOUT}s" >&2
  echo "--- stdout ---"; head -c 2000 "$OUT"
  echo "--- stderr ---"; head -c 2000 "$ERR"
  exit 1
fi

echo "initialize reply   : $(head -c 120 "$OUT")..."
echo

refresh_ps
echo "== process tree (chain members only) =="
print_tree "$ROOT" ""
echo

DEPTH="$(chain_depth "$ROOT" 1)"
COUNT=1
for p in $(descendants_of "$ROOT"); do belongs_to_chain "$p" && COUNT=$((COUNT + 1)); done

echo "== result =="
echo "chain depth        : $DEPTH  (limit $MAX_DEPTH)"
echo "chain processes    : $COUNT"

if ((DEPTH <= MAX_DEPTH)); then
  echo "PASS: one logical MCP server is $COUNT process(es), depth $DEPTH <= $MAX_DEPTH"
  exit 0
fi
echo "FAIL: chain depth $DEPTH exceeds $MAX_DEPTH — hops are still spawning interpreters" >&2
exit 1
