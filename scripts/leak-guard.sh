#!/usr/bin/env bash
# cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the seal plane inherits the cross — pointer not payload; verify via .claude/superpattern/cross-stamp-gate.sh)
# leak-guard.sh — prevent harness/primitive techniques from leaking to public
#
# The Ralph loop primitives (coverage-harness, dogfood-loop,
# agent-experience-test, primitive-registry, etc.) are operational
# secret sauce. They must NOT appear in:
#   - npm tarball (packages/skill/ publish)
#   - GitHub release tarballs uploaded to unbrowse-ai/unbrowse
#   - any file committed to an explicitly public path
#
# This primitive checks every output path that can go public and
# flags if any sensitive name appears. Run before release and before
# push to main (as a pre-push hook).
#
# Usage:
#   bash scripts/leak-guard.sh              # check, exit non-zero on leak
#   bash scripts/leak-guard.sh --strict     # also fail on near-matches
#
set -uo pipefail

STRICT=false
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=true ;;
  esac
done

# Scan root — defaults to the repo root (one up from scripts/). Overridable via
# LEAK_GUARD_ROOT so a fails-closed mutation test can point it at a temp dir
# without touching the live tree. Default behavior is identical when unset.
ROOT_DIR="${LEAK_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT_DIR"

# Sensitive names that must never appear in public artifacts
SENSITIVE_NAMES=(
  "coverage-harness"
  "dogfood-loop"
  "agent-experience-test"
  "drop-in-onboarding-test"
  "primitive-registry"
  "release-with-visibility"
  "npm-dist-tag-sync"
  "npm-install-integrity"
  "leak-guard"
)

# v6.16 alpha — economic primitives, anti-Sybil mechanics, back-doors,
# operator surfaces. These must NEVER appear in docs/, README.md, or the
# npm tarball. Internal-only via gitignored internal/.
SENSITIVE_KEYWORDS_V6_16=(
  "DELTA_DECAY_RATE"
  "MIN_DELTA_THRESHOLD"
  "BASE_FEE_UC"
  "DELTA_BONUS_UC"
  "fee_allocated_uc = BASE_FEE_UC"
  "__admin__"
  "API_KEY=local-test"
  "API_KEY=\"local-test\""
  "FLEX_SPONSOR_ESCROW_ADDRESS"
  "FLEX_SPONSOR_SESSION_KEY_SECRET"
  "FLEX_SPONSOR_SESSION_KEY_EXPIRES_AT_SLOT"
  "SPONSOR_USE_FLEX_SPLIT"
  "FLEX_PLATFORM_FACILITATOR_KEY"
  "sponsorWalletReady"
  "sendSponsorFlexPayment"
)

# Sensitive principle keywords from CLAUDE.md that shouldn't appear
# in public docs (strict mode only)
SENSITIVE_KEYWORDS=(
  "Harness Collects, Agent Judges"
  "Self-Prompting Harness"
  "No Specialized Testing"
  "Agent-as-Judge"
  "No Silent Failures"
)

# Covenant MECHANISM keywords — the moat (W34, Genesis 1:9: the dry land
# is the 37 internet ops; the deep is the mechanism). These reveal HOW
# unbrowse scores / decides / populates / learns and must NEVER appear in
# the PUBLIC source surface (src/, packages/, backend public routes) or the
# built bundle. The internet op_kinds (breath:navigate, eval:snap, build:skill)
# are NOT here — they ARE the product surface and are allowed.
# Source of truth: .planning/v7-rip/INTERNET_LAYER_COVENANT_SURFACE.md §5.
SENSITIVE_KEYWORDS_COVENANT=(
  "revealed_context"
  "diffusion_populate"
  "ebm_route"
  "ebm_train"
  "ebm_loop"
  "energy_score"
  "canon_witness"
  "rules_for_identity"
  "establishment_query"
  "recall_episode"
  "COVENANT_SUBSTRATE_MAP"
)

# Unreleased privacy/authorization IP — must not appear in any public artifact
# until the whitepaper ships. The shipped `commitment_only` / proof-verifier
# feature (SHA-256 tamper-evidence) is a DIFFERENT, public thing and is NOT
# listed here, so it is unaffected. These terms are specific on purpose (no bare
# "zk") to avoid false positives on unrelated identifiers.
SENSITIVE_KEYWORDS_ZK=(
  "zero-knowledge"
  "zero knowledge"
  "zk-proof"
  "zk proof"
  "zkhash"
  "zk-hash"
  "nullifier"
  "zk-proofs.md"
)

# Source-surface paths the mechanism scan covers. .planning/ is gitignored
# (the mechanism maps live there by design) so it is NOT scanned. Tests
# carry assert-absence strings deliberately and are excluded inline below.
COVENANT_SOURCE_PATHS=(
  "src"
  "packages/skill/src"
  "packages/sdk/src"
  "backend/src"
)

# Public paths — any file under these is reachable by the outside world
PUBLIC_PATHS=(
  "packages/skill/SKILL.md"
  "packages/skill/README.md"
  "packages/skill/package.json"
  "README.md"
  "docs/"
)

LEAK_COUNT=0
LEAK_DETAILS=()

check_path() {
  local path="$1"
  if [ ! -e "$path" ]; then return; fi

  for name in "${SENSITIVE_NAMES[@]}"; do
    # internal/ is the gitignored internal tier — NOT a public path. Exclude it,
    # consistent with the v6.16 alpha scan below (--exclude-dir=internal). A
    # sensitive name inside docs/internal/ is by-design internal, not a leak.
    local matches
    matches=$(grep -rIl --exclude-dir=internal "$name" "$path" 2>/dev/null | head -5 || true)
    if [ -n "$matches" ]; then
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        echo "  ✗ LEAK in public path: '$name' in $f" >&2
        LEAK_COUNT=$((LEAK_COUNT + 1))
      done <<< "$matches"
    fi
  done
}

echo "[leak-guard] scanning public-reachable paths..."

# 1. Check each declared public path
for path in "${PUBLIC_PATHS[@]}"; do
  check_path "$path"
done

# 2. Check what would be in the npm tarball
echo ""
echo "[leak-guard] scanning simulated npm tarball..."
TAR_FILES=$(cd packages/skill && npm pack --dry-run 2>&1 | grep "npm notice" | awk '{print $NF}' | grep -v "notice")
for f in $TAR_FILES; do
  # Files relative to packages/skill — skip scripts/ which are allowlisted
  real_path="packages/skill/$f"
  if [ -f "$real_path" ]; then
    for name in "${SENSITIVE_NAMES[@]}"; do
      if grep -q "$name" "$real_path" 2>/dev/null; then
        echo "  ✗ LEAK in npm tarball: '$name' in $f" >&2
        LEAK_COUNT=$((LEAK_COUNT + 1))
      fi
    done
  fi
done

# 2b. v6.16 alpha keyword scan — ALWAYS enforced (not strict-only).
# Economic primitives, anti-Sybil mechanics, back-doors, operator surfaces.
echo ""
echo "[leak-guard] scanning v6.16 alpha keywords in public paths..."
for path in "${PUBLIC_PATHS[@]}"; do
  if [ -e "$path" ]; then
    for kw in "${SENSITIVE_KEYWORDS_V6_16[@]}"; do
      matches=$(grep -rIl --exclude-dir=internal "$kw" "$path" 2>/dev/null | head -3 || true)
      if [ -n "$matches" ]; then
        while IFS= read -r f; do
          [ -z "$f" ] && continue
          echo "  ✗ ALPHA LEAK: '$kw' in $f (move to internal/ or strip)" >&2
          LEAK_COUNT=$((LEAK_COUNT + 1))
        done <<< "$matches"
      fi
    done
  fi
done

# 2c. Unreleased ZK / privacy-IP keyword scan — ALWAYS enforced. The
# zero-knowledge authorization approach is unreleased IP; it must not appear in
# any public artifact until the whitepaper ships. (The shipped commitment_only
# proof feature is public and not on this list, so it is unaffected.)
echo ""
echo "[leak-guard] scanning unreleased ZK/privacy-IP keywords in public paths..."
for path in "${PUBLIC_PATHS[@]}"; do
  if [ -e "$path" ]; then
    for kw in "${SENSITIVE_KEYWORDS_ZK[@]}"; do
      matches=$(grep -rIli --exclude-dir=internal "$kw" "$path" 2>/dev/null | head -3 || true)
      if [ -n "$matches" ]; then
        while IFS= read -r f; do
          [ -z "$f" ] && continue
          echo "  ✗ ZK-IP LEAK: '$kw' in $f (unreleased — strip until whitepaper)" >&2
          LEAK_COUNT=$((LEAK_COUNT + 1))
        done <<< "$matches"
      fi
    done
  fi
done
# 3. Strict mode: also check for principle keywords in public docs
if [ "$STRICT" = "true" ]; then
  echo ""
  echo "[leak-guard] strict mode — checking principle keywords..."
  for path in "${PUBLIC_PATHS[@]}"; do
    if [ -e "$path" ]; then
      for kw in "${SENSITIVE_KEYWORDS[@]}"; do
        matches=$(grep -rIl "$kw" "$path" 2>/dev/null | head -3 || true)
        if [ -n "$matches" ]; then
          while IFS= read -r f; do
            [ -z "$f" ] && continue
            echo "  ⚠ STRICT LEAK: '$kw' in $f" >&2
            LEAK_COUNT=$((LEAK_COUNT + 1))
          done <<< "$matches"
        fi
      done
    fi
  done
fi

# 3c. Covenant MECHANISM keyword scan — ALWAYS enforced (W34, Genesis 1:9).
# Fail if any mechanism keyword appears in the PUBLIC source surface or the
# built bundle as FUNCTIONAL code that ships. The teeth are the BUNDLE scan:
# the shipped npm CLI bundle (packages/skill/dist) must yield zero mechanism
# tokens under `strings`. The source scan is a pre-build early-warning.
#
# Exclusions (only REAL leaks fail the gate — Genesis 1:9, the named dry land
# vs the masked deep):
#   - .planning/                 gitignored by design (the deep — the maps)
#   - *.test.ts                  assert-absence tests carry the strings on purpose
#   - /fixtures/, dist source    captured site data / generated
#   - pure-comment lines         comments are stripped by minification; they do
#                                NOT ship in the bundle (the boundary-doc comments
#                                in dispatch/index.ts explain WHY the mechanism is
#                                excluded — that explanation is itself the control)
#   - "NOT <mechanism>" etc.     absence-assertion comments
#   - lines tagged leak-guard:allow   intentional enforcement (deny-lists) on the
#                                PRIVATE backend Worker — these are the boundary
#                                CONTROL (the gate that rejects the mechanism),
#                                not a leak; auditable by the marker.
echo ""
echo "[leak-guard] scanning covenant mechanism keywords in source surface..."
COVENANT_LEAK_COUNT=0
# A "comment line" = trimmed line starting with // or * or # (the bundle drops these).
COMMENT_RE='^[[:space:]]*(//|\*|#|/\*)'
for kw in "${SENSITIVE_KEYWORDS_COVENANT[@]}"; do
  for path in "${COVENANT_SOURCE_PATHS[@]}"; do
    [ -e "$path" ] || continue
    while IFS= read -r row; do
      [ -z "$row" ] && continue
      # row is "file:lineno:content" — strip file:lineno to test the content.
      content="${row#*:}"; content="${content#*:}"
      # Skip pure-comment lines (stripped from the shipped bundle).
      if printf '%s' "$content" | grep -qE "$COMMENT_RE"; then continue; fi
      COVENANT_LEAK_COUNT=$((COVENANT_LEAK_COUNT + 1))
      LEAK_COUNT=$((LEAK_COUNT + 1))
      echo "  ✗ MECHANISM LEAK: '$kw' at $row" >&2
    done < <(
      grep -rIn "$kw" "$path" \
        --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" \
        --exclude="*.test.ts" --exclude="*.test.tsx" \
        --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=fixtures \
        2>/dev/null \
        | grep -viE "NOT[[:space:]]+${kw}|never[[:space:]]+${kw}|no[[:space:]]+${kw}|absence|MUST[[:space:]]+NOT|assert.*absent" \
        | grep -v "leak-guard:allow" \
        || true
    )
  done
  # Built bundle (the TEETH) — strings(bundle) must yield zero mechanism tokens.
  for bundle in "packages/skill/dist" "dist"; do
    [ -d "$bundle" ] || continue
    matches=$(grep -rIl "$kw" "$bundle" --exclude-dir=node_modules 2>/dev/null | head -3 || true)
    if [ -n "$matches" ]; then
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        echo "  ✗ MECHANISM LEAK IN BUNDLE: '$kw' in $f" >&2
        COVENANT_LEAK_COUNT=$((COVENANT_LEAK_COUNT + 1))
        LEAK_COUNT=$((LEAK_COUNT + 1))
      done <<< "$matches"
    fi
  done
done
if [ "$COVENANT_LEAK_COUNT" -eq 0 ]; then
  echo "[leak-guard] ✓ no covenant mechanism keywords in source surface"
fi

# 4. Check the skill repo mirror if present
SKILL_REPO="${UNBROWSE_SKILL_REPO:-$HOME/Projects/unbrowse-skill}"
if [ -d "$SKILL_REPO/.git" ]; then
  echo ""
  echo "[leak-guard] scanning skill repo mirror: $SKILL_REPO"
  for name in "${SENSITIVE_NAMES[@]}"; do
    matches=$(grep -rIl "$name" "$SKILL_REPO" --exclude-dir=.git 2>/dev/null | head -3 || true)
    if [ -n "$matches" ]; then
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        echo "  ✗ LEAK in skill repo: '$name' in $f" >&2
        LEAK_COUNT=$((LEAK_COUNT + 1))
      done <<< "$matches"
    fi
  done
fi

echo ""
if [ "$LEAK_COUNT" -eq 0 ]; then
  echo "[leak-guard] ✓ no sensitive names in public paths"
  exit 0
else
  echo "[leak-guard] ✗ FAIL: $LEAK_COUNT potential leak(s) found"
  echo "[leak-guard] sensitive primitives must NOT appear in:"
  echo "[leak-guard]   - packages/skill/SKILL.md, README.md, package.json"
  echo "[leak-guard]   - docs/"
  echo "[leak-guard]   - npm tarball"
  echo "[leak-guard]   - unbrowse-skill repo mirror"
  exit 1
fi
