#!/usr/bin/env bash
# installer-remote-onboarding.sh <macos|windows|linux> <folder for screenshots and logs>
#
# After installer-device-test.sh, on the same machine and with the window on its Connect screen: the remote MCP
# address the way a person sets it up, by clicks alone. Open "Use it from another computer", turn the address on, read
# it, let an MCP client sign in with nothing but that address (what Claude's custom connector or Cursor does: OAuth
# discovery, registration, the browser page), say Allow in the node's own dialog, and call initialize and tools/list
# through unbrowse.ai with the token the client got. Prints REMOTE_ONBOARDING_OK. It reaches the live gateway at
# unbrowse.ai, so it reports and never gates the draft.
set -u
os=$1 out=$2
say() { echo "$*" | tee -a "$out/remote.txt"; }
py=$(command -v python3 || command -v python)
case "$os" in
  macos)
    # Where the window draws its controls on the runner's 1024x768 screen (from the device test's screenshots).
    link=(326 325) toggle=(302 448)
    home=$HOME
    cat >"$RUNNER_TEMP/click.swift" <<'EOF'
import CoreGraphics
let a = CommandLine.arguments, p = CGPoint(x: Double(a[1])!, y: Double(a[2])!)
for t in [CGEventType.leftMouseDown, .leftMouseUp] { CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap) }
EOF
    swiftc -O -o "$RUNNER_TEMP/click" "$RUNNER_TEMP/click.swift" 2>"$out/swiftc.txt" || true
    click() { "$RUNNER_TEMP/click" "$1" "$2"; }
    shot() { screencapture -x "$out/macos-remote-$1.png"; }
    # The node's dialog is osascript's `display dialog`: its Allow button, pressed as a person would.
    allow() { osascript -e 'tell application "System Events" to tell (first process whose name is "osascript") to click button "Allow" of window 1'; }
    ;;
  windows)
    link=(316 333) toggle=(302 460)
    home=$USERPROFILE
    ps() { powershell -NoProfile -Command "$1"; }
    user32='Add-Type -Namespace W -Name U -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindow(string c, string t);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindowEx(System.IntPtr p, System.IntPtr a, string c, string t);
[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, int m, System.IntPtr w, System.IntPtr l);
"@;'
    click() { ps "$user32 [W.U]::SetCursorPos($1,$2) | Out-Null; [W.U]::mouse_event(2,0,0,0,0); [W.U]::mouse_event(4,0,0,0,0)"; }
    shot() {
      ps "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \$i=New-Object System.Drawing.Bitmap \$b.Width,\$b.Height; [System.Drawing.Graphics]::FromImage(\$i).CopyFromScreen(\$b.Location,[System.Drawing.Point]::Empty,\$b.Size); \$i.Save('$(cygpath -w "$out")\\windows-remote-$1.png')" || true
    }
    # The node's dialog is a MessageBox (class #32770) titled Unbrowse: its OK button, clicked (BM_CLICK).
    allow() { ps "$user32 \$d=[W.U]::FindWindow('#32770','Unbrowse'); if (\$d -eq [IntPtr]::Zero) { exit 1 }; \$ok=[W.U]::FindWindowEx(\$d,[IntPtr]::Zero,'Button','OK'); [W.U]::SendMessage(\$ok,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null"; }
    ;;
  linux)
    # The device test's Xvfb screen (:9, 1400x900) and its window at the top left.
    link=(405 299) toggle=(380 422)
    home=$HOME
    export DISPLAY=:9
    click() { xdotool mousemove "$1" "$2" click 1; }
    shot() { import -window root "$out/linux-remote-$1.png" || true; }
    # The node's dialog is zenity's question: Allow is its right-hand button, clicked where it is drawn (Enter would
    # answer Cancel, the default).
    allow() {
      local w; w=$(xdotool search --onlyvisible --class zenity | head -1); [ -n "$w" ] || return 1
      eval "$(xdotool getwindowgeometry --shell "$w")"
      xdotool mousemove $((X + WIDTH * 3 / 4)) $((Y + HEIGHT - 28)) click 1
    }
    ;;
  *) echo "usage: $0 <macos|windows|linux> <out>"; exit 2 ;;
esac

click "${link[@]}"; sleep 3; shot 1-open
click "${toggle[@]}"
url=""
for i in $(seq 1 40); do
  url=$(grep -o 'https://[a-z.]*/p/[A-Za-z0-9]*/mcp' "$home/.unbrowse/node.log" 2>/dev/null | tail -1)
  [ -n "$url" ] && break; sleep 1
done
shot 2-on
[ -n "$url" ] || { say "REMOTE_ONBOARDING_FAIL: the address never came on (no 'remote: linked' in node.log)"; exit 1; }
say "address: $url"

# The client: discovery, registration, authorize with PKCE, then wait for the owner's answer on this machine.
site=${url%%/p/*} base=${url%/mcp} path=${base#"$site"/}
as=$(curl -s -m 20 "$site/.well-known/oauth-authorization-server/$path")
ep() { "$py" -c "import json,sys;print(json.loads(sys.argv[1])[sys.argv[2]])" "$as" "$1"; }
reg=$(curl -s -m 20 -X POST "$(ep registration_endpoint)" -H content-type:application/json -d '{"client_name":"Device test","redirect_uris":["http://127.0.0.1:33418/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"]}')
cid=$("$py" -c "import json,sys;print(json.loads(sys.argv[1])['client_id'])" "$reg")
v=$("$py" -c 'import secrets;print(secrets.token_urlsafe(48))')
c=$(printf %s "$v" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
page=$(curl -s -m 20 "$(ep authorization_endpoint)?response_type=code&client_id=$cid&redirect_uri=http%3A%2F%2F127.0.0.1%3A33418%2Fcallback&code_challenge=$c&code_challenge_method=S256&state=st&resource=$url")
wait=$(echo "$page" | grep -o 'https://[^"]*oauth/wait?rid=[A-Za-z0-9_-]*')
say "sign-in page: $(echo "$page" | grep -o '<h1>[^<]*' | head -1 | sed 's/<h1>//')"
# The page polls for the answer, as the browser tab does, while the owner answers the node's dialog.
( for i in $(seq 1 60); do a=$(curl -s -m 20 "$wait"); case "$a" in *redirect*) echo "$a" >"$RUNNER_TEMP/answer"; break ;; esac; sleep 2; done ) &
poller=$!
for i in $(seq 1 60); do
  [ "$i" = 6 ] && shot 3-dialog
  allow 2>>"$out/allow.txt" && say "Allow pressed after ${i}s" && break
  sleep 1
done
wait "$poller"
answer=$(cat "$RUNNER_TEMP/answer" 2>/dev/null)
code=$("$py" -c "import json,sys,urllib.parse as u;print(dict(u.parse_qsl(u.urlparse(json.loads(sys.argv[1])['redirect']).query)).get('code',''))" "$answer" 2>/dev/null)
[ -n "$code" ] || { say "REMOTE_ONBOARDING_FAIL: no code: ${answer:0:300}"; shot 4-end; exit 1; }
tok=$(curl -s -m 20 -X POST "$(ep token_endpoint)" -d grant_type=authorization_code -d "code=$code" -d "client_id=$cid" -d "code_verifier=$v" -d redirect_uri=http://127.0.0.1:33418/callback -d "resource=$url")
key=$("$py" -c "import json,sys;print(json.loads(sys.argv[1]).get('access_token',''))" "$tok")
[ -n "$key" ] || { say "REMOTE_ONBOARDING_FAIL: no token"; exit 1; }
h() { curl -s -m 60 -X POST "$url" -H "authorization: Bearer $key" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18' "$@"; }
h -D "$RUNNER_TEMP/rh" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"device-test","version":"1"}}}' >"$out/remote-initialize.json"
sid=$(grep -i '^mcp-session-id:' "$RUNNER_TEMP/rh" | cut -d' ' -f2 | tr -d '\r')
h ${sid:+-H "mcp-session-id: $sid"} -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' >"$out/remote-tools.json"
tools=$(grep -o '"name":"unbrowse_[a-z_]*"' "$out/remote-tools.json" | sort -u | wc -l | tr -d ' ')
shot 4-end
if grep -q '"serverInfo"' "$out/remote-initialize.json" && [ "$tools" -gt 0 ]; then
  say "REMOTE_ONBOARDING_OK: signed in with the address alone, $tools tools through $site"
else say "REMOTE_ONBOARDING_FAIL: initialize or tools/list"; exit 1; fi
