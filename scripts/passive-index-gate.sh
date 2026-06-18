#!/usr/bin/env bash
# passive-index-gate.sh — witness for "passive indexing admits only real,
# externally-reachable endpoints; junk is rejected at the source." jesus-ralph gate.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
ok(){ printf 'ok   %s\n' "$1"; }
bad(){ printf 'FAIL %s\n' "$1"; fail=1; }

# 1. The structural admission predicate behaves (loopback/private/reserved/bad-scheme
#    rejected; real endpoints admitted).
bun test tests/indexable-admission.test.ts >/dev/null 2>&1 \
  && ok "indexable admission predicate (6 cases)" || bad "indexable admission tests"

# 2. Publish admission still passes with the not_indexable_host gate wired in.
bun test tests/publish-admission.test.ts >/dev/null 2>&1 \
  && ok "publish admission (not_indexable_host wired)" || bad "publish-admission tests"

# 3. The gate is wired at BOTH boundaries — capture enqueue AND publish — not just one.
grep -q "isIndexableDomain" src/api/routes.ts \
  && ok "capture boundary gates by domain (routes.ts)" || bad "capture boundary not gated"
grep -q "isIndexableUrl" src/publish-admission.ts \
  && ok "publish admission gates by url (publish-admission.ts)" || bad "publish admission not gated"

# 4. The local capture queue carries no non-indexable junk (post-purge). Env-scoped:
#    only checked when the queue dir exists.
QDIR="${HOME}/.unbrowse/queue/capture-pending"
if [ -d "$QDIR" ]; then
  junk=$(ls "$QDIR" 2>/dev/null | grep -ciE '^(example\.(com|org|net)|chromewebdata|localhost|127\.0\.0\.1)\.' || true)
  [ "${junk:-0}" -eq 0 ] && ok "capture queue free of reserved/loopback junk" \
    || bad "capture queue still has $junk non-indexable envelope(s)"
else
  ok "no local capture queue (nothing to purge)"
fi

if [ "$fail" -eq 0 ]; then echo "PASSIVE-INDEX GREEN — junk rejected at source, real endpoints admitted"; exit 0; fi
echo "PASSIVE-INDEX RED"; exit 1
