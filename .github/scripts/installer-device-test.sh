#!/usr/bin/env bash
# installer-device-test.sh <macos|windows|linux> <folder holding the installers> <folder for screenshots and logs>
#
# Installs one installer on this machine the way a person does, opens Unbrowse the way a person does (the app from
# Applications, the Start menu entry, the app menu's desktop entry) and nothing else, then checks from outside:
#   INSTALL_OK      the installer finished and put the window, the node and unb where they belong
#   NODE_UP_OK      the window started the node by itself: /v1/health answers on 127.0.0.1:7788 and the owner token
#                   is written, within 90 s, on an account that had no ~/.unbrowse
#   LOCAL_MCP_OK    the node's MCP answers initialize and tools/list at http://127.0.0.1:7788/mcp
# and prints DEVICE_TEST_OK when all three hold. Screenshots of the window go to the output folder.
# Run on a fresh machine (a GitHub-hosted runner): it installs for the user it runs as.
set -u
os=$1 in=$2 out=$3
mkdir -p "$out"
fail=0
say() { echo "$*" | tee -a "$out/result.txt"; }
port=7788

case "$os" in
  macos)
    dmg=$(ls "$in"/Unbrowse-*-macos-arm64.dmg | head -1)
    say "artifact: $(basename "$dmg")"
    mnt=$(mktemp -d)
    # Open the disk image and drag the app onto Applications, as the image's window asks.
    if hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null &&
      test -L "$mnt/Applications" && ditto "$mnt/Unbrowse.app" /Applications/Unbrowse.app && hdiutil detach "$mnt" >/dev/null &&
      test -x /Applications/Unbrowse.app/Contents/MacOS/unbrowse-node && test -x /Applications/Unbrowse.app/Contents/MacOS/unb; then
      say INSTALL_OK
    else say "INSTALL_FAIL"; fail=1; fi
    open /Applications/Unbrowse.app
    reopen() { osascript -e 'quit app "Unbrowse"' || true; sleep 3; open /Applications/Unbrowse.app; }
    running() { pgrep -lf Unbrowse.app || true; }
    node=/Applications/Unbrowse.app/Contents/MacOS/unbrowse-node
    home=$HOME
    shot() { screencapture -x "$out/macos-$1.png"; }
    ;;
  windows)
    setup=$(ls "$in"/Unbrowse-*-windows-x64-setup.exe | head -1)
    say "artifact: $(basename "$setup")"
    # /S is the setup's own silent mode: the same sections as clicking through it, without its pages. Git Bash would
    # turn /S into a path (S:/), and the setup would open its pages and wait for a click that never comes.
    if MSYS2_ARG_CONV_EXCL='*' timeout 300 "$setup" /S && dir="$LOCALAPPDATA/Programs/Unbrowse" && test -f "$dir/unbrowse-window.exe" && test -f "$dir/unbrowse-node.exe" &&
      test -f "$dir/unb.exe" && test -f "$APPDATA/Microsoft/Windows/Start Menu/Programs/Unbrowse.lnk" &&
      reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Unbrowse' >/dev/null 2>&1; then
      say INSTALL_OK
    else say "INSTALL_FAIL"; ls -la "$LOCALAPPDATA/Programs/Unbrowse" 2>&1 | tee -a "$out/result.txt"; fail=1; fi
    # The Start menu entry, as a person clicks it.
    powershell -NoProfile -Command "Start-Process -FilePath \"\$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Unbrowse.lnk\""
    reopen() {
      taskkill //IM unbrowse-window.exe //F || true; sleep 3
      powershell -NoProfile -Command "Start-Process -FilePath \"\$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Unbrowse.lnk\""
    }
    # Why a window that didn't start didn't: a crash it left in the event log, or Defender holding the program.
    diagnose() {
      powershell -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue | Where-Object { \$_.ProviderName -match 'Application Error|Windows Error Reporting|SideBySide' } | Select-Object -First 6 | Format-List TimeCreated,ProviderName,Id,Message | Out-String -Width 300; Get-MpThreatDetection -ErrorAction SilentlyContinue | Format-List | Out-String -Width 300; Get-ChildItem \"\$env:LOCALAPPDATA\\Programs\\Unbrowse\" | Format-Table Name,Length -AutoSize | Out-String" >"$out/diagnose.txt" 2>&1 || true
    }
    running() { powershell -NoProfile -Command "Get-Process unbrowse-window,unbrowse-node -ErrorAction SilentlyContinue | Format-Table Id,ProcessName,SessionId,MainWindowTitle,MainWindowHandle -AutoSize | Out-String -Width 200"; }
    node="$LOCALAPPDATA/Programs/Unbrowse/unbrowse-node.exe"
    home=$USERPROFILE
    shot() {
      powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \$i=New-Object System.Drawing.Bitmap \$b.Width,\$b.Height; [System.Drawing.Graphics]::FromImage(\$i).CopyFromScreen(\$b.Location,[System.Drawing.Point]::Empty,\$b.Size); \$i.Save('$(cygpath -w "$out")\\windows-$1.png')" || true
    }
    ;;
  linux)
    deb=$(ls "$in"/unbrowse_*_amd64.deb | head -1)
    say "artifact: $(basename "$deb")"
    # A desktop's own parts a fresh Ubuntu desktop already has: a display, a session bus and an unlocked keyring.
    sudo apt-get update -qq >/dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb dbus-x11 gnome-keyring imagemagick xdotool >/dev/null 2>&1
    if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$deb" >"$out/apt.log" 2>&1 &&
      test -x /usr/bin/unbrowse-window && test -x /usr/bin/unbrowse-node && test -x /usr/bin/unb &&
      exec_line=$(sed -n 's/^Exec=//p' /usr/share/applications/unbrowse.desktop) && test -n "$exec_line"; then
      say INSTALL_OK
      dpkg -s unbrowse | grep -E '^(Version|Depends|Recommends):' | tee -a "$out/result.txt"
    else say "INSTALL_FAIL"; tail -20 "$out/apt.log"; fail=1; exec_line=/usr/bin/unbrowse-window; fi
    Xvfb :9 -screen 0 1400x900x24 >/dev/null 2>&1 &
    sleep 2
    session=$(mktemp)
    cat >"$session" <<EOF
#!/bin/sh
export DISPLAY=:9
mkdir -p ~/.local/share/keyrings
[ -f ~/.local/share/keyrings/default ] || echo login > ~/.local/share/keyrings/default
eval \$(printf pw | gnome-keyring-daemon --unlock --components=secrets --daemonize 2>/dev/null)
exec $exec_line
EOF
    chmod +x "$session"
    (cd ~ && nohup dbus-run-session "$session" >"$out/window.log" 2>&1 &)
    reopen() { pkill -x unbrowse-window || true; sleep 2; (cd ~ && nohup dbus-run-session "$session" >>"$out/window.log" 2>&1 &); }
    running() { pgrep -a unbrowse || true; }
    node=/usr/bin/unbrowse-node
    home=$HOME
    shot() { DISPLAY=:9 import -window root "$out/linux-$1.png" || true; }
    ;;
  *) echo "usage: $0 <macos|windows|linux> <installers> <out>"; exit 2 ;;
esac

# From here on nothing is started: the window alone must bring the node up.
up=""
for i in $(seq 1 90); do
  if curl -fs -m 3 "http://127.0.0.1:$port/v1/health" >"$out/health.json" 2>/dev/null && test -s "$home/.unbrowse/owner.token"; then up=$i; break; fi
  sleep 1
done
if [ -n "$up" ]; then say "NODE_UP_OK after ${up}s"; else say "NODE_UP_FAIL: nothing answered on $port within 90 s"; fail=1; running | tee -a "$out/result.txt"; type diagnose >/dev/null 2>&1 && diagnose; fi
head -c 1500 "$out/health.json" 2>/dev/null; echo
ls -la "$home/.unbrowse" 2>&1 | head -40 >"$out/unbrowse-home.txt"
cp "$home/.unbrowse/node.log" "$out/node.log" 2>/dev/null || true
sleep 8
shot first

mcp() { curl -s -m 20 -X POST "http://127.0.0.1:$port/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1"; }
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"device-test","version":"1"}}}' >"$out/mcp-initialize.json"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' >"$out/mcp-tools.json"
tools=$(grep -o '"name":"unbrowse_[a-z_]*"' "$out/mcp-tools.json" | sort -u | wc -l | tr -d ' ')
if grep -q '"serverInfo"' "$out/mcp-initialize.json" && grep -q '"unbrowse_do"' "$out/mcp-tools.json"; then
  say "LOCAL_MCP_OK: $tools tools at http://127.0.0.1:$port/mcp"
else say "LOCAL_MCP_FAIL"; head -c 400 "$out/mcp-initialize.json" "$out/mcp-tools.json"; fail=1; fi

# The screen after the terms, where a person connects their agents and the remote MCP address. A person presses "Open
# my node"; the test accepts the terms with the node's own command instead (no clicks on a runner), then looks.
# The window reads the terms when it opens, so it is opened again after.
running | tee "$out/running.txt"
"$node" terms accept >"$out/terms.txt" 2>&1 || true
reopen
sleep 10
running | tee -a "$out/running.txt"
shot after-terms
# A window that has gone: the same program again, its own output kept, to see how it ends.
if [ "$os" = windows ] && ! tasklist //FI "IMAGENAME eq unbrowse-window.exe" | grep -qi unbrowse-window; then
  say "WINDOW_GONE: the window exited by itself"
  diagnose
  ( cd "$LOCALAPPDATA/Programs/Unbrowse" && timeout 25 ./unbrowse-window.exe >"$out/window-direct.txt" 2>&1; echo "exit $?" >>"$out/window-direct.txt" )
  tail -5 "$out/window-direct.txt" | tee -a "$out/result.txt"
  fail=1
fi

[ "$fail" = 0 ] && say DEVICE_TEST_OK || say DEVICE_TEST_FAIL
exit "$fail"
