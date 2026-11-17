#!/bin/sh
# Starts a scratch node the way MCP_TEST_PLAN.md says one must run, for CI and for a person alike: its own home and
# temp folder, nothing of the caller's shell, the node's own headless_only setting on, and guards behind it that refuse a
# headed browser and the click that would pass a challenge, each refusal logged. It never touches the owner's node.
#
#   sh test-banks/popular-sites/scratch-node.sh <folder>
#
# Leaves <folder>/token (an agent key), <folder>/node.pid and <folder>/node.log. NODE, BROWSER_PROGRAM, CHROME and PORT
# say what to run, where the defaults aren't right. Keep <folder> short: the browser's socket path holds it.
# The node takes a plain bearer token (`accept_bearer`), for the bank's scripts that send one (curl, run_bank.py); an
# owner's node takes signed requests only. MCP clients get `unb mcp`, which signs.
#
# ALLOW_HEADED=1 lets the node ask again in a window, as an owner's node may: the guards stop refusing `--headed` and a
# launch without `--headless`, and the node runs with windows allowed (`UNBROWSE_HEADLESS=0`). Use it to check a site
# whose door refuses a headless browser; the default run stays headless, as CI's does.
# ARM_B=1 runs the node as arm B of the A/B of its own asks: none of them (no second look, no made-up value sent to
# see whether a call hears, no leave-one-out shrinking, no try of the page's controls, no ask for a next page to see
# how a route reads on, no ask of a route's own value at call time, no heal of a failed call), and a route of one
# sighting is served by the browser for its first new value, the route called beside it and compared
# (`UNBROWSE_CONFIRM_BY_USE`, app/src/learn/own_asks.rs). Leave SECOND_WALK unset with it.
# SECOND_WALK=1 has each learn walk its page a second time, for a word nobody searches for, before it keeps a call
# (`UNBROWSE_SECOND_WALK`): a call that answers the same both times is no candidate. Off for an owner's node unless
# they ask; the bank runs with it.
# LEARN_BY_EXAMPLE=1 has a learn that walked its page twice write its route by example from the two walks
# (`UNBROWSE_LEARN_BY_EXAMPLE`, docs/REBUILD.md); where that writes none, the classifier's route stands. Off by default.
# FILL_BODY=1 has every call's requests built by the route body's filler (`UNBROWSE_FILL_BODY`, docs/REBUILD.md phase
# 5); FILL_SHADOW=1 has the other builder make each request too and log any difference as a `[fill]` line. Off by default.
# SENT_LOG=1 has the node write a line per request it sends to a site, names and sizes only, to <folder>/home/node/sent.jsonl, where the x-ray reads it
# (`UNBROWSE_SENT_LOG`): what a call or a learn asked of the site, counted.
# PROPOSE_PROGRAM names a command that proposes at learn time (`UNBROWSE_PROPOSE_PROGRAM`): it reads an ask as JSON on
# stdin and answers JSON. What it proposes is only ever put to the site, which decides.
# MODEL_BASE points the node's decision model at a server on this machine (decision_shim.py, or a test's stub), with a
# placeholder key. Without it the node looks for its key in the Keychain, as it does for an owner. PRIVATE_NETWORK=true lets
# routes reach this machine: for a test's stub site, never for a run against live sites. ONE_ASK=1 holds what the node's settings
# can't turn off, each hold logged as HELD_: asking a site again in a clean browser after it refused (`Next::Clean`), the
# background try that clicks a learned page's controls (`try_the_page`), and every command to the browser program but
# `close`, which is how a walk falls back after a refusal and how a failed walk hands its page over (`browse_<site>`). For
# a run that takes a wall as a fail. CLEF_OPT_IN=1 lets a node without MODEL_BASE look for the owner's Clef key in the
# Keychain; without it the node gets a placeholder key and a model address where nothing listens, and the rule decides.
set -eu

refuse() {
  echo "scratch-node: $1" >&2
  exit 1
}

dir=${1:?usage: scratch-node.sh <folder>}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
node=${NODE:-${CARGO_TARGET_DIR:-$root/unbrowse-node/target}/debug/unbrowse-node}
program=${BROWSER_PROGRAM:-${CARGO_TARGET_DIR:-$root/unbrowse-browser/cli/target}/debug/agent-browser}
port=${PORT:-17810}
headed=${ALLOW_HEADED:-0}

# Nothing below may reach the owner's node or their keys, so all of it is checked before anything is written.
case "$node" in
  */debug/*) ;;
  *) refuse "NODE must be a debug build: a macOS release build takes the owner's Keychain root key ($node)" ;;
esac
case "$port" in
  *[!0-9]* | 0*) refuse "PORT must be a number with no leading zero, not $port" ;;
esac
[ "$port" != 7788 ] || refuse "7788 is the owner's port"
if [ "$headed" = 1 ] && [ "${ONE_ASK:-}" = 1 ]; then
  refuse "ALLOW_HEADED=1 and ONE_ASK=1 can't both hold: a window is one more way past a wall"
fi
if curl -sf -m 3 -o /dev/null "http://127.0.0.1:$port/v1/health"; then
  refuse "a node already answers on port $port"
fi
case "${PRIVATE_NETWORK:-false}" in
  true | false) ;;
  *) refuse "PRIVATE_NETWORK is true or false, not ${PRIVATE_NETWORK}" ;;
esac
if [ -n "${MODEL_BASE:-}" ]; then
  case "$MODEL_BASE" in
    http://127.0.0.1:*) model_port=${MODEL_BASE#http://127.0.0.1:} ;;
    *) refuse "MODEL_BASE must be http://127.0.0.1:<port>: the node's decisions stay on this machine" ;;
  esac
  case "$model_port" in
    '' | *[!0-9]*) refuse "MODEL_BASE must be http://127.0.0.1:<port>: the node's decisions stay on this machine" ;;
  esac
fi

# The runtime the node signs a page's calls in: found here, in the caller's shell, because the node's own PATH below
# doesn't hold it; SIGNING_PROGRAM names it where `node` on the path isn't right. The node runs a page's code only in a
# runtime it can hold (no child process, no network, no SQLite of its own: `HELD` and `TRIED` in crates/learn/src/sandbox.rs, whose flags and trial these are, held to them by a test there), and
# without one every page-signed route goes to the browser and a run never measures the sandbox. So the bank needs one.
signing=${SIGNING_PROGRAM:-$(command -v node || true)}
[ -n "$signing" ] || refuse "no runtime to sign a page's calls in: the bank needs Node 25 or later on the path, or SIGNING_PROGRAM naming one"
holds='if(!process.permission||process.permission.has("child")||process.getBuiltinModule("node:sqlite"))process.exit(1);var denied=function(e){process.exit(e&&e.code==="ERR_ACCESS_DENIED"?0:1)};try{require("net").connect(9,"127.0.0.1").on("error",denied).on("connect",function(){process.exit(1)})}catch(e){denied(e)}'
if ! "$signing" --permission --no-experimental-sqlite -e "$holds" > /dev/null 2>&1; then
  refuse "$signing ($("$signing" --version 2> /dev/null || echo "no version")) can't hold a page's code: the bank needs Node 25 or later, whose permission model denies child processes and the network (22.13 to 24 leave the network open, older ones have no such model)"
fi

mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
home=$dir/home/node
mkdir -p "$home" "$dir/tmp"
log=$dir/guard.log
: > "$log"

# The decision model: the caller's stand-in, else nothing at all. Port 9 on this machine answers no one, so each question
# fails fast and the rule decides, and the node never reaches for the Keychain item an owner's Clef key sits in.
if [ -n "${MODEL_BASE:-}" ] || [ "${CLEF_OPT_IN:-}" = 1 ]; then model_base=${MODEL_BASE:-}; else model_base=http://127.0.0.1:9; fi

# The DOM the node boots a page on: found here, in the caller's shell, because the node's own PATH and HOME below hold
# neither it nor the runtime (`signing`, above). UNBROWSE_DOM_MODULE names it where the default isn't right.
dom=${UNBROWSE_DOM_MODULE:-}
# A caller with no HOME (a test's bare environment) has no install to find.
[ -n "$dom" ] || [ -z "${HOME:-}" ] || for d in "$HOME/.unbrowse/dom/node_modules/happy-dom" "$HOME/.local/share/unbrowse/dom/node_modules/happy-dom"; do
  [ -d "$d" ] && { dom=$d; break; }
done

# Node env: nothing of the caller's. UNBROWSE_PORT stays unset, since it rewrites settings to the default.
# Run as `in_place=1 in_scratch …` it takes the shell's place (`exec`): a subshell started for it would wait beside the
# node for as long as the node runs, a copy of this script per node started.
in_scratch() {
  ${in_place:+exec} env -i HOME="$dir/home" UNBROWSE_HOME="$home" TMPDIR="$dir/tmp" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    UNBROWSE_BROWSER="$dir/guard-browser" UNBROWSE_DEVNET_PORT=$((port + 1)) UNBROWSE_DEVNET_FORK=none \
    UNBROWSE_TELEMETRY=0 UNBROWSE_REPORTS=0 ${signing:+SIGNING_PROGRAM="$signing"} ${dom:+UNBROWSE_DOM_MODULE="$dom"} ${SIGN_DEBUG:+UNBROWSE_SIGN_DEBUG=1} ${SENT_LOG:+UNBROWSE_SENT_LOG="$home/sent.jsonl"} ${SECOND_WALK:+UNBROWSE_SECOND_WALK=1} ${LEARN_BY_EXAMPLE:+UNBROWSE_LEARN_BY_EXAMPLE=1} ${FILL_BODY:+UNBROWSE_FILL_BODY=1} ${FILL_SHADOW:+UNBROWSE_FILL_SHADOW=1} ${ARM_A:+UNBROWSE_ARM_A=1} ${ARM_B:+UNBROWSE_CONFIRM_BY_USE=1 UNBROWSE_NO_SECOND_LOOK=1 UNBROWSE_NO_NONSENSE=1 UNBROWSE_NO_SHRINK=1 UNBROWSE_NO_TRY=1 UNBROWSE_NO_PAGING=1 UNBROWSE_NO_RECHECK=1 UNBROWSE_NO_HEAL=1 UNBROWSE_NO_AGAIN=1 UNBROWSE_NO_PAGE_VALUES=1} ${PROPOSE_PROGRAM:+UNBROWSE_PROPOSE_PROGRAM="$PROPOSE_PROGRAM"} ${headed:+"UNBROWSE_HEADLESS=$([ "$headed" = 1 ] && echo 0 || echo 1)"} ${model_base:+TYPESAFE_API_BASE="$model_base" TYPESAFE_API_KEY=placeholder TYPESAFE_MODEL=placeholder} "$@"
}

settings() {
  cat > "$home/settings.json" <<JSON
{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":$port,"storage_gb":1.0,
 "excluded":[],"share_routes":"off","share_notice_seen":true,"private_network":${PRIVATE_NETWORK:-false},"terms_accepted":"2026-10-29",
 "peer_network":false,"light":true,"auto_update":false,"fetch_browser":$1,"headless_only":$([ "$headed" = 1 ] && echo false || echo true),"passkeys":false,"passkeys_never":[],"max_fetch_usdc":0,"accept_bearer":true}
JSON
}

# The browser program: refuses a headed window, and a click in a walk's own session, which is only the mint's challenge path.
cat > "$dir/guard-browser" <<GUARD
#!/bin/sh
[ "$headed" = 1 ] || for a in "\$@"; do
  [ "\$a" = --headed ] && { echo "REFUSED_HEADED \$*" >> "$log"; echo "the run's guard refused a headed window" >&2; exit 1; }
done
case " \$* " in
  *" --session learn_"*" click "*) echo "REFUSED_CLICK \$*" >> "$log"; echo "the run's guard refused a click in a walk" >&2; exit 1 ;;
esac
if [ "${ONE_ASK:-}" = 1 ]; then
  case " \$* " in
    *" close "*) ;;
    *) echo "HELD_PROGRAM \$*" >> "$log"; echo "the run's guard holds the site to one ask: no browser takes over after a walk" >&2; exit 1 ;;
  esac
fi
exec "$program" "\$@"
GUARD
chmod +x "$dir/guard-browser"

# The node's own pid goes in node.pid, not a background function's subshell: `kill` has to reach the node, and a run measures it.
# The subshell becomes the node (`in_place`), so no copy of this script is left waiting behind it.
start() {
  (in_place=1 in_scratch sh -c 'echo $$ > "$0"; exec nohup "$1"' "$dir/node.pid" "$node" >> "$dir/node.log" 2>&1) &
}

wait_for() {
  n=0
  until curl -sf -o /dev/null "http://127.0.0.1:$port/v1/health"; do
    n=$((n + 1))
    [ "$n" -lt 60 ] || { echo "the scratch node didn't start" >&2; tail -20 "$dir/node.log" >&2; exit 1; }
    sleep 2
  done
}

chrome=${CHROME:-}
[ -n "$chrome" ] || for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
  [ -x "$c" ] && { chrome=$c; break; }
done

# No Chrome on this machine: the node fetches one, as it would for an owner, and the guard goes in front of that.
if [ -z "$chrome" ]; then
  settings true
  start
  wait_for
  n=0
  while [ -z "$chrome" ]; do
    chrome=$(curl -s -X POST -H "Authorization: Bearer $(cat "$home/owner.token")" -H 'content-type: application/json' -d '{}' \
      "http://127.0.0.1:$port/owner/browsers" | sed -n 's/.*"using":"\([^"]*\)".*/\1/p')
    n=$((n + 1))
    [ "$n" -lt 120 ] || { echo "the scratch node has no browser" >&2; exit 1; }
    [ -n "$chrome" ] || sleep 5
  done
  kill "$(cat "$dir/node.pid")"
  sleep 3
fi

# Chrome itself: runs only headless. A window a walk asked for is logged, and what it would have done stays unknown.
cat > "$dir/guard-chrome" <<GUARD
#!/bin/sh
if [ "${ONE_ASK:-}" = 1 ]; then
  for a in "\$@"; do
    case "\$a" in
      --user-data-dir=*/unbrowse-node-tries/*) echo "HELD_TRY" >> "$log"; exit 1 ;;
      --user-data-dir=*/????????-????-????-????-????????????) echo "HELD_CLEAN" >> "$log"; exit 1 ;;
    esac
  done
fi
[ "$headed" = 1 ] && { echo chrome_headed_launch >> "$log"; exec "$chrome" "\$@"; }
for a in "\$@"; do
  case "\$a" in --headless*) echo "chrome_headless_launch \$*" >> "$log"; exec "$chrome" "\$@" ;; esac
done
echo "REFUSED_WINDOW \$*" >> "$log"
exit 1
GUARD
chmod +x "$dir/guard-chrome"
printf '{"path": "%s"}\n' "$dir/guard-chrome" > "$home/browser.json"

settings false
start
wait_for
in_scratch "$node" agent new bank 2>/dev/null | grep -o 'unb_[A-Za-z0-9_.-]*' | head -n 1 > "$dir/token"
chmod 600 "$dir/token"
[ -s "$dir/token" ] || { echo "couldn't make an agent key" >&2; exit 1; }
echo "scratch node on 127.0.0.1:$port, browsing through $chrome"
