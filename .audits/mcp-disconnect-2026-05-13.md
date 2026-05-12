# MCP disconnect — 2026-05-13

## Symptom
During a multi-turn session, Lewis asked for Eatigo Singapore restaurants (delivered OK via `mcp__unbrowse__unbrowse_run`), then followed up with "find me jobs for ai engineer in linkedin". When the second tool-search fired, the `unbrowse` MCP server tag showed `disconnected` and the previously-deferred MCP tools were no longer callable. The CLI fallback was interrupted at 19s.

## Evidence (Day 1 / Light)
- `unbrowse --version` → 6.13.0; binary symlink intact at `/opt/nanobrew/prefix/bin/unbrowse`.
- 17+ `unbrowse`/`kuri` PIDs alive after the "disconnect" — orphan accumulation, not a crash.
- Latest log line at disconnect window: `[auth] filtered 4 expired cookies for www.linkedin.com` — clean cookie filter, no traceback, no exit code logged.
- Prior Eatigo session ended healthily: `browse-checkpoint tracked 32 HAR, 0 intercepted, 0 extension, 29 bodies → 48 merged`.
- No `unbrowse-2026-05-13.log` was created at all today — the disconnected MCP server never wrote a fresh log.

## Hypothesis
**TRANSIENT** — the MCP wrapper (managed by the Claude Code harness, not by code in this repo) closed its stdio pipe between turns. The unbrowse binary did not crash. The orphan PIDs are from prior browse sessions that never reaped, not the cause of the disconnect.

## Reproduction attempt (Day 3 / Land)
Two parallel sub-agents probed the same LinkedIn URL Lewis asked about:

- **Unbrowse-native** (`unbrowse resolve` + `execute`): resolve took 6.2s, returned `no_match`. Capture of `https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer` failed with "redirected too many times" (LinkedIn auth-wall redirect chain). Direct attempt on the guest-jobs API URL was *filtered out* by the ranker as `body_not_json_or_html` because the response is HTML cards, not JSON.
- **Raw curl guest API**: HTTP 200, 29 KB, 10 parseable `<li class="job-search-card">` blocks. No anti-bot challenge, no 999/login wall, no rate-limit.

Both paths produced the same 10 jobs after fallback. The MCP server itself was not re-tested in this loop — would need a fresh harness session.

## Verdict
**TRANSIENT** for the MCP disconnect itself.

**SEPARATE BUG (P1) surfaced as a side effect**: `unbrowse resolve` does not recognise LinkedIn's guest-jobs HTML endpoint as a viable result, even though it returns 200 with parseable structured cards. The ranker's "API-shape" filter rejects HTML-card endpoints that aren't JSON. This is the same class of failure as the X.com GraphQL POST gap listed in project CLAUDE.md → "Known Issues to Fix" and the page-artifact-promotion rule under "Page-artifact promotion for content-read intents."

## Action
- **No code change in this loop.** Plan goal is delivery + verdict, not patch.
- **Reaper for orphan kuri PIDs**: not this loop's scope; CLAUDE.md already documents `pkill -9 -f 'unbrowse|kuri'` as the manual fix.
- **Linear ticket to draft** (separate PR): "Ranker rejects LinkedIn guest-jobs HTML endpoint as `body_not_json_or_html` — promote HTML responses with `<li class="job-search-card">`-style listicle DOM signal." Reference: `src/extraction/extract-endpoints.ts` filter chain + `src/execution/index.ts:rankEndpoints` page-artifact promotion. Add LinkedIn guest URL to `tests/extraction-filter-bypass.test.ts` so the fix has a falsifier.
- **No "linkedin.com" registry entry** — fix must be generic (HTML listicle detection), per CLAUDE.md "Anti-patterns: per-domain heuristics that don't generalise."
