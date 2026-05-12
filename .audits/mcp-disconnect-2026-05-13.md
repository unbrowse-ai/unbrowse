# MCP disconnect — 2026-05-13

## Symptom
During a multi-turn session, Lewis asked for Eatigo Singapore restaurants (delivered OK via `mcp__unbrowse__unbrowse_run`), then followed up with "find me jobs for ai engineer in linkedin". When the second tool-search fired, the `unbrowse` MCP server tag showed `disconnected` and the previously-deferred MCP tools were no longer callable. The CLI fallback was interrupted at 19s.

## Evidence (Day 1 / Light)
- `unbrowse --version` → 6.13.0; binary symlink intact at `/opt/nanobrew/prefix/bin/unbrowse`.
- 17+ `unbrowse`/`kuri` PIDs alive at Day-1 inventory — orphan accumulation. By Day-5 only 1 PID remained — orphans self-reaped or were killed.
- Latest log line at disconnect window: `[auth] filtered 4 expired cookies for www.linkedin.com` — clean cookie filter, no traceback, no exit code logged.
- Prior Eatigo session ended healthily: `browse-checkpoint tracked 32 HAR, 0 intercepted, 0 extension, 29 bodies → 48 merged`.
- No `unbrowse-2026-05-13.log` was created today — the server day boundary lags UTC; logs continue in `unbrowse-2026-05-12.log`.

## Hypothesis (CORRECTED on Day 5 after mutation-test fired)
1. **MCP disconnect itself**: TRANSIENT — harness MCP wrapper closed stdio between turns; unbrowse binary did not crash.
2. **Why LinkedIn resolves return `no_match`**: capture-phase failure, NOT extractor-filter rejection. Evidence: the production log shows **7 consecutive LinkedIn capture attempts** (00:29:59, 00:35:19, 00:43:58, 00:44:53, 00:45:50, 00:47:56, 00:49:24) each ending at the `[auth] filtered 4 expired cookies for www.linkedin.com` line with **zero follow-up capture activity** — no HAR entries, no endpoint extraction, no filter rejection rows. Each attempt died upstream of extractEndpoints. A Day-3 sub-agent's claim of `body_not_json_or_html` rejection was unverified inference, falsified by Day-5 mutation test (`it.skip` flipped to `it` → 10 pass, 0 fail).

## Reproduction attempt (Day 3 / Land + Day 5 / Creatures correction)
- **Raw curl guest API** (no unbrowse): HTTP 200, 29 KB, 10 parseable `<li class="job-search-card">` blocks. No anti-bot. Reproducible across keywords (Data Scientist: 27 cards, Frontend Engineer: 30 cards) and durable to 5-shot single-IP burst (all 200, all ~29 KB, no rate-limit signal).
- **`unbrowse resolve`** on the public search URL: 6.2s, `no_match`. Capture never reaches structured endpoints — log evidence above. Day-3 sub-agent's specific filter-rejection attribution does NOT reproduce in the unit-level synthetic test.
- **`unbrowse resolve`** directly on the guest-jobs URL: also `no_match`. Sub-agent unable to complete deep trace inspection within timeout — server appeared wedged briefly mid-investigation (Kuri `ConnectionRefused`, stale `whop.com` capture in pipeline) but had recovered to 1 PID by the time the next probe ran.

## Verdict
**BUG** — composite finding across three layers:

1. **MCP disconnect**: TRANSIENT. No code change.
2. **LinkedIn resolve `no_match`**: BUG, but in a different layer than Day-3 first claimed. The failure is in **capture phase** (likely login-wall redirect or auth-state requirement that bypasses cookies), not in `extractEndpoints` filter rejection. The xfail block in `tests/extraction-filter-bypass.test.ts` (the listicle-DOM admission case) was the **wrong reproducer for this bug** and has been removed in commit 36df7937; the surrounding test file remains. A proper reproducer requires a full-pipeline integration test or live `unbrowse resolve` smoke against the guest-jobs URL.
3. **Server wedge**: a transient liveness issue observed mid-investigation (Kuri `ConnectionRefused` blocking new captures). Has self-resolved by audit-write time. Worth a separate ticket: "unbrowse server should fail-fast when Kuri CDP connection refused for >N seconds instead of looping the request."

## Action
- **No code change in this loop.** Plan goal is delivery + verdict, not patch.
- **Linear ticket A (P1)**: "Resolve fails on LinkedIn search URL with `no_match` because capture aborts after cookie filter — possibly login-wall redirect not detected as auth-required." Surface: `src/capture/*` + cookie handling. Falsifier: full-pipeline test asserting `resolve` returns either a populated shortlist OR a `next_step: open_browse_session` handoff (NOT silent `no_match`) when LinkedIn search URL is captured. Reference this audit.
- **Linear ticket B (P2)**: "unbrowse server can wedge on Kuri ConnectionRefused — implement timeout + fail-fast." Evidence: Day-5 investigator observed 5+ hour wedge on stale `whop.com` capture; resolved by orphan reap.
- **No "linkedin.com" registry entry** — fix must be generic (auth-wall detection / capture timeout) per CLAUDE.md "Anti-patterns: per-domain heuristics that don't generalise."
