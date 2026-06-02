#!/usr/bin/env bash
# skill-mcp-publish-gate.sh — runnable check that unbrowse ships as an
# agentskills.io skill and as an MCP server wired to the right registries.
#
# Exits 0 ONLY when every check below passes:
#   A. The agentskills.io skill (packages/skill/SKILL.md) is named `unbrowse`,
#      has a description, and ships in the npm package files[] list.
#   B. The MCP manifest (smithery.yaml) version tracks the published package
#      version and carries an install command + tool groups.
#   C. server.json (official MCP registry target) is valid, points at the npm
#      package `unbrowse`, tracks the package version, and the package carries the
#      matching `mcpName` for the registry's npm-ownership check.
#   D. All four publish targets are wired: Smithery, Glama, MCP registry, npm.
#
# Self-contained: no external dependencies, no host-specific paths.
# Usage: bash scripts/skill-mcp-publish-gate.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

SKILL="packages/skill/SKILL.md"
PKG="packages/skill/package.json"
SMITHERY="smithery.yaml"
GLAMA="glama.json"
SERVER_JSON="server.json"

fail=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

PKG_VERSION="$(node -p "require('./$PKG').version" 2>/dev/null || echo "")"

# --- A. agentskills.io skill, named unbrowse, shipped -----------------------
if [ ! -f "$SKILL" ]; then
  bad "A: skill manifest missing: $SKILL"
else
  if grep -qE '^name:[[:space:]]*unbrowse[[:space:]]*$' "$SKILL" && grep -qE '^description:' "$SKILL"; then
    pass "A1: $SKILL is a valid agentskills.io skill named 'unbrowse'"
  else
    bad "A1: $SKILL must declare name: unbrowse and a description"
  fi
  if node -e "const f=require('./$PKG').files||[]; process.exit(f.includes('SKILL.md')?0:1)" 2>/dev/null; then
    pass "A2: SKILL.md ships in the npm package files[]"
  else
    bad "A2: packages/skill/package.json files[] does not ship SKILL.md"
  fi
fi

# --- B. smithery.yaml version tracks package + has install/tools ------------
if [ ! -f "$SMITHERY" ]; then
  bad "B: $SMITHERY missing"
else
  SM_VERSION="$(grep -E '^version:' "$SMITHERY" | head -1 | sed -E 's/version:[[:space:]]*"?([^"]+)"?.*/\1/')"
  if [ -n "$PKG_VERSION" ] && [ "$SM_VERSION" = "$PKG_VERSION" ]; then
    pass "B1: smithery.yaml version ($SM_VERSION) tracks package ($PKG_VERSION)"
  else
    bad "B1: smithery.yaml version ($SM_VERSION) != package version ($PKG_VERSION)"
  fi
  grep -qE '^install:' "$SMITHERY" && grep -q 'mcp' "$SMITHERY" \
    && pass "B2: smithery.yaml has install command" \
    || bad "B2: smithery.yaml missing install command"
  grep -qE '^tool_groups:' "$SMITHERY" \
    && pass "B3: smithery.yaml declares tool_groups" \
    || bad "B3: smithery.yaml missing tool_groups"
fi

# --- C. server.json for official MCP registry + ownership -------------------
if [ ! -f "$SERVER_JSON" ]; then
  bad "C: $SERVER_JSON missing (official MCP registry publish target)"
elif ! node -e "JSON.parse(require('fs').readFileSync('./$SERVER_JSON','utf8'))" 2>/dev/null; then
  bad "C: $SERVER_JSON is not valid JSON"
else
  D_OK=$(node -e '
    const s=require("./'"$SERVER_JSON"'");
    const pkgs=s.packages||[];
    const npmPkg=pkgs.find(p=>(p.registryType==="npm"||p.registry_name==="npm")&&(p.identifier==="unbrowse"||p.name==="unbrowse"));
    const ok = !!s.name && !!s.description && !!npmPkg && !!s.version;
    process.stdout.write(ok?("ok:"+s.version):"bad");
  ' 2>/dev/null)
  if [[ "$D_OK" == ok:* ]]; then
    SJ_VER="${D_OK#ok:}"
    if [ "$SJ_VER" = "$PKG_VERSION" ]; then
      pass "C1: server.json valid, npm package 'unbrowse', version tracks package ($SJ_VER)"
    else
      bad "C1: server.json version ($SJ_VER) != package version ($PKG_VERSION)"
    fi
    SRV_NAME="$(node -p "require('./$SERVER_JSON').name" 2>/dev/null)"
    PKG_MCPNAME="$(node -p "require('./$PKG').mcpName||''" 2>/dev/null)"
    if [ -n "$PKG_MCPNAME" ] && [ "$PKG_MCPNAME" = "$SRV_NAME" ]; then
      pass "C2: package.json mcpName ($PKG_MCPNAME) matches server.json name (registry ownership)"
    else
      bad "C2: package.json mcpName ('$PKG_MCPNAME') must equal server.json name ('$SRV_NAME')"
    fi
  else
    bad "C: server.json missing name/description/npm-package/version"
  fi
fi

# --- D. all four publish targets wired --------------------------------------
[ -f "$SMITHERY" ]    && pass "D-smithery: smithery.yaml present"    || bad "D-smithery: missing"
[ -f "$GLAMA" ]       && pass "D-glama: glama.json present"          || bad "D-glama: missing"
[ -f "$SERVER_JSON" ] && pass "D-mcp-registry: server.json present"  || bad "D-mcp-registry: missing"
grep -qE '"publish:cli"' package.json \
  && pass "D-npm: publish:cli script present" \
  || bad "D-npm: publish:cli script missing"

echo
if [ "$fail" -eq 0 ]; then
  echo "GREEN — unbrowse ships as an agentskills.io skill + MCP, wired to Smithery, Glama, the MCP registry, and npm."
  exit 0
else
  echo "RED — publish surface not yet settled."
  exit 1
fi
