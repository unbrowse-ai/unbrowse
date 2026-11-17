#!/bin/sh
# Starts a scratch node the way MCP_TEST_PLAN.md says one must run, for CI and for a person alike: its own home and
# temp folder, nothing of the caller's shell, the node's own headless_only setting on, and guards behind it that refuse a
# headed browser and the click that would pass a challenge, each refusal logged. It never touches the owner's node.
#
#   sh test-banks/popular-sites/scratch-node.sh <folder>
#
# Leaves <folder>/token (an agent key), <folder>/node.pid and <folder>/node.log. NODE, BROWSER_PROGRAM, CHROME and PORT
# say what to run, where the defaults aren't right. Keep <folder> short: the browser's socket path holds it.
#
# ALLOW_HEADED=1 lets the node ask again in a window, as an owner's node may: the guards stop refusing `--headed` and a
# launch without `--headless`, and the node runs with windows allowed (`UNBROWSE_HEADLESS=0`). Use it to check a site
# whose door refuses a headless browser; the default run stays headless, as CI's does.
#
# The signing sandbox has no real-DOM mode any more (`UNBROWSE_DOM_MODULE` is ignored): a DOM module runs as the
# runtime's own code, and the page's realm holds nothing of the runtime's. A framework page that needs a real DOM goes
# to the browser.
set -eu

dir=${1:?usage: scratch-node.sh <folder>}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
node=${NODE:-${CARGO_TARGET_DIR:-$root/unbrowse-node/target}/debug/unbrowse-node}
program=${BROWSER_PROGRAM:-${CARGO_TARGET_DIR:-$root/unbrowse-browser/cli/target}/debug/agent-browser}
port=${PORT:-17810}
headed=${ALLOW_HEADED:-0}

mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
home=$dir/home/node
mkdir -p "$home" "$dir/tmp"
log=$dir/guard.log
: > "$log"

# Node env: nothing of the caller's. UNBROWSE_PORT stays unset, since it rewrites settings to the default.
in_scratch() {
  env -i HOME="$dir/home" UNBROWSE_HOME="$home" TMPDIR="$dir/tmp" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    UNBROWSE_BROWSER="$dir/guard-browser" UNBROWSE_DEVNET_PORT=$((port + 1)) UNBROWSE_DEVNET_FORK=none \
    SIGNING_PROGRAM="${SIGNING_PROGRAM:-}" UNBROWSE_TELEMETRY=0 UNBROWSE_REPLAY_DEBUG=1 UNBROWSE_SIGN_DEBUG=1 UNBROWSE_SIGN_SETTLE_MS="${UNBROWSE_SIGN_SETTLE_MS:-}" UNBROWSE_SIGN_PROBE="${UNBROWSE_SIGN_PROBE:-}" UNBROWSE_GENERATE_PROGRAM="${UNBROWSE_GENERATE_PROGRAM:-}" UNBROWSE_GENERATE_MS="${UNBROWSE_GENERATE_MS:-}" UNBROWSE_PROXY="${UNBROWSE_PROXY:-}" UNBROWSE_CDP="${UNBROWSE_CDP:-}" UNBROWSE_REPORTS=0 ${headed:+"UNBROWSE_HEADLESS=$([ "$headed" = 1 ] && echo 0 || echo 1)"} "$@"
}

settings() {
  cat > "$home/settings.json" <<JSON
{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":$port,"storage_gb":1.0,
 "excluded":[],"share_routes":"off","share_notice_seen":true,"private_network":false,"terms_accepted":"2026-10-29",
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
exec "$program" "\$@"
GUARD
chmod +x "$dir/guard-browser"

start() {
  in_scratch nohup "$node" >> "$dir/node.log" 2>&1 &
  echo $! > "$dir/node.pid"
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
[ "$headed" = 1 ] && { echo chrome_headed_launch >> "$log"; exec "$chrome" "\$@"; }
for a in "\$@"; do
  case "\$a" in --headless*) echo chrome_headless_launch >> "$log"; exec "$chrome" "\$@" ;; esac
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
