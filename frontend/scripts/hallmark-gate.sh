#!/usr/bin/env bash
# Hallmark design-system gate (the jesus-ralph witness for "handle the open stuff").
# Exits 0 EXACTLY when:
#   1. zero `transition-all` anti-pattern anywhere in src
#   2. zero pill-eyebrow signature anywhere in src
#   3. zero particle/constellation backdrop imported into any route page.tsx
#   4. every declared MARKETING route adopts the locked system (its page.tsx OR a
#      directly-composed @/components/* carries `eyebrow` or `section-head`)
# Static + deterministic; resolves one level of component composition.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0

count() { grep -rl "$1" src --include="*.tsx" 2>/dev/null | wc -l | tr -d ' '; }

# 1. transition-all
n=$(count "transition-all")
if [ "$n" != "0" ]; then echo "FAIL gate1: transition-all in $n file(s)"; fail=1; else echo "ok   gate1: no transition-all"; fi

# 2. pill-eyebrow signature
n=$(count "rounded-full bg-surface-raised border border-border text-text-secondary text-xs font-mono")
if [ "$n" != "0" ]; then echo "FAIL gate2: pill-eyebrow in $n file(s)"; fail=1; else echo "ok   gate2: no pill-eyebrow"; fi

# 3. particle backdrop in route pages
n=$(grep -rl "CursorParticles\|Constellation" src/app --include="page.tsx" 2>/dev/null | wc -l | tr -d ' ')
if [ "$n" != "0" ]; then echo "FAIL gate3: particle backdrop in $n route page(s)"; fail=1; else echo "ok   gate3: no particle backdrop in routes"; fi

# 4. marketing routes adopt the system
MARKETING_ROUTES="about faq classic papers how-unbrowse-pays install security compare/playwright compare/puppeteer compare/browser-use personal-agents routing-layer agents browser-automation-is-dead"
open=""
for r in $MARKETING_ROUTES; do
  f="src/app/$r/page.tsx"
  [ -f "$f" ] || continue
  tot=$(grep -c "eyebrow\|section-head" "$f")
  for c in $(grep -oE "@/components/[a-z0-9-]+" "$f" | sed 's#@/components/#src/components/#;s#$#.tsx#' | sort -u); do
    [ -f "$c" ] && tot=$((tot + $(grep -c "eyebrow\|section-head" "$c")))
  done
  [ "$tot" -gt 0 ] || open="$open $r"
done
if [ -n "$open" ]; then echo "FAIL gate4: routes not on-system:$open"; fail=1; else echo "ok   gate4: all marketing routes on-system"; fi

[ "$fail" = "0" ] && echo "GATE GREEN" || echo "GATE RED"
exit $fail
