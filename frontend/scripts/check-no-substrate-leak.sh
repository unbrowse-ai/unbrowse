#!/usr/bin/env bash
# Standing gate: user-facing surfaces never name the internal reasoning layer.
# Exits 0 only when zero forbidden mentions appear in any user-visible file.
#
# Scope: anything a user can see — page.tsx files, the playground chat widget,
# the public worker landing HTML, and the agent-readable .txt files served at the
# root. Internal-only code (backend handlers, system prompts the model reads,
# scrub-regex helpers, this script's own deny list) is exempt.
#
# Add this to precommit + the deploy gate so a regression caught at build time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Words/phrases that must never appear in a user-visible string.
# Each must be specific enough that a legitimate substring in unrelated copy
# won't trip it (e.g. "contract law" elsewhere is OK; "/contract" or "x-contract-id" is not).
FORBIDDEN=(
  "/contract substrate"
  "/contract chat"
  "contract chat"
  "contract-endpoint"
  "x-contract-id"
  "x_contract_id"
  "contract_id"
  "ContractEndpointChat"
  "contract-fast-agi"
  "contract substrate"
)

# Files in scope: every user-facing surface the public can see.
SCOPE_GLOBS=(
  "src/app/**/page.tsx"
  "src/app/**/layout.tsx"
  "src/components/ask-anything-chat.tsx"
  "src/components/site-footer.tsx"
  "src/components/navbar.tsx"
  "src/components/hero-*.tsx"
  "public/llms.txt"
  "public/llms-full.txt"
  "public/.well-known/security.txt"
)

# Files exempt from the check (have legitimate "contract" mentions: legal text,
# the worker-live/index.ts which is internal infra, audit scripts themselves).
# These paths are matched as exact suffixes.
EXEMPT=(
  "src/app/terms/page.tsx"   # legal: ToS literally is a contract
  "src/app/privacy/page.tsx" # legal: data-processing terms
)

cd "$ROOT"

FOUND=0
for glob in "${SCOPE_GLOBS[@]}"; do
  # zsh-safe expansion: use find for ** patterns instead of relying on shell globbing
  if [[ "$glob" == *"**"* ]]; then
    base="${glob%%/\*\*/*}"
    rest="${glob##*/\*\*/}"
    files=$(find "$base" -type f -name "$rest" 2>/dev/null || true)
  else
    files=$(ls $glob 2>/dev/null || true)
  fi
  for file in $files; do
    # Skip exempt files
    skip=0
    for ex in "${EXEMPT[@]}"; do
      [[ "$file" == *"$ex" ]] && skip=1 && break
    done
    [[ $skip -eq 1 ]] && continue
    [[ ! -f "$file" ]] && continue

    for word in "${FORBIDDEN[@]}"; do
      # Case-insensitive match anywhere in the file
      if grep -niF "$word" "$file" >/dev/null 2>&1; then
        FOUND=$((FOUND + 1))
        echo "  LEAK: $file"
        grep -niF "$word" "$file" | head -2 | sed 's/^/    /'
      fi
    done
  done
done

if [[ $FOUND -eq 0 ]]; then
  echo "OK: no substrate-language leaks in user-facing surfaces"
  exit 0
fi
echo
echo "FAIL: $FOUND forbidden mention(s) found in user-facing files."
echo "These surfaces are seen by site visitors. Rewrite the copy or move the term"
echo "to an internal-only file (handler code, system prompt the model reads, etc)."
echo "If a mention is genuinely necessary, add the file to the EXEMPT list in this script."
exit 1
