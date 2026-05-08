# Plan v5: Bake Session-Discovered Behaviors as Defaults

**Premise**: across 5 prior loops, we shipped behaviors gated by flags or observation-only that should be the default. Each was discovered the hard way (bug → flag → realize the flag should be the default). This plan flips the polarity for the 5 highest-leverage cases. None of these are speculative — every one was already proven valuable in a real bench run earlier in this session.

**Goal**: reduce flag-surface-area on the public CLI; reduce no-op flag-passing in `scripts/bench-two-phase.sh`; eliminate the class of bug "agent has the data but the truncation hides it."

**Non-goals**: no new features. Pure flag-flipping + small consolidations.

## What this plan replaces

`plan-v4.md` is shipped (Phase C). `plan-v3.md` Phase D is shipped (foundation + Kuri-share). `plan-v2.md` Phase A is shipped, B-survey done, B-wire deferred. This plan is parallel — it doesn't depend on B-wire and doesn't block it.

---

## #1: `execute --raw` becomes default

**Current**: `unbrowse execute --skill X --endpoint Y` returns the body if ≤64KB, otherwise replaces it with `extraction_hints` envelope (`{message: "Response is 548KB...", schema_tree: {...}}`). User must pass `--raw` to bypass.

**Default flip**: full body in `result` always. New flag `--summarize` opts INTO the truncation behavior for the rare interactive case where a human wants short output.

**Why**: this session's bench couldn't see Foot Locker's 548KB real shoes page until I added `--raw` to the bench wrapper. The "helpful" truncation hides real data from automated agents. Most callers (bench, MCP server, CLAUDE Code, Codex) want bytes. The interactive `unbrowse fetch` already converts HTML→markdown by default — that's a different command for a different audience.

**Surface area**:
- `src/cli.ts` cmdExecute: invert default; remove `--raw` parsing; add `--summarize` parsing
- `scripts/bench-two-phase.sh`: drop the `--raw` we just added (~3 LoC delete)
- `src/cli.ts` CLI_REFERENCE: update help text
- Tests: any test asserting extraction_hints shape needs to either pass `--summarize` or update expectation

**Risk**: callers that expect the envelope on big responses get raw bytes instead. Mitigated by: (a) the envelope was already opt-out via `--raw`, so there's no contractual guarantee of truncation, (b) MCP/agent clients prefer raw, (c) explicit `--summarize` for the rare opposite case.

**Coverage impact**: ~3 sites in the bench corpus return >64KB on success today (bing, vinted, ticketmaster). Their bench rows go from `bytes:1KB` (envelope size) → real body size; rubric still buckets correctly.

**Cost**: ~10 LoC + 2 test updates. ~30min.

---

## #2: Probe-gate consolidates ALL 4xx+text/html → server (extend Phase C)

**Current**:
```ts
if (status === 401 || status === 403) → server  // a9c0ad58
if (status === 400 && /text\/html\b/i.test(content_type)) → server  // 30c82bc7 (Phase C)
if (status >= 400) → return-error
```

Three branches doing the same thing for two different status codes.

**Default flip**: one branch handles all 4xx+text/html.
```ts
if (status >= 400 && status < 500 && /text\/html\b/i.test(content_type)) → server
```

This automatically covers 405 (Method Not Allowed on HEAD specifically — common for sites that allow GET but not HEAD), 410 (gone but redirect-to-archive page), 451 (legal-block UI). Same root cause: HEAD rejected for non-browser UA, GET often works.

**Why**: we landed 401/403 and 400 separately because each was discovered separately. The unified rule is the actual principle. ~5 LoC consolidation, no new behavior except for 405/410/451 sites (none in current corpus, but the pattern is structural).

**Surface area**:
- `src/execution/probe.ts:decideFromProbe`: collapse three conditionals into one
- `tests/execution-probe-ladder.test.ts`: add 3 new assertions (405+html, 410+html, 451+html → server); existing 401/403 + 400 tests preserved by the broader rule

**Risk**: 404+text/html might genuinely be "stale endpoint, real 404 page". But the agent reads the body; 404 with body is no worse than 404 without. Acceptable.

Hmm actually 404 is special — we DO want return-error short-circuit on truly-stale URLs to avoid slow GET. **Decision**: gate stays at `status !== 404`, OR the executor's existing 404 → staleEndpointResult handler at line 2756 catches it post-server-fetch. Lean toward: include 404 in the rule, let the executor handle the 404 case downstream uniformly. Makes the rule cleaner.

**Cost**: ~5 LoC + 3 test cases. ~20min.

---

## #3: Auto-spawn sandbox-capable Kuri on any executor path that may need it

**Current**: `ensureKuriSandboxReachable` (`src/kuri/spawn.ts`, shipped this session) is called only from the 5xx → ssr-fastpath fallback in `executeEndpoint`. If `executeDomExtractionEndpoint` (dead code in a separate code path), Phase B-wire (when it lands), or any future caller invokes `trySsrFastPathOnBlock`, they have to remember to call `ensureKuriSandboxReachable` first.

**Default flip**: move the `ensureKuriSandboxReachable` call INSIDE `trySsrFastPathOnBlock`. The helper becomes self-contained — first call probes/spawns Kuri, subsequent calls hit the warm Kuri.

**Why**: the failure mode "helper called from new code path, returns null because Kuri not spawned" is exactly what bit Phase D twice this session. The helper should be self-sufficient; callers shouldn't need to know about the spawn dance.

**Surface area**:
- `src/capture/ssr-fastpath.ts:trySsrFastPathOnBlock`: prepend `await ensureKuriSandboxReachable(kuriBase)`; on failure return null with a logged reason
- `src/execution/index.ts:5xx-fallback path`: REMOVE the explicit `ensureKuriSandboxReachable` call (helper does it now)
- `tests/ssr-fastpath.test.ts`: add 1 assertion that helper returns null when Kuri unavailable (mocked)

**Risk**: 800ms health check on first call adds latency to first ssr-fastpath invocation. Mitigated by: subsequent calls are fast (Kuri stays warm 25min+ idle).

**Cost**: ~8 LoC + 1 test. ~15min.

---

## #4: `\b` word-boundary audit on content-type regexes

**Current**: Phase C's regex was originally `/text\/html/i` — would match `text/htmlembedded` substring. Fixed to `/text\/html\b/i` in Step 5. There are likely other content-type regexes in the codebase with the same loose-match risk.

**Default flip**: grep for `text\/html`, `application\/`, etc. without `\b` boundary; tighten each.

**Surface area**:
- `grep -rn 'text\/html' src/` to enumerate
- For each: assess whether word-boundary is appropriate (yes for content-type matching, no for in-body string scanning where html might appear inside other strings)
- Update regexes; run tests

**Why**: defensive correctness. No bug observed yet, but the same Step-5-shape lost-sheep is latent everywhere we string-match content-types.

**Cost**: ~10 LoC across 3-5 sites + run existing tests. ~20min.

---

## #5: Decision_trace step naming convention (doc)

**Current**: ad-hoc step names — `5xx_ssr_fastpath_fallback`, `auth_recovery_retry`, `probe`, `decision`, `server_fetch`, `5xx_page_fetch_fallback_no_html`, etc. Some are `<scope>_<action>`, some are `<event>`, some are flat verbs.

**Default flip**: document the convention in CLAUDE.md so future steps follow `<scope>_<action>` or `<scope>_<state>` consistently. New steps from agents follow the doc.

**Why**: agent reads decision_trace to understand what happened. Inconsistent naming costs cognitive load. Especially as we add more fallback layers (Phase D's 5 substates already crowd the trace).

**Surface area**: CLAUDE.md addition (~15 lines). No code change.

**Cost**: 5 min.

---

## Total budget

| # | Change | LoC | Tests | Time |
|---|---|---|---|---|
| 1 | `execute --raw` default | 10 | 2 | 30min |
| 2 | Probe 4xx+html → server consolidation | 5 | 3 | 20min |
| 3 | Helper self-spawns Kuri | 8 | 1 | 15min |
| 4 | `\b` regex audit | 10 | 0 | 20min |
| 5 | Decision_trace naming convention | 15 (doc) | 0 | 5min |
| **Total** | | **48 LoC** | **6** | **~1.5h** |

## Order

1. **#5 first** (doc only, zero risk, sets the convention before any new code).
2. **#3 next** (helper self-spawn — closes the latent bug class first).
3. **#2** (probe consolidation — small, validated by Phase C's existing pattern).
4. **#1** (`--raw` default — biggest behavior change, ship after the smaller wins build confidence).
5. **#4** (regex audit — pure refinement, ship anytime).

Each as a separate commit for clean rollback.

## What's NOT in this plan

- Phase B-wire (capture-time SSR fast-path integration, ~60 LoC) — separate; survey done, helper + Kuri-share already in place
- Phase F (bundle-replay challenge solver) — separate iteration; not all sites need it
- README / CHANGELOG — none of these are public-API-breaking; defaults change agent UX, no version bump warranted

## Definition of done

- 5 commits on `feat/agent-ux-run-planner`, each independently revertable
- 6 new test assertions across `tests/execution-probe-ladder.test.ts`, `tests/ssr-fastpath.test.ts`
- Existing test suites stay green (134+ assertions across 9 suites)
- Fresh footlocker bench run shows: probe-gate fires AT 4xx+html (not just 400), bench wrapper drops `--raw` flag, footlocker still buckets `a_inspect_response_body_4xx_real_content`
- Coverage on the bench: still 8/9 = 88.9% (no new sites unlocked, but no regressions either)

## Risk + rollback

- **#1 risk**: a caller depending on extraction_hints envelope on big responses gets raw bytes. Mitigated: never a contract guarantee. `--summarize` is the explicit opt-in.
- **#2 risk**: 4xx-with-html that's truly a stale endpoint wastes a GET. Mitigated: ~200ms cost, executor's existing 404 handler still routes through staleEndpointResult downstream.
- **#3 risk**: 800ms first-call latency. Mitigated: warm Kuri persists.
- **#4 risk**: tightening a regex breaks a legitimate content-type match. Mitigated: tests run.
- **#5 risk**: zero (doc only).

Each phase is one commit; revert resets to current state.
