#!/usr/bin/env bash
# Witness: the latest unbrowse version (package.json) is PUBLISHED on npm.
# Exit 0 iff published. Uses npm's EXIT CODE (E404 = non-zero) — never greps the
# output, because `npm view <pkg>@<missing>` echoes the requested version inside
# its 404 error (a false-green caught 2026-06-20).
set -uo pipefail
ROOT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
V=$(node -p "require('$ROOT/package.json').version" 2>/dev/null) || exit 1
[ -z "$V" ] && exit 1
echo "[witness] target unbrowse@$V" >&2
npm view "unbrowse@$V" version >/dev/null 2>&1 || { echo "[witness] NOT on npm yet" >&2; exit 1; }
echo "[witness] unbrowse@$V IS on npm" >&2
exit 0
