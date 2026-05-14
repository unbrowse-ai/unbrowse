# Linear ticket drafts — derived from .audits/mcp-disconnect-2026-05-13.md

Two tickets to file. Both surface real, evidence-backed bugs. Neither needs a per-domain heuristic.

---

## Ticket A (P1) — Resolve fails silently on LinkedIn search URLs after cookie filter

**Surface:** `src/capture/*` (capture pipeline) + cookie/auth-state handling.

**Symptom.** `unbrowse resolve --intent "search AI engineer jobs" --url "https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer&location=Singapore"` returns `no_match` with no actionable `next_step`. Capture appears to abort after cookie load with zero downstream activity.

**Evidence (from `.audits/mcp-disconnect-2026-05-13.md`):** Production log `~/.unbrowse/logs/unbrowse-2026-05-12.log` lines 69895–69901 show **7 consecutive LinkedIn capture attempts** at timestamps 00:29:59, 00:35:19, 00:43:58, 00:44:53, 00:45:50, 00:47:56, 00:49:24 — each ending at `[auth] filtered 4 expired cookies for www.linkedin.com` with **no follow-up** `[capture] browse-checkpoint`, `[browse-index]`, or endpoint-extraction lines. The log ends at 69901; the capture pipeline truly produced nothing after the cookie filter.

**Hypothesis.** LinkedIn's `/jobs/search` redirects unauthenticated browsers through an auth-wall chain. Kuri or the capture wrapper likely follows the chain and either (a) treats the redirect as a successful navigation with no API calls, (b) hits a redirect-loop limit silently, or (c) loses the request mid-chain when the cookie set doesn't satisfy the auth check.

**Acceptance criteria (the test that proves the fix):** When `unbrowse resolve` is run against `https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer&location=Singapore`, the result is **either** a populated `available_endpoints` shortlist **or** a `next_step: open_browse_session` / `abandon_or_authenticate` with `suggested_commands` — **NOT** a silent `no_match`. Same rule per CLAUDE.md "Browser-open is failure mode, not feature."

**Falsifier (new test):** `tests/capture-auth-wall-detection.test.ts` (does not exist yet) — full-pipeline integration test asserting the above acceptance criterion. **Do NOT** add a `linkedin.com` registry entry; detection must be on a generic signal (redirect chain length, login-keyword in redirect path, auth-required HTML signature).

**Anti-patterns to avoid:** Per-domain branches in `src/capture/*`. Hardcoded LinkedIn URL pattern checks. "Add LinkedIn to skill-cache as a special case."

**Reference:** `.audits/mcp-disconnect-2026-05-13.md`, commit `36df7937` (Day-5 corrected diagnosis), this Day-8 audit.

---

## Ticket B (P2) — Unbrowse server can wedge on Kuri `ConnectionRefused`; needs fail-fast

**Surface:** Server orchestration around `src/kuri/client.ts` capture invocations.

**Symptom.** A Day-5 investigation observed the local unbrowse server stuck for **5+ hours** in an infinite loop:
- `[capture] intent-aware wait: looking for API matching one of [...] (from https://whop.com/joined/...)`
- `[kuri] [stderr] warning: HAR: Network.enable failed: ConnectionRefused`
- `tracked 0 HAR, 0 intercepted, 0 extension, 0 bodies → 0 merged`

New resolve requests could not progress; they queued behind the wedged whop.com capture. Resolved only after orphan kuri PIDs were reaped (manual `pkill` per CLAUDE.md note).

**Hypothesis.** When Kuri's CDP connection enters `ConnectionRefused` state, the capture wrapper keeps retrying without a wallclock budget or a circuit-breaker, never failing the request to free the pipeline.

**Acceptance criteria:** If Kuri returns `ConnectionRefused` for a configurable threshold (default ~10s), the capture aborts with an actionable error (`kuri_unavailable`) and the request returns to the client with a clear next-step rather than silently looping.

**Falsifier (new test):** Integration test that injects a Kuri-refused state (e.g., point Kuri socket at a non-listening port) and asserts capture aborts within N seconds with a typed error code. **Do not** mock Kuri's behavior — exercise the real client wrapper against a closed port.

**Anti-patterns to avoid:** Adding a domain filter to skip whop.com specifically. Silently swallowing the timeout. "Just restart the server" runbook entry without code-level fix.

**Reference:** Day-5 investigator finding in this loop's grade row (step 5), production-log evidence in `.audits/mcp-disconnect-2026-05-13.md` § Reproduction attempt.
