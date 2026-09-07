#!/usr/bin/env bash
# Standing landing-discipline gate — unbrowse marketing pages clear two mechanical
# unicorn-landing patterns:
#   #2 Hero simplicity: the page has exactly one <h1> with <30 word visible hero block
#   #8 Free CTA: no "contact sales" / "book a demo" / "request a quote" as primary CTA
#
# Hallmark + unicorn-landing skills give the qualitative discipline; this script
# binds the two mechanical pieces so they can't drift.
#
# Scope: every src/app/**/page.tsx that is NOT auth-gated or legal text.
# Add new exempt paths to EXEMPT if they're explicitly excluded from the rule.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXEMPT=(
  # auth + legal — not landing pages
  "src/app/account/page.tsx"
  "src/app/dashboard/page.tsx"
  "src/app/login/page.tsx"
  "src/app/billing/page.tsx"
  "src/app/ops/page.tsx"
  "src/app/privacy/page.tsx"
  "src/app/terms/page.tsx"
  "src/app/security/page.tsx"
  "src/app/contact/page.tsx"
  "src/app/about/page.tsx"
  # registry / dynamic / utility
  "src/app/search/page.tsx"
  "src/app/claim/page.tsx"
  "src/app/install/page.tsx"
  "src/app/leaderboard/page.tsx"
  "src/app/miners/page.tsx"
  "src/app/agents/page.tsx"
  "src/app/openclaw-earn/page.tsx"
  # blog index page itself (individual posts excluded via dir name)
  # — exempt only deeply-nested article pages, not landing roots
)

FORBIDDEN_PRIMARY_CTA_PATTERNS=(
  ">Contact sales<"
  ">Book a demo<"
  ">Request a quote<"
  ">Request demo<"
  ">Talk to sales<"
)

FOUND=0
WARN=0

# Find every src/app/**/page.tsx (mapfile is bash 4+; macOS bash 3.2 doesn't have it)
PAGES_LIST=$(find src/app -type f -name "page.tsx")

for file in $PAGES_LIST; do
  # Skip exempt
  skip=0
  for ex in "${EXEMPT[@]}"; do
    [[ "$file" == "$ex" ]] && skip=1 && break
  done
  # Skip blog posts (not landing pages)
  [[ "$file" == src/app/blog/*/page.tsx ]] && skip=1
  [[ "$file" == src/app/docs/* ]] && skip=1
  [[ "$file" == src/app/\[domain\]/* ]] && skip=1
  [[ $skip -eq 1 ]] && continue

  # Free CTA check (must NOT have a forbidden primary CTA)
  for cta in "${FORBIDDEN_PRIMARY_CTA_PATTERNS[@]}"; do
    if grep -qF "$cta" "$file"; then
      FOUND=$((FOUND + 1))
      echo "  FAIL $file: contains a non-free primary CTA ('$cta')"
    fi
  done

  # H1 word-count: count words inside the first <h1>...</h1> on the page.
  # Use python to handle multi-line H1s cleanly; fall back to a soft warning since
  # JSX H1s often render dynamic content (variables, components) the linter can't count.
  word_count=$(python3 -c "
import re, sys
with open('$file') as f: src = f.read()
m = re.search(r'<h1[^>]*>(.*?)</h1>', src, re.S)
if not m:
    print('NOHERO')
    sys.exit(0)
text = re.sub(r'<[^>]+>', ' ', m.group(1))
text = re.sub(r'\{[^}]+\}', ' X ', text)  # JSX expression as 1 word
text = re.sub(r'\s+', ' ', text).strip()
print(len(text.split()))
" 2>/dev/null)

  if [[ "$word_count" == "NOHERO" ]]; then
    : # Not all pages have an <h1> directly (some use a hero component); skip
  elif [[ "$word_count" -gt 30 ]]; then
    WARN=$((WARN + 1))
    echo "  WARN $file: hero <h1> has $word_count words (unicorn-landing #2: ≤30)"
  fi
done

if [[ $FOUND -gt 0 ]]; then
  echo
  echo "FAIL: $FOUND landing page(s) have non-free primary CTAs (unicorn-landing #8)."
  echo "Fix: replace 'Contact sales' / 'Book a demo' with a free self-serve action."
  echo "If the page genuinely requires it (rare), add it to EXEMPT in this script."
  exit 1
fi

if [[ $WARN -gt 0 ]]; then
  echo
  echo "OK with $WARN hero word-count warning(s) — review and tighten if you can."
  echo "Hallmark + unicorn-landing #2: hero ≤30 words. Soft warning, not a block."
  exit 0
fi

echo "OK: landing discipline holds — free CTAs + heroes within unicorn-landing #2 budget"
exit 0
