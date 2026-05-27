#!/usr/bin/env bash
# exa-probe-fallback-gate — fix.sh
#
# This audit does NOT auto-patch source. Verdicts here are about agent UX
# semantics (success:true vs auth_required:true, synthetic shortlist
# round-trippability) — they live in code reviewed by humans + the agent,
# not in code a fixer can rewrite mechanically without judgment.
#
# This script points the operator at the canonical fix surfaces and the
# regression tests that lock the fix in. Exits 0 always (informational).

set -uo pipefail

cat <<'POINT'
exa-probe-fallback-gate — fix is MANUAL (no auto-patch)

Why no auto-patch:
  The rule is about response-envelope semantics (success vs auth_required,
  synthetic shortlist round-trippability). Fixing these mechanically would
  paint over the symptom; the agent must judge in-thread WHICH path needs
  the auth_required branch.

Canonical fix surfaces:

  1. src/orchestrator/index.ts:3760   (probe-fallback quality gate)
     - Before emitting the Exa shortlist, check:
         * personalPronounIntent === true AND
         * AUTH_GATED_HOSTS.includes(urlHost) AND
         * cookieFreshness.fresh === false
     - If all three, return { error: "auth_required",
                              next_step: "unbrowse_auth_capture", ... }
       instead of the success:true envelope.

  2. src/cli.ts                       (declare AUTH_GATED_HOSTS)
     - Export a single const readonly array of known auth-gated hosts.
       Reuse it from orchestrator + execution + future call sites.
       Pattern:
         export const AUTH_GATED_HOSTS: readonly string[] = [
           "github.com", "x.com", "twitter.com",
           "gmail.com", "mail.google.com", /* ... */
         ];

  3. src/execution/index.ts           (synthetic next_step coverage)
     - Verify every synthetic shortlist candidate carries:
         next_step: { go: "...", fetch: "..." }
     - The Exa probe-fallback builder at orchestrator/index.ts:3781 already
       does this; future synthetic-skill paths must follow the same shape.

Regression test (to be added by Worker-1 of this wave):

  tests/exa-probe-fallback-gate.test.ts
    - Probe: intent="see my github notifications", url=github.com/notifications
    - Expect: envelope.error === "auth_required"
    - Expect: envelope.next_step === "unbrowse_auth_capture"
    - Expect: NOT envelope.success === true

After landing the fix:

  bash .audits/exa-probe-fallback-gate/verify.sh
  # Should exit 0 (PASS)

  bun test tests/exa-probe-fallback-gate.test.ts
  # Should pass green

Related docs:
  - .audits/exa-probe-fallback-gate/README.md  (why this rule exists)
  - ~/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/memory/audits-directory-convention.md
  - Day-5 evidence: /tmp/d5w3-resolve.json (the W3 fake-green regression)
  -                  /tmp/d5w1-resolve.json (matching pattern)
POINT

exit 0
