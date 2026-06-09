#!/usr/bin/env bash
# skill-primitive.gate.sh — the runnable witness for the skill=final-primitive weld
# (Layers 1+2: skill=/contract, grounded-LLM-follows-skill, POST /v1/skills/chat,
# persist-as-ledger-contract). Each file runs in its OWN bun invocation because
# tests/skills-chat-route.test.ts uses mock.module, which leaks across files in a
# shared bun process. Exits 0 only when every file is green.
set -uo pipefail
cd "$(dirname "$0")/.."   # backend/
FILES=(
  tests/skills-chat.test.ts                # Gap 1+2+3 units (skill=/contract, follow, runSkillChat)
  tests/skill-contract-persist.test.ts     # Layer 2 persist + edges + pointer invariant
  tests/skill-contract-cache.test.ts       # memoized promise: hit/miss/invalidate/indirection (docker-cache)
  tests/skill-primitive-creatures.test.ts  # read-back round-trip, hostile ids, injection framing, 503 degrade
  tests/skills-chat-route.test.ts          # real route happy + STORM isolation (mock.module — isolated)
  tests/unbrowse-llm-free-fallback.test.ts # compiler chain regression (shared runContractLlmChain)
)
fail=0
for f in "${FILES[@]}"; do
  if bun test "$f" >/tmp/skillgate.$$.log 2>&1; then
    echo "PASS  $f  ($(grep -Eo '[0-9]+ pass' /tmp/skillgate.$$.log | head -1))"
  else
    echo "FAIL  $f"; tail -8 /tmp/skillgate.$$.log; fail=1
  fi
done
rm -f /tmp/skillgate.$$.log
[ "$fail" -eq 0 ] && echo "✓ skill-primitive weld: all witnesses green" || echo "✗ skill-primitive weld: a witness failed"
exit "$fail"
