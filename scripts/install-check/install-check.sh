#!/bin/sh
# The install check: run after installing an Unbrowse build, it drives that build's own node and `unb` against a fixture
# site on this machine whose pages land the way the sites behind 17-18 November's bugs did, and fails loudly when one of
# those bugs is back.
#
#   sh scripts/install-check/install-check.sh [<path to Unbrowse.app>]      (default /Applications/Unbrowse.app)
#
# What runs: the app's `unbrowse-node`, in a scratch home of its own (its root key in a file there, never the Keychain),
# on its own port, headless, with the browsers installed here kept off (`UNBROWSE_SYSTEM_BROWSERS=0`), so it never opens
# the owner's Chrome profile or reads its cookie key; it browses with the Chrome for Testing it downloaded before
# (~/.agent-browser/browsers), through a wrapper that maps the hosts install-check.test and install-check-captcha.test
# to the fixture (fixture_site.py, HTTPS on 127.0.0.1). The owner's node, its home and port 7788 are never touched. Each check drives
# the app's `unb` (`unb browse ...`), as an agent does, and reads its reply.
#
# The checks, each named for the bug it guards:
#   #602  a signed-out page sent to its sign-in (302 to /login?next=...) needs the owner, and the node reached for the
#         owner's browser session first
#   #622  a sign-in whose first HTML is only a check's widget and a shell its script draws the form into is still a
#         sign-in the node reaches for the owner's browser session on (on a second site, install-check-captcha.test:
#         the node reaches for a site's session once in 10 minutes)
#   #625  an app's shell (a check's widget and an empty root, its page drawn by script) at the address asked for is the
#         page, carrying a check
#   #624  a click that downloaded a file did something: not "the click changed nothing"
#   import  a session imported from a cookie file signs the node's browser in: the account and members pages open
#   #617  a second node on the same home stops at once and leaves the first serving
#   path  `unbrowse` on the PATH (~/.local/bin/unbrowse) is this install's `unb`
#
# Exit 0 when every check passes, 1 when any fails (each failure prints the reply it got, verbatim), 2 when the check
# couldn't run at all. Environment: PORT (the scratch node's API port, default 17840; never 7788), CHROME (the Chrome
# for Testing binary to wrap, default the newest under ~/.agent-browser/browsers), BROWSER_PROGRAM (the browser
# program, for an app that ships none beside its node; default the one beside it), KEEP=1 (keep the scratch folder and
# its logs: node.log, fixture.log, chrome.log, replies/).
#
# macOS only (an app bundle). Python runs as `python3 -I`.
set -u

die() {
  echo "install-check: $1" >&2
  exit 2
}

here=$(cd "$(dirname "$0")" && pwd)
app=${1:-/Applications/Unbrowse.app}
app=${app%/}
bin=$app/Contents/MacOS
node=$bin/unbrowse-node
unb=$bin/unb
port=${PORT:-17840}

[ "$(uname -s)" = Darwin ] || die "this check runs an app bundle: macOS only"
for f in "$node" "$unb"; do
  [ -x "$f" ] || die "$f isn't there: is Unbrowse installed at $app?"
done
case "$port" in
  '' | *[!0-9]* | 0*) die "PORT must be a number with no leading zero, not $port" ;;
esac
[ "$port" != 7788 ] || die "7788 is the owner's node: give the scratch node another PORT"
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$port/v1/health"; then
  die "something already answers on port $port: give the scratch node another PORT"
fi
command -v python3 > /dev/null || die "python3 isn't on the PATH"
command -v openssl > /dev/null || die "openssl isn't on the PATH (it makes the fixture's certificate)"

# The node's own downloaded Chrome for Testing: with the browsers installed here off, it is the only browser the node
# takes (`browsers::on_this_machine`), and found where the engine looks, under $HOME (`paths::get_browsers_dir`).
chrome=${CHROME:-}
if [ -z "$chrome" ]; then
  # Newest version first, by number, as the engine picks (`paths::find_installed_chrome`).
  chrome=$(python3 -I -c '
import glob, os, sys
def version(d):
    try:
        return [int(p) for p in d.rsplit("-", 1)[1].split(".")]
    except ValueError:
        return []
for d in sorted(glob.glob(os.path.join(sys.argv[1], "chrome-*")), key=version, reverse=True):
    c = os.path.join(d, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
    if os.access(c, os.X_OK):
        print(c)
        break' "$HOME/.agent-browser/browsers")
fi
[ -n "$chrome" ] && [ -x "$chrome" ] || die "no Chrome for Testing under ~/.agent-browser/browsers (the node downloads one: \`unbrowse browser install\`), or set CHROME to one"
version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist" 2> /dev/null || echo unknown)

# Short: the browser's socket path holds it.
dir=$(mktemp -d /tmp/uic.XXXXXX) || die "couldn't make a scratch folder"
home=$dir/home/node
replies=$dir/replies
mkdir -p "$home" "$dir/tmp" "$replies"
node_pid= fixture_pid=

stop() {
  [ -n "$node_pid" ] && kill "$node_pid" 2> /dev/null
  [ -n "$fixture_pid" ] && kill "$fixture_pid" 2> /dev/null
  # The node closes the browsers it started as it stops; whatever is left of this run (a second node, a browser, the
  # browser program's daemon) holds the scratch folder in its command line or its environment. Never this shell or
  # its parent.
  n=0
  while [ -n "$node_pid" ] && kill -0 "$node_pid" 2> /dev/null && [ "$n" -lt 20 ]; do
    sleep 0.5
    n=$((n + 1))
  done
  for p in $(pgrep -f "$dir/" 2> /dev/null) $(ps -A -E -ww -o pid=,command= 2> /dev/null | awk -v h="UNBROWSE_HOME=$home " 'index($0, h) && $2 !~ /awk/ { print $1 }'); do
    [ "$p" = $$ ] || [ "$p" = "$PPID" ] || kill "$p" 2> /dev/null
  done
  if [ "${KEEP:-}" = 1 ]; then
    echo "install-check: kept $dir"
  else
    rm -rf "$dir"
  fi
}
trap stop EXIT
trap 'exit 2' INT TERM HUP

# The fixture, over HTTPS with a certificate made for this run; the browser trusts that certificate alone (its key's
# hash, below), not every certificate.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$dir/key.pem" -out "$dir/cert.pem" -days 1 -subj /CN=install-check.test > /dev/null 2>&1 ||
  die "openssl couldn't make the fixture's certificate"
spki=$(openssl x509 -in "$dir/cert.pem" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
signs_in=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
python3 -I "$here/fixture_site.py" --port 0 --session "$signs_in" --ready "$dir/fixture.port" --cert "$dir/cert.pem" --key "$dir/key.pem" 2> "$dir/fixture.log" &
fixture_pid=$!
n=0
until [ -s "$dir/fixture.port" ]; do
  n=$((n + 1))
  [ "$n" -lt 50 ] || die "the fixture site didn't start: $(tail -5 "$dir/fixture.log")"
  sleep 0.2
done
fixture_port=$(cat "$dir/fixture.port")

# The browser the node launches: the Chrome for Testing above, headless only, with the fixture's hosts mapped to it.
# The node's browser reaches every site through the node's egress proxy, which never lets a page reach this machine
# (`proxy::browser_may_reach`), so the fixture's hosts alone go around it, in this scratch browser only; every other
# host still goes through it. A switch given twice takes its last value, so these come after the node's.
wrapper_dir="$dir/home/.agent-browser/browsers/$(basename "$(dirname "$(dirname "$(dirname "$(dirname "$chrome")")")")")/Google Chrome for Testing.app/Contents/MacOS"
mkdir -p "$wrapper_dir"
cat > "$wrapper_dir/Google Chrome for Testing" << WRAP
#!/bin/sh
for a in "\$@"; do
  case "\$a" in
    --headless*)
      echo "launch" >> "$dir/chrome.log"
      exec "$chrome" "\$@" "--host-resolver-rules=MAP install-check.test 127.0.0.1:$fixture_port, MAP install-check-captcha.test 127.0.0.1:$fixture_port" \\
        "--proxy-bypass-list=install-check.test;install-check-captcha.test;<-loopback>" "--ignore-certificate-errors-spki-list=$spki"
      ;;
  esac
done
echo "REFUSED_WINDOW: the install check runs headless" >> "$dir/chrome.log"
exit 1
WRAP
chmod +x "$wrapper_dir/Google Chrome for Testing"

# Written at the settings format's version 5, as test-banks/popular-sites/scratch-node.sh writes it: off the network,
# headless, no fetching, nothing shared.
cat > "$home/settings.json" << JSON
{"v":5,"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":$port,"storage_gb":1.0,
 "excluded":[],"share_routes":"off","share_notice_seen":true,"private_network":false,"terms_accepted":"2026-10-29",
 "peer_network":false,"light":true,"auto_update":false,"fetch_browser":false,"headless_only":true,"passkeys":false,"passkeys_never":[],"max_fetch_usdc":0,"accept_bearer":true}
JSON

# The node's environment: nothing of the caller's. Its key in a file in its own home (`UNBROWSE_ROOT_KEY_FILE`), the
# browsers installed here off, and a decision model where nothing listens, so the node never looks in the Keychain for a
# model key and the rule decides. Run as `(in_place=1; in_scratch ...) &` it takes the subshell's place (`exec`), so `$!`
# is the node's own pid, the one `kill` has to reach.
in_scratch() {
  ${in_place:+exec} env -i HOME="$dir/home" UNBROWSE_HOME="$home" TMPDIR="$dir/tmp" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    UNBROWSE_ROOT_KEY_FILE=1 UNBROWSE_SYSTEM_BROWSERS=0 UNBROWSE_HEADLESS=1 UNBROWSE_TELEMETRY=0 UNBROWSE_REPORTS=0 \
    TYPESAFE_API_BASE=http://127.0.0.1:9 TYPESAFE_API_KEY=placeholder TYPESAFE_MODEL=placeholder \
    ${BROWSER_PROGRAM:+UNBROWSE_BROWSER="$BROWSER_PROGRAM"} "$@"
}

# A command, killed after $1 seconds: an answer that never comes is a failure, not a hang. A program, not a function,
# so it runs inside `in_scratch` too.
within() {
  /usr/bin/perl -e 'alarm shift; exec @ARGV or die "$ARGV[0]: $!\n"' "$@"
}

(
  in_place=1
  in_scratch "$node"
) >> "$dir/node.log" 2>&1 &
node_pid=$!
n=0
until curl -sf -m 2 -o /dev/null "http://127.0.0.1:$port/v1/health"; do
  n=$((n + 1))
  kill -0 "$node_pid" 2> /dev/null || die "the node stopped as it started: $(tail -5 "$dir/node.log")"
  [ "$n" -lt 60 ] || die "the node didn't answer on $port within a minute: $(tail -5 "$dir/node.log")"
  sleep 1
done
[ -f "$home/root.key" ] || die "the scratch node's key isn't in its home: it may have gone to the Keychain; stopped"
agent=$(in_scratch "$node" agent new install-check 2> /dev/null | sed -n 's/.* agent token \([0-9][0-9]*\).*/\1/p' | head -n 1)
token=
[ -n "$agent" ] && token=$(in_scratch "$node" agent token "$agent" < /dev/null 2> /dev/null | grep -o 'unb_[A-Za-z0-9_.-]*' | head -n 1)
[ -n "$token" ] || die "couldn't make an agent key on the scratch node"

echo "install check: Unbrowse $version at $app"
echo "  scratch node on 127.0.0.1:$port, fixture at https://install-check.test (127.0.0.1:$fixture_port)"
echo

site=https://install-check.test
passed=0
failed=0

# unb, as an agent runs it, against the scratch node. Its reply goes to replies/<name>.json.
agent_unb() {
  name=$1
  shift
  UNBROWSE_NODE="http://127.0.0.1:$port" UNBROWSE_AGENT_TOKEN="$token" within 150 "$unb" "$@" > "$replies/$name.json" 2>&1
}

# Whether a reply (a JSON object) holds: a Python expression over `r`, the reply, and `o`, its output text.
holds() {
  python3 -I -c '
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except ValueError:
    sys.exit(1)
o = r.get("output") or ""
sys.exit(0 if eval(sys.argv[2], {"r": r, "o": o}) else 1)' "$1" "$2"
}

pass() {
  passed=$((passed + 1))
  printf 'PASS  %-7s %s\n' "$1" "$2"
}

fail() {
  failed=$((failed + 1))
  printf 'FAIL  %-7s %s\n' "$1" "$2"
  [ -n "${3:-}" ] && [ -f "$3" ] && sed 's/^/        | /' "$3"
  [ -n "${4:-}" ] && printf '        %s\n' "$4"
}

# check <bug> <what> <reply name> <expression>
check() {
  if holds "$replies/$3.json" "$4"; then pass "$1" "$2"; else fail "$1" "$2" "$replies/$3.json"; fi
}

# --- Signed out ---------------------------------------------------------------------------------------------------

agent_unb account-signed-out browse open "$site/account" --session account-out
check '#602' "a signed-out page sent to its sign-in (/account -> /login?next=) needs the owner, not done" account-signed-out \
  'r.get("needs_owner") is True and "/login?next=%2Faccount" in o'
# The node reaches for the owner's browser session once a site in 10 minutes; here, with the browsers installed here off,
# it finds none and says so in its log.
if grep -q "\[browse\] install-check.test sent the page to $site/login?next=%2Faccount; " "$dir/node.log"; then
  pass '#602' "the node reached for the owner's browser session before asking the owner"
else
  fail '#602' "the node reached for the owner's browser session before asking the owner" "" \
    "node.log has no '[browse] install-check.test sent the page to $site/login?next=%2Faccount; ...' line"
fi

# Another site, so the node's once-in-10-minutes reach for a site's session is this landing's.
captcha=https://install-check-captcha.test
agent_unb members-signed-out browse open "$captcha/members" --session members-out
if grep -q "\[browse\] install-check-captcha.test sent the page to $captcha/login-check?next=%2Fmembers; " "$dir/node.log"; then
  pass '#622' "a sign-in whose first HTML is a check's widget and a script-drawn form: the node reached for the owner's session"
else
  fail '#622' "a sign-in whose first HTML is a check's widget and a script-drawn form: the node reached for the owner's session" \
    "$replies/members-signed-out.json" "node.log has no '[browse] install-check-captcha.test sent the page to $captcha/login-check?next=%2Fmembers; ...' line"
fi

agent_unb app browse open "$site/app" --session app
check '#625' "an app shell (a check's widget, its page drawn by script) at the address asked for is the page" app \
  'r.get("outcome") != "challenge" and not r.get("needs_owner") and "a check that asks for a person" not in o'

agent_unb files browse open "$site/files" --session files
agent_unb download browse click "#download" --session files
check '#624' "a click that downloaded a file did something (Downloaded report.csv), not 'the click changed nothing'" download \
  'not r.get("needs_owner") and "Downloaded report.csv" in o'

# --- Signed in, from a cookie file ---------------------------------------------------------------------------------

expires=$(($(date +%s) + 86400))
(umask 077 && printf '# Netscape HTTP Cookie File\ninstall-check.test\tFALSE\t/\tTRUE\t%s\tsession\t%s\n' "$expires" "$signs_in" > "$dir/cookies.txt")
if in_scratch /usr/bin/perl -e 'alarm shift; exec @ARGV' 120 "$node" session import install-check.test --from "$dir/cookies.txt" > "$replies/import.txt" 2>&1 &&
  grep -q "kept 1 cookies for install-check.test" "$replies/import.txt"; then
  pass import "a session imported from a cookie file is kept for the site and put in its browser"
else
  fail import "a session imported from a cookie file is kept for the site and put in its browser" "$replies/import.txt"
fi
rm -f "$dir/cookies.txt"

agent_unb account-signed-in browse open "$site/account" --session account-in
agent_unb account-signed-in-text browse get text body --session account-in
if holds "$replies/account-signed-in.json" 'r.get("outcome") in (None, "answered") and not r.get("needs_owner")' &&
  holds "$replies/account-signed-in-text.json" '"Signed in as" in o'; then
  pass import "signed in, /account opens the account page"
else
  fail import "signed in, /account opens the account page" "$replies/account-signed-in.json"
  sed 's/^/        | /' "$replies/account-signed-in-text.json"
fi

agent_unb members-signed-in browse open "$site/members" --session members-in
agent_unb members-signed-in-text browse get text body --session members-in
if holds "$replies/members-signed-in.json" 'r.get("outcome") in (None, "answered") and not r.get("needs_owner")' &&
  holds "$replies/members-signed-in-text.json" '"Signed in as" in o'; then
  pass import "signed in, /members opens the members' page"
else
  fail import "signed in, /members opens the members' page" "$replies/members-signed-in.json"
  sed 's/^/        | /' "$replies/members-signed-in-text.json"
fi

# --- The node itself ----------------------------------------------------------------------------------------------

# Last, as a build without the fix would start a second node beside the first.
(
  in_place=1
  in_scratch "$node"
) > "$replies/second-node.txt" 2>&1 &
second=$!
n=0
while kill -0 "$second" 2> /dev/null && [ "$n" -lt 30 ]; do
  sleep 0.5
  n=$((n + 1))
done
if kill -0 "$second" 2> /dev/null; then
  kill "$second" 2> /dev/null
  fail '#617' "a second node on the same home stops at once" "$replies/second-node.txt" "it was still running 15 s later"
elif grep -q "a node is already running or starting here" "$replies/second-node.txt" &&
  curl -sf -m 5 -o /dev/null "http://127.0.0.1:$port/v1/health"; then
  pass '#617' "a second node on the same home stops at once, and the first still serves"
else
  fail '#617' "a second node on the same home stops at once, and the first still serves" "$replies/second-node.txt"
fi

real() {
  python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]) if os.path.exists(sys.argv[1]) else "")' "$1"
}
on_path=$(real "$HOME/.local/bin/unbrowse")
if [ -n "$on_path" ] && [ "$on_path" = "$(real "$unb")" ]; then
  pass path "~/.local/bin/unbrowse is this install's unb"
else
  fail path "~/.local/bin/unbrowse is this install's unb" "" "it is: ${on_path:-not there}"
fi

echo
echo "install check: $passed passed, $failed failed (Unbrowse $version)"
[ "$failed" -eq 0 ]
