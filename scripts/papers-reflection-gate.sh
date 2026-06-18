#!/usr/bin/env bash
# papers-reflection-gate.sh — structural witness that the papers' zk-privacy + economy
# story is reflected across the frontend (the shared PapersBehind vessel, per-theme) and
# the CLI (the `docs` block resolve emits), and that no moat term leaks.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
ok(){ printf 'ok   %s\n' "$1"; }
bad(){ printf 'FAIL %s\n' "$1"; fail=1; }

# 1. papers source-of-truth exists + exports PAPERS + papersByTheme
[ -f frontend/src/lib/papers.ts ] \
  && grep -q "export const PAPERS" frontend/src/lib/papers.ts \
  && grep -q "export function papersByTheme" frontend/src/lib/papers.ts \
  && ok "frontend/src/lib/papers.ts exports PAPERS + papersByTheme" \
  || bad "papers.ts missing or not exporting PAPERS + papersByTheme"

# 2. the shared vessel exists
[ -f frontend/src/components/papers-behind.tsx ] \
  && ok "papers-behind.tsx (shared vessel) exists" \
  || bad "papers-behind.tsx (shared vessel) missing"

# 3. zk-privacy surfaced on BOTH security + privacy pages via PapersBehind theme="zk-privacy"
grep -q 'PapersBehind' frontend/src/app/security/page.tsx \
  && grep -q 'theme="zk-privacy"' frontend/src/app/security/page.tsx \
  && grep -q 'PapersBehind' frontend/src/app/privacy/page.tsx \
  && grep -q 'theme="zk-privacy"' frontend/src/app/privacy/page.tsx \
  && ok "zk-privacy surfaced on security + privacy (PapersBehind theme=zk-privacy)" \
  || bad "zk-privacy not surfaced on both security and privacy pages"

# 4. economy surfaced on billing via PapersBehind theme="economy"
grep -q 'PapersBehind' frontend/src/app/billing/page.tsx \
  && grep -q 'theme="economy"' frontend/src/app/billing/page.tsx \
  && ok "economy surfaced on billing (PapersBehind theme=economy)" \
  || bad "economy not surfaced on billing page"

# 5. both surfaced on faq + how-unbrowse-pays (PapersBehind OR direct paper link / "papers behind this")
grep -qE 'PapersBehind|/papers|papers behind this' frontend/src/app/faq/page.tsx \
  && grep -qE 'PapersBehind|/papers|papers behind this' frontend/src/app/how-unbrowse-pays/page.tsx \
  && ok "papers referenced on faq + how-unbrowse-pays" \
  || bad "papers not referenced on both faq and how-unbrowse-pays"

# 6. CLI resolve emits a docs block with how_it_pays + economy + privacy + papers keys
grep -q 'docs:' src/cli-v7/eval/stats.ts \
  && grep -q 'how_it_pays' src/cli-v7/eval/stats.ts \
  && grep -q 'economy' src/cli-v7/eval/stats.ts \
  && grep -q 'privacy' src/cli-v7/eval/stats.ts \
  && grep -q 'papers' src/cli-v7/eval/stats.ts \
  && ok "CLI stats.ts emits docs block (how_it_pays + economy + privacy + papers)" \
  || bad "CLI stats.ts missing docs block keys"

# 7. moat — leak-guard must be clean
if bash scripts/leak-guard.sh >/dev/null 2>&1; then
  ok "leak-guard clean (no moat leak)"
else
  bad "leak-guard reported a moat leak"
fi

if [ "$fail" -eq 0 ]; then echo "PAPERS-REFLECTION GREEN"; exit 0; fi
echo "PAPERS-REFLECTION RED"; exit 1
