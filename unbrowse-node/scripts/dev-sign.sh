#!/bin/sh
# Cargo's runner on macOS: sign the node's binaries with the stable "Unbrowse Node Dev" identity, then run.
#
# The Keychain remembers which app may read the node's root key by the app's code signature. An unsigned debug build
# gets a fresh ad-hoc signature on every rebuild, so macOS asks again after each one and the node waits on the dialog.
# Signed with one identity, every rebuild is the same app to the Keychain and "Always Allow" sticks.
#
# The identity sits in its own keychain (scripts/dev-identity.sh makes it), unlocked here with the password that
# script keeps, so signing never asks for yours. Signing never holds up a run: without the identity, or if signing
# hasn't finished in five seconds, the binary runs as it was built.
bin="$1"
case "$(basename "$bin")" in
  unbrowse-node|unb) ;;
  *) exec "$@" ;;
esac
kc="$HOME/Library/Keychains/unbrowse-dev.keychain-db"
passfile="$HOME/.unbrowse/dev-keychain.pass"
if [ -f "$kc" ] && [ -f "$passfile" ]; then
  security unlock-keychain -p "$(cat "$passfile")" "$kc" 2>/dev/null
  id=$(security find-identity -p codesigning "$kc" 2>/dev/null | awk '/"Unbrowse Node Dev"/ { print $2; exit }')
fi
if [ -n "$id" ]; then
  codesign -f -s "$id" --keychain "$kc" "$bin" 2>/dev/null &
  pid=$!
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    echo "dev-sign: signing is waiting on macOS; running unsigned, so the Keychain may ask again" >&2
  fi
else
  echo "dev-sign: no dev identity (run scripts/dev-identity.sh); running unsigned" >&2
fi
exec "$@"
