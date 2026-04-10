#!/usr/bin/env bash
# npm-dist-tag-sync.sh — ensure preview/latest npm dist-tags track the actual latest
#
# Silent failure observed: releases were bumping `latest` tag but `preview`
# dist-tag stayed frozen on an old version. Anyone running
# `npm install -g unbrowse@preview` would get a stale ancient binary.
#
# This primitive runs after every release and:
#   1. Lists current dist-tags
#   2. Finds the actual highest preview/stable version on npm
#   3. Updates the dist-tag if it's drifted
#   4. Prints before/after state so drift is never silent again
#
# Usage:
#   bash scripts/npm-dist-tag-sync.sh           # sync both preview and latest
#   bash scripts/npm-dist-tag-sync.sh --check   # check only, no updates
#
set -euo pipefail

CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
  esac
done

PKG="unbrowse"
echo "[dist-tag-sync] BEFORE:"
npm view "$PKG" dist-tags --json 2>&1 | python3 -m json.tool

# Fetch all versions
ALL_VERSIONS=$(npm view "$PKG" versions --json 2>/dev/null)

# Compute target preview (highest -preview.N) and latest (highest stable)
TARGETS=$(echo "$ALL_VERSIONS" | python3 -c "
import sys, json, re
versions = json.loads(sys.stdin.read())

def parse(v):
    # 3.7.0-preview.3 -> (3,7,0,'preview',3)
    m = re.match(r'^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$', v)
    if not m: return None
    major, minor, patch, pre, num = m.groups()
    return (int(major), int(minor), int(patch), pre or '', int(num) if num else 0, v)

parsed = [p for v in versions if (p := parse(v))]
stable = [p for p in parsed if not p[3]]
previews = [p for p in parsed if p[3] == 'preview']

latest_stable = max(stable)[5] if stable else ''
latest_preview = max(previews)[5] if previews else ''

print(f'{latest_stable}|{latest_preview}')
" 2>/dev/null)

LATEST_STABLE=$(echo "$TARGETS" | cut -d'|' -f1)
LATEST_PREVIEW=$(echo "$TARGETS" | cut -d'|' -f2)

echo "[dist-tag-sync] computed: latest=$LATEST_STABLE preview=$LATEST_PREVIEW"

# Current dist-tags
CURRENT_LATEST=$(npm view "$PKG" dist-tags.latest 2>/dev/null || echo "")
CURRENT_PREVIEW=$(npm view "$PKG" dist-tags.preview 2>/dev/null || echo "")

DRIFT=0
if [ -n "$LATEST_STABLE" ] && [ "$CURRENT_LATEST" != "$LATEST_STABLE" ]; then
  echo "[dist-tag-sync] DRIFT: latest is '$CURRENT_LATEST' should be '$LATEST_STABLE'"
  DRIFT=1
  if [ "$CHECK_ONLY" = "false" ]; then
    npm dist-tag add "${PKG}@${LATEST_STABLE}" latest
  fi
fi
if [ -n "$LATEST_PREVIEW" ] && [ "$CURRENT_PREVIEW" != "$LATEST_PREVIEW" ]; then
  echo "[dist-tag-sync] DRIFT: preview is '$CURRENT_PREVIEW' should be '$LATEST_PREVIEW'"
  DRIFT=1
  if [ "$CHECK_ONLY" = "false" ]; then
    npm dist-tag add "${PKG}@${LATEST_PREVIEW}" preview
  fi
fi

if [ "$DRIFT" -eq 0 ]; then
  echo "[dist-tag-sync] ✓ dist-tags already in sync"
else
  echo "[dist-tag-sync] AFTER:"
  npm view "$PKG" dist-tags --json 2>&1 | python3 -m json.tool
fi

if [ "$CHECK_ONLY" = "true" ] && [ "$DRIFT" -ne 0 ]; then
  echo "[dist-tag-sync] FAIL: drift detected in check mode"
  exit 1
fi
