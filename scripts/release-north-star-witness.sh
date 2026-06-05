#!/usr/bin/env bash
#
# release-north-star-witness.sh — exits 0 EXACTLY when the north star is achieved:
#   "git push all, cut release v8.2.0 to prod"
#
# Five independent gates, all must pass:
#   1. working tree clean (everything committed)
#   2. local version == TARGET (8.2.0)
#   3. HEAD pushed to origin AND github-ssh
#   4. tag vTARGET present on origin AND github-ssh
#   5. npm `unbrowse@TARGET` live  ← the prod proof (what agents install)
#
# No self-asserted string. The registry + remotes decide.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="${RELEASE_TARGET:-8.2.0}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TAG="v${TARGET}"
fail() { echo "[witness] ✗ $*"; exit 1; }
ok()   { echo "[witness] ✓ $*"; }

# Gate 1: clean tree
[ -z "$(git status --porcelain)" ] || fail "working tree dirty ($(git status --porcelain | wc -l | tr -d ' ') files)"
ok "working tree clean"

# Gate 2: local version
LOCAL_V="$(node -p "require('./package.json').version")"
[ "$LOCAL_V" = "$TARGET" ] || fail "local version $LOCAL_V != $TARGET"
ok "local version $LOCAL_V"

# Gate 3: HEAD pushed to both remotes
HEAD_SHA="$(git rev-parse HEAD)"
for R in origin github-ssh; do
  git fetch -q "$R" "$BRANCH" 2>/dev/null || true
  git merge-base --is-ancestor "$HEAD_SHA" "$R/$BRANCH" 2>/dev/null \
    || fail "HEAD not pushed to $R/$BRANCH"
  ok "HEAD on $R/$BRANCH"
done

# Gate 4: tag on both remotes
for R in origin github-ssh; do
  git ls-remote --tags "$R" "$TAG" 2>/dev/null | grep -q "$TAG" \
    || fail "tag $TAG not on $R"
  ok "tag $TAG on $R"
done

# Gate 5: npm prod artifact live
NPM_V="$(npm view unbrowse version 2>/dev/null)"
[ "$NPM_V" = "$TARGET" ] || fail "npm unbrowse@$TARGET not live (registry: ${NPM_V:-none})"
ok "npm unbrowse@$NPM_V live"

echo "[witness] ALL GATES PASS — $TAG cut to prod"
exit 0
