#!/usr/bin/env bash
#
# scripts/check-contract-leak.sh — block /contract substrate vocabulary
# from leaking into public surfaces.
#
# The /contract substrate (organs, cells, funnels, KEY 1/2/3, proof-binding,
# self-organism, the ~/.contracts/contracts.jsonl ledger, 8-hex contract IDs)
# is internal. Public-facing surfaces describe outcomes in normie language,
# not the substrate that produced them.
#
# Public surfaces (scanned):
#   - README.md
#   - CHANGELOG.md
#   - frontend/src/**
#   - docs/**  EXCEPT docs/internal/**
#   - the in-flight commit message (via $COMMIT_MSG_FILE if set)
#
# Internal/local surfaces (NOT scanned):
#   - docs/internal/** (gitignored via internal/ at .gitignore:38)
#   - .claude/, .scratch/, .triage*, ~/.contracts/
#   - backend/src/services/sponsor-pool.ts + crypto-sub.ts (these legitimately
#     reference internal organ IDs in their docstrings — server-side internal
#     code that ships to the deployed Worker but not to the public website)
#
# Exit codes:
#   0 — clean (no leaks)
#   1 — leak detected (commit blocked)
#
# Originating audit: docs/internal/contract-leak-audit.md
# Hide-contract-substrate organ: 955a32b0 (stage C: 3c0c80d3)

set -euo pipefail

cd "$(dirname "$0")/.."

# Patterns that uniquely identify the /contract substrate. Generic English
# words like "contract" (legal sense) or "funnel" (marketing-funnel sense)
# do NOT trip these — only substrate-vocabulary forms do.
PATTERNS=(
  'contract [0-9a-f]{8}\b'
  'organ [0-9a-f]{8}\b'
  '\bcontract organ\b'
  'contract:[0-9a-f]{8}\b'
  '\bKEY [123]\b'
  '\btwo-key exit\b'
  '\bthree-key exit\b'
  '\bself-organism\b'
  '\bproof-binding\b'
  '\.contracts/contracts\.jsonl'
  'harness collects.{0,5}agent judges'
)

# Public surface globs (scanned).
PUBLIC_GLOBS=(
  'README.md'
  'CHANGELOG.md'
  'frontend/src'
  'docs'
)

# Exclusion globs (any leak in these paths is FINE — they're internal).
EXCLUDE_REGEX='(^|/)(docs/internal|\.claude|\.scratch|\.triage|node_modules|backend/src/services/(sponsor-pool|crypto-sub)\.ts)(/|$)'

declare -a LEAKS=()

scan_one() {
  local path="$1"
  for pat in "${PATTERNS[@]}"; do
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      # Skip exclusions
      if [[ "$hit" =~ $EXCLUDE_REGEX ]]; then continue; fi
      LEAKS+=("$hit  /  $pat")
    done < <(grep -REn "$pat" "$path" \
                --include='*.md' --include='*.tsx' --include='*.ts' \
                --include='*.json' --include='*.html' \
                2>/dev/null | grep -vE "$EXCLUDE_REGEX" || true)
  done
}

# Scan tracked files in each public glob.
for g in "${PUBLIC_GLOBS[@]}"; do
  if [ -e "$g" ]; then
    scan_one "$g"
  fi
done

# Scan the commit message of the in-flight commit ONLY when the
# commit-msg hook explicitly sets COMMIT_MSG_FILE. Don't fall back to
# .git/COMMIT_EDITMSG (which holds the LAST commit's message — past
# commits already shipped; the guard catches NEW commits at write time).
COMMIT_MSG_FILE="${COMMIT_MSG_FILE:-}"
if [ -n "$COMMIT_MSG_FILE" ] && [ -f "$COMMIT_MSG_FILE" ]; then
  for pat in "${PATTERNS[@]}"; do
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      LEAKS+=("$COMMIT_MSG_FILE:0:  $hit  /  $pat")
    done < <(grep -En "$pat" "$COMMIT_MSG_FILE" 2>/dev/null || true)
  done
fi

if [ "${#LEAKS[@]}" -eq 0 ]; then
  echo "[contract-leak] clean — no substrate vocabulary in public surfaces"
  exit 0
fi

echo "[contract-leak] LEAK DETECTED — substrate vocabulary in public surface:" >&2
for line in "${LEAKS[@]}"; do
  echo "  $line" >&2
done
echo >&2
echo "Fix: move the file to docs/internal/, scrub the substrate vocabulary," >&2
echo "  or run with CONTRACT_LEAK_ALLOW=1 to bypass (rare; documented in" >&2
echo "  the commit message). See docs/internal/contract-leak-audit.md for" >&2
echo "  the policy + the patterns enforced." >&2
exit 1
