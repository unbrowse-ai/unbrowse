#!/bin/sh
# End to end, on a real macOS or Linux machine with passwordless sudo (CI): `agent-user install` makes the agents' OS
# user, that user can read none of the owner's secrets, `run` runs a program as it with its own token, and `remove`
# undoes it all. usage: scripts/agent-user-e2e.sh <path to unbrowse-node>
set -eu
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
export UNBROWSE_HOME="$HOME/.unbrowse-agent-user-e2e"
rm -rf "$UNBROWSE_HOME"
mkdir -p "$UNBROWSE_HOME"
# An older install's folder, open to everyone, with a secret in it.
chmod 755 "$UNBROWSE_HOME"
printf 'owner-secret' > "$UNBROWSE_HOME/owner.token"
chmod 644 "$UNBROWSE_HOME/owner.token"
fail() { echo "FAIL: $*" >&2; "$bin" agent-user remove --yes >/dev/null 2>&1 || true; exit 1; }

"$bin" agent-user install --yes || fail "install"
[ "$(stat -c %a "$UNBROWSE_HOME" 2>/dev/null || stat -f %Lp "$UNBROWSE_HOME")" = 700 ] || fail "the node's folder isn't 0700"
id unbrowse-agent || fail "no user"
# No login shell (external security review round 3, 2026-11-04).
shell=$(getent passwd unbrowse-agent 2>/dev/null | cut -d: -f7)
[ -n "$shell" ] || shell=$(dscl . -read /Users/unbrowse-agent UserShell 2>/dev/null | awk '{print $2}')
case "$shell" in */nologin | */false) ;; *) fail "the agent user has a login shell: $shell" ;; esac
# What it runs gets sudo's own terminal, never the owner's.
sudo grep -qx 'Defaults>unbrowse-agent use_pty' /etc/sudoers.d/unbrowse-agent || fail "the sudoers rule doesn't give the agent a terminal of its own"
# No admin and no shared group.
groups unbrowse-agent | grep -Eqw 'sudo|wheel|admin|staff' && fail "the agent user is in an admin or shared group: $(groups unbrowse-agent)"
"$bin" agent-user status || fail "status found something of the owner's the agent user can read"
if sudo -n -u unbrowse-agent cat "$UNBROWSE_HOME/owner.token" 2>/dev/null; then fail "the agent user read owner.token"; fi
if sudo -n -u unbrowse-agent ls "$UNBROWSE_HOME" 2>/dev/null; then fail "the agent user listed the node's folder"; fi
"$bin" agent-user run -- sh -c 'test "$(id -un)" = unbrowse-agent && test -n "$UNBROWSE_AGENT_TOKEN" && test "$UNBROWSE_NODE" = http://127.0.0.1:7788' || fail "run didn't run as the agent user with its settings"
# The token the agent user got is its own, never the owner's.
got=$("$bin" agent-user run -- sh -c 'printf %s "$UNBROWSE_AGENT_TOKEN"')
[ "$got" != owner-secret ] || fail "the agent got the owner's token"
# Installing again refreshes the settings and keeps the user.
"$bin" agent-user install --yes || fail "install again"
"$bin" agent-user remove --yes || fail "remove"
if id unbrowse-agent 2>/dev/null; then fail "the user is still there"; fi
[ ! -e /etc/sudoers.d/unbrowse-agent ] || fail "the sudoers rule is still there"
rm -rf "$UNBROWSE_HOME"
echo "AGENT_USER_E2E_PASSED"
