#!/usr/bin/env bash
# reset-unbrowse-cache.sh — purge local caches so the next resolve does a
# fresh capture and doesn't hit stale/poisoned marketplace or route cache
# entries.
#
# Background: the publish admission gate was fixed mid-session to reject
# dom-fallback-only skills, but the marketplace already contains stale
# entries from runs that happened BEFORE the fix. When resolve hits them
# it gets a cache_hit=true with a synthetic page-artifact endpoint and
# skips capture entirely — the fresh extraction never runs. Local caches
# accumulate the same stale skills.
#
# This primitive wipes the local caches so the agent can force a clean
# measurement. It does NOT touch the remote marketplace — that needs a
# separate backend purge.
#
# Usage:
#   bash scripts/reset-unbrowse-cache.sh           # prompt before wiping
#   bash scripts/reset-unbrowse-cache.sh --force   # wipe without prompt
#   bash scripts/reset-unbrowse-cache.sh --domain example.com  # just one domain
set -euo pipefail

FORCE=0
DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --domain) shift; DOMAIN="${1:-}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

CFG_DIR="${UNBROWSE_CONFIG_DIR:-$HOME/.unbrowse}"
ROUTE_CACHE="$CFG_DIR/route-cache.json"
DOMAIN_CACHE="$CFG_DIR/domain-skill-cache.json"
SKILL_DIR="$CFG_DIR/skill-cache"

if [ -n "$DOMAIN" ]; then
  echo "[reset-cache] selective reset for domain=$DOMAIN"
  python3 - "$DOMAIN" "$ROUTE_CACHE" "$DOMAIN_CACHE" "$SKILL_DIR" <<'PY'
import json
import os
import sys
domain = sys.argv[1]
route_cache = sys.argv[2]
domain_cache = sys.argv[3]
skill_dir = sys.argv[4]

def purge_json_entries(path, predicate):
    if not os.path.exists(path):
        return 0
    try:
        data = json.load(open(path))
    except Exception as e:
        print(f"  skip {path}: {e}")
        return 0
    removed = 0
    if isinstance(data, dict):
        for key in list(data.keys()):
            entry = data[key]
            if predicate(key, entry):
                del data[key]
                removed += 1
    elif isinstance(data, list):
        before = len(data)
        data = [x for x in data if not predicate(None, x)]
        removed = before - len(data)
    if removed:
        json.dump(data, open(path, "w"), indent=2)
    return removed

def match_domain(key, entry):
    # Keys look like "https://example.com/..." or domain names directly.
    key_s = str(key) if key is not None else ""
    if domain in key_s:
        return True
    if isinstance(entry, dict):
        for v in entry.values():
            if isinstance(v, str) and domain in v:
                return True
    return False

r1 = purge_json_entries(route_cache, match_domain)
print(f"  route-cache: removed {r1} entries")
r2 = purge_json_entries(domain_cache, match_domain)
print(f"  domain-cache: removed {r2} entries")
if os.path.isdir(skill_dir):
    removed = 0
    for fn in os.listdir(skill_dir):
        path = os.path.join(skill_dir, fn)
        try:
            content = open(path).read()
            if domain in content:
                os.remove(path)
                removed += 1
        except Exception:
            pass
    print(f"  skill-cache: removed {removed} files")
PY
  exit 0
fi

echo "[reset-cache] this will DELETE:"
echo "  $ROUTE_CACHE ($(wc -c < "$ROUTE_CACHE" 2>/dev/null || echo 0) bytes)"
echo "  $DOMAIN_CACHE ($(wc -c < "$DOMAIN_CACHE" 2>/dev/null || echo 0) bytes)"
echo "  $SKILL_DIR ($(find "$SKILL_DIR" -type f 2>/dev/null | wc -l | tr -d ' ') files)"

if [ "$FORCE" -ne 1 ]; then
  read -r -p "proceed? [y/N] " reply
  case "$reply" in
    y|Y|yes) : ;;
    *) echo "[reset-cache] cancelled"; exit 0 ;;
  esac
fi

rm -f "$ROUTE_CACHE" "$DOMAIN_CACHE"
if [ -d "$SKILL_DIR" ]; then
  rm -rf "$SKILL_DIR"
fi
echo "[reset-cache] done — next resolve will do a fresh capture"
