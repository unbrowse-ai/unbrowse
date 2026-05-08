# PAPER_PLAN.md

Master plan to make the shipped codebase satisfy every concrete claim of
*Internal APIs Are All You Need: Shadow APIs, Shared Discovery, and the Case
Against Browser-First Agent Architectures* (arXiv:2604.00694v1).

Peer to NORTHSTAR.md and CLAUDE.md. NORTHSTAR.md owns the product
contract; PAPER_PLAN.md owns the paper-claim contract. Where they overlap,
NORTHSTAR wins (product reality precedes paper rhetoric).

## The Single Sentence

> **Every numeric claim and named capability in arXiv:2604.00694v1 is
> reproducible from the shipped codebase, end-to-end, on demand.**

## Status of Each Paper Claim

| # | Claim | §  | State | Evidence | Gap |
|---|---|---|---|---|---|
| 1 | 3.6× mean / 5.4× median speedup vs Playwright on 94 domains | §7.3 | partial | bench-local rubric; ~20-domain replay | no 94-domain corpus harness |
| 2 | 950 ms warmed-cache median latency | §7.3 | partial | warm-tab cache shipped | no published end-to-end timing |
| 3 | 18 domains <100 ms, fastest 79 ms (30× peak) | §7.3 | unknown | — | no per-domain p50 table |
| 4 | 8,200 ms median cold-start across 20 new domains | §7.4 | shipped | capture pipeline complete | no cold-start benchmark report |
| 5 | 90% skill publish success on 20 domains | §7.4 | partial | streaming publish live | success rate not measured |
| 6 | Subsequent call drops to 640 ms after cold-start | §7.4 | partial | cache hit path exists | no second-run telemetry |
| 7 | 3–5 cached uses break even vs Playwright | §7.4 | missing | — | no breakeven calculator |
| 8 | 500+ domains / ~10 000 endpoints in graph | §7.2 | shipped | marketplace counts | needs current-state snapshot |
| 9 | Composite scoring: 40 sim / 30 reliability / 15 freshness / 15 verification | §3.3 | missing | rank deltas (51780d7e, 5c880731); Wave-1 seed at `src/ranking/index.ts`; P2 W1 weights+freshness at `src/ranking/{composite,freshness}.ts` | no unified module |
| 10 | Background verification every 6h | §3.4 / §6.3 | missing | ZK proofs at commit time only | no scheduled job |
| 11 | Freshness 1/(1 + d/30) where d = days | §6.3 | partial | `src/ranking/freshness.ts` ships pure function + Date helper | not yet consumed by runtime ranker (P2 W2) |
| 12 | Contributor share ≈ 70% of install revenue | §5.2.1 | missing | x402 pay loop only | no contributor ledger |
| 13 | Infrastructure toll ≈ 10% | §5.2.1 | partial | platform wallet | no enforced split |
| 14 | Tier 1 install fee $0.005–0.02 / skill | §7.5 | partial | x402 wired | no published price band |
| 15 | Tier 3 search fee $0.001–0.005 / query | §7.5 | partial | search loop wired | no published price band |
| 16 | x402 round-trip is the only added latency | §5.1 | shipped | apiRequest auto-pay | needs measurement |
| 17 | Pre-publish ≥ 50% endpoint success + ≥ 1 verified | §6.1 | missing | publish allowed at any rate | no validation gate |
| 18 | Routes stale > 24 h prioritized for re-verification | §6.3 | missing | — | no priority queue |
| 19 | Speedup falls to 2.1× on bot-protected sites | §8.3.1 | shipped | anti-bot fallback (4451a4ce) | needs split-corpus benchmark |
| 20 | Browser runtime ≈ 500 MB / instance | §4.1 | shipped | Kuri 464 KB cold start | needs RAM measurement |
| 21 | Rational-adoption: graph_fee + graph_latency + failure_risk < browser_rediscovery_cost | §4.1 | missing | — | not executable product logic |

State values: `shipped` (paper claim verifiable today), `partial` (mechanism
exists but claim not measurable), `missing` (no code), `unknown` (need to
audit). Update this table as milestones land.

## Recurring Losses to Inoculate

The plan must not re-introduce these patterns. Each is memorialized in
`memory/feedback_*.md`.

1. **Harness runs global binary, not source.** Unit tests are truth; bench-local runs the installed CLI. Plan must measure source via `bun src/cli.ts` for fast iteration. (`feedback_harness_uses_global_binary.md`)
2. **Never fake momentum.** No claim in this plan asserts a metric not yet measured by a runnable harness. Originally codified for investor messaging; the rule binds the same way for paper claims — never publish a number you cannot reproduce with one command. (`feedback_no_fake_momentum.md`)
3. **Git worktree upstream trap.** Branch operations use `safe-push`. (`feedback_git_worktree_upstream.md`)
4. **Silent truncation erases SPA payloads.** Any new extraction or scoring path must audit byte/regex bounds. (`feedback_extraction_silent_truncation.md`)
5. **Harness is for the main agent, not worker fleets.** Sub-agent fleets are for design/audit, not for measuring product. (`feedback_harness_is_for_main_agent.md`)
6. **No heuristics in judge jobs.** Classification of unstructured artifacts is LLM-judged. (`feedback_no_heuristics_in_judge_jobs.md`)
7. **Verify binary chain.** Kill stale processes, audit which `unbrowse` runs, before any benchmark. (`feedback_binary_chain_check.md`)
8. **Save progress lazily.** Long benchmark runs persist after every domain, not at end. (`feedback_lazy_progress.md`)

## Milestones

Numbered P1…P8. Order is dependency-driven; see §"Execution Order" for the
DAG. Each milestone follows NORTHSTAR.md shape: **Goal / Work / Done when**.

### P1: Unified Ranking State Machine

Goal: collapse the 6+ scattered scoring deltas into one decision module.

Work:
- add `src/ranking/index.ts` exporting a pure `rankEndpoints(candidates, intent, context) → RankedCandidate[]`
- migrate every existing rank call site (resolve, execute, picker, marketplace) to call this module
- expose intermediate signals (sim, reliability, freshness, verification) on each result row
- delete inline scoring deltas
- preserve current behavior; ranking changes belong to P2

Done when:
- `grep -nE "score \\+= [0-9]" src/` returns zero hits outside `src/ranking/`
- the 6 historical scoring fixes (51780d7e, 9aa646c8, 5c880731, 8e42f7ff, intent-yield, hard-clamp) live as named functions inside `src/ranking/` AND each has a regression fixture in `tests/ranking-regressions.test.ts` that fails if the function is inlined or removed
- existing ranking tests still pass; one new test asserts the four signals are surfaced

### P2: Composite Scoring (40 / 30 / 15 / 15)

Goal: implement the paper's stated weights as the runtime scorer.

Work:
- add `composite(sim, reliability, freshness, verification) = 0.4·sim + 0.3·reliability + 0.15·freshness + 0.15·verification` inside `src/ranking/`
- implement `freshness(d) = 1 / (1 + d/30)`
- implement `reliability(endpoint)` from rolling success rate
- implement `verification(endpoint)` from latest trust-refresh result (hooks into P3)
- expose weights as constants so the paper's table is greppable

Done when:
- a unit test asserts `composite(1, 1, 1, 1) === 1` and weights sum to 1
- ranker output for a fixture matches the paper's 40/30/15/15 weighted ordering
- `grep -n "0\\.4\\|0\\.3\\|0\\.15" src/ranking/` shows the four constants in one file

### P3: 6h Continuous Trust Refresh

Goal: turn trust from a commit-time event into a 6h cycle.

Work:
- add `src/trust/refresh-job.ts` running on a 6h interval (configurable, default 6h)
- prioritize endpoints stale > 24 h (paper §6.3)
- on each pass: re-issue endpoint call, re-validate schema, decay reliability/freshness
- emit `endpoint_refreshed` / `endpoint_expired` events into the existing telemetry stream
- never auto-execute mutating endpoints during refresh (read-only verification)

Done when:
- a stale endpoint (last_seen > 24 h) is re-verified within one cycle in a test that fast-forwards the clock
- `verification(endpoint)` consumed by P2 reflects the refresh result
- `unbrowse health` prints a `trust:` line whose `expired_count` field is non-zero on a fixture with at least one stale endpoint

### P4: Cost-Benefit Ledger + Contributor Payouts

Goal: prove the paper's economic claim ends-to-end.

Work:
- add `src/payments/ledger.ts` recording every billable event: agent_id, skill_domain, endpoint_id, fee_usd, tier (install / execute / search), benefit_signals
- ledger writes are idempotent by `(endpoint_id, tick_id, event_type)` and serialized under one mutex; refresh-triggered writes (P3) and execution-triggered writes never race
- attribute revenue: 70 % to the contributor cohort that improved the route, 10 % infra toll, residual to operators (paper §5.2.1)
- delta-based attribution: each contributor's share is proportional to schema improvement they introduced (commit-distance from prior version)
- settlement runs 24 h after the most-recent refresh tick for an endpoint (not weekly), so attribution always uses the freshest schema version
- read-only `unbrowse earnings` surface for contributors

Done when:
- a synthetic 3-contributor / 10-execution scenario produces the expected 70 / 10 / 20 split in a test
- the ledger writes are append-only and survive restart
- `unbrowse earnings` shows non-zero rows on a domain with at least one paid execution

### P5: 94-Domain Reproducible Benchmark

Goal: every paper number from §7 is reproducible from one command. P5 is a
**snapshot of an already-shipped system**, not a checkpoint along the way.
Run AFTER P1–P4 + P7 land, so the benchmark measures the system the paper
describes — not a skeleton.

Work:
- vendor the paper's 94-domain corpus into `harness/corpus/paper-94.txt`. Source priority: (a) arXiv:2604.00694v1 supplementary material if available; (b) the explicit list extracted from the paper's per-domain figures (e.g. §7.3 Figure 2 / §8.3.1 protected-corpus split) by visual transcription; (c) regeneration from §7.2 selection criteria as a LAST resort, recording the regeneration seed and a SHA-256 of the resulting list in the corpus header. §7.2 alone is underspecified; (a) or (b) must be the source unless explicitly justified
- add `scripts/paper-benchmark.sh` that runs the corpus warmed and cold, records per-domain p50/p95, and emits a JSON report whose schema mirrors the paper's tables
- add `scripts/browser-rediscovery-benchmark.sh` that replays the same 94 domains via Playwright (no Unbrowse) and records time-to-first-API-call — this produces the `browser_rediscovery_cost` oracle that P7 needs
- the run uses **source** (`bun src/cli.ts`) per inoculation #1 and persists per-domain results lazily per inoculation #8
- split protected vs unprotected by reading captured anti-bot signals — no per-domain heuristics
- output a single Markdown report under `evals/paper-benchmark-<date>.md`

Done when:
- `bash scripts/paper-benchmark.sh --warmed` finishes on the 94-domain corpus and produces the report
- mean speedup, median speedup, p50 latency, breakeven, and protected/unprotected split rows are present in the report
- the report includes per-row tolerance against paper §7.3 / §7.4 / §8.3.1 — each metric flagged `pass` if within ±25 % of the paper's value, `flag` otherwise (no subjective "can be compared")
- `scripts/browser-rediscovery-benchmark.sh` produces `evals/browser-cost-ms.json` consumed by P7

### P6: Pre-Publish Validation Gate

Goal: enforce the paper's pre-publish floor.

Work:
- inside the existing publish pipeline, gate emission on: ≥ 50 % endpoint success rate AND ≥ 1 verified endpoint (paper §6.1)
- if gate fails, return a typed `publish_rejected` next_action explaining why
- testing low-confidence skills happens against an isolated sandbox marketplace (`UNBROWSE_PUBLISH_NAMESPACE=sandbox`) — never the production graph; no `--force-publish` flag exists, the gate is total

Done when:
- a synthetic skill with 49 % success rate is rejected with the documented next_action
- a skill with 51 % success and zero verified endpoints is rejected
- a skill with 51 % success and one verified endpoint is accepted
- `grep -n "force-publish" src/ packages/` returns zero hits

### P7: Rational-Adoption Inequality as Code

Goal: turn the paper's adoption inequality into runtime product logic.
Work:
- inside `src/orchestrator/run-planner.ts` (Step-1-loop artifact), add a cost-comparison helper: `should_use_graph(graph_fee, graph_latency_ms, failure_risk, browser_rediscovery_cost) → boolean`
- the planner's path choice for `shared_graph` vs `browser` consults this helper
- expose the comparison reason in `run_plan` so agents can debug
- the `browser_rediscovery_cost` value is sourced from `evals/browser-cost-ms.json` produced by `scripts/browser-rediscovery-benchmark.sh` (P5 deliverable). Without that oracle the helper returns `undefined` and the planner falls through to its current path-order heuristic; this is acknowledged as a P5-blocker, not a P7 bug

Done when:
- a unit test asserts that for input `{ graph_fee: 0.001, graph_latency_ms: 50, failure_risk: 0.01, browser_rediscovery_cost: 4000 }` the planner returns `run_plan[*].mode === "shared_graph"`; for `{...browser_rediscovery_cost: 100}` it returns `run_plan[*].mode === "kuri_session"`
- a unit test asserts the inequality fires correctly on three synthetic cases (graph wins, browser wins, tie)
- when `browser_rediscovery_cost` is `undefined`, the planner produces the same `run_plan` as today (regression-safe)

### P8: Drift-Pattern Inoculation

Goal: stop the five recurring losses from re-emerging in the next year.
Split into two sub-phases so P8b never collides with P7 on `run-planner.ts`.

Work (P8a — parallelizable with P1–P7, no shared files):
- auth: collapse the 3 cookie-extraction rewrites into one strategy module with a clear browser-detection contract (mirrors `agent-browser` CLAUDE.md guidance)
- kuri: separate platform availability from feature gating; `unbrowse run` must succeed on darwin-arm64 even when linux-x64 binary is missing
- ranking: covered by P1
- anti-bot: keep current fallback (4451a4ce); P5 adds the protected-corpus measurement so the 2.1× number is honest

Work (P8b — runs AFTER P7 lands, since both edit `src/orchestrator/run-planner.ts` and `src/cli.ts`):
- resolve/execute state: single `RunPlannerInput → RunPlannerResult` becomes the only path callers use; remove parallel decision logic in `cmdRun`
- `cmdRun` is reduced to argv-parse → `runPlanner(input, cliDeps)` → output decoration; no inline resolve/execute/capture/browse remains

Done when:
- `grep -nE 'host === "[a-z]"' src/` returns zero hits (CLAUDE.md anti-pattern audit)
- `grep -nE "POST|/v1/(intent/resolve|skills/.*/execute|capture|browse/go)" src/cli.ts` returns hits ONLY inside `cmdRun`'s deps factory (not inline decision logic)
- `find src/auth -type f -name '*.ts' | xargs grep -l "Chrome\\|Firefox\\|Brave\\|Arc\\|Dia"` returns exactly one file: `src/auth/strategy.ts`

## Phase → File Map

| Milestone | Primary files (new or owned) |
|---|---|
| P1 Unified Ranking | `src/ranking/index.ts`, `src/ranking/signals.ts`, `tests/ranking-*.test.ts` |
| P2 Composite Scoring | `src/ranking/composite.ts`, `tests/composite-scoring.test.ts` |
| P3 Trust Refresh | `src/trust/refresh-job.ts`, `src/trust/freshness.ts`, `tests/trust-refresh.test.ts` |
| P4 Ledger + Payouts | `src/payments/ledger.ts`, `src/payments/attribution.ts`, `src/payments/payout-job.ts`, `tests/payments-*.test.ts` |
| P5 94-Domain Bench | `harness/corpus/paper-94.txt`, `scripts/paper-benchmark.sh`, `scripts/browser-rediscovery-benchmark.sh`, `evals/browser-cost-ms.json`, `evals/paper-benchmark-*.md` |
| P6 Publish Gate | `src/publish/validate.ts`, `tests/publish-validation.test.ts` |
| P7 Adoption Inequality | `src/orchestrator/run-planner.ts` (extend), `tests/run-planner-cost.test.ts`, reads `evals/browser-cost-ms.json` |
| P8 Drift Inoculation | `src/auth/strategy.ts`, `src/cli.ts` (cmdRun delegation), `src/kuri/availability.ts` |

Detailed sub-phases live in `.planning/phases/<NN>-<slug>/` per existing GSD
convention.

## Execution Order + Dependencies

```
P1 ──┬─► P2 ──► P3 ──► P4 ──┐
     │                       │
     └─► P7 ─────────────────┤
                             ▼
                            P5  (the paper-number snapshot)

P6   (independent; ships any time)
P8a  (parallel with P1–P5; auth/kuri)
P8b  (runs after P7; cmdRun → runPlanner delegation)
```

DAG edges: P1→P2, P1→P7, P2→P3, P3→P4, P4→P5, P7→P5, P1→P5. P6 and P8a
have no inbound edges and ship on demand. P8b: P7→P8b.

Recommended order:

1. P1 — unblocks P2, P7
2. P2 — needs P1; defines composite scoring
3. P3 — needs P2; verification feeds composite score
4. P4 — needs P3; benefit signals come from refresh + execution
5. P7 — needs P1; pairs with P5 oracle
6. P8a — independent; ships in parallel from step 1 onward
7. P5 — needs P1–P4 + P7 to land first; produces oracle for P7 to consume on next iteration
8. P8b — needs P7; runs once cmdRun delegation is safe
9. P6 — independent; ships any time after P1 (validation gate is total; no ledger dependency)

## Anti-Goals

- Do not invent new top-level CLI commands (NORTHSTAR §"Anti-Goals").
- Do not add per-domain heuristics in any milestone.
- Do not mock in tests; live runtime required (CLAUDE.md).
- Do not commit without explicit ask.
- Do not publish numbers in this plan that no harness has measured.
- Do not bypass `safe-push` for branch operations.
- Do not re-implement decision logic outside `src/orchestrator/run-planner.ts`.
- Do not pour new wine into old bottles: each milestone gets its own module, not a sprawl across `src/cli.ts`.
- Do not treat JSON-LD aggregate metadata as success for listing/search tasks (NORTHSTAR §"Anti-Goals"). Task-level extraction quality must surface real items.
- Do not silently perform real-world side effects; mutating actions require explicit confirmation (NORTHSTAR §"Anti-Goals").
- Do not use capture/browser fallback to bypass payment, third-party-terms, or robots gates (NORTHSTAR §"What Counts As A True Miss"). Inoculation #2 binds: a 1.5× honest report ships; a 3.6× fabricated report does not.

## Review Checklist

Every PR closing a milestone should answer:

1. Which paper claim row in §"Status of Each Paper Claim" does this PR move from `partial`/`missing` to `shipped`?
2. Does it touch `src/orchestrator/run-planner.ts` (the single decision seam)?
3. Does it add a `tests/<milestone>-*.test.ts` that fails before the change and passes after?
4. Does it leave `grep -nE 'host === "[a-z]"' src/` at zero hits?
5. Does it update §"Status of Each Paper Claim" in this file in the same commit?
6. Does it preserve the agent-UX north star (≥ 2 calls, never 1; browser-open is failure mode)?
7. Does it survive the corresponding row of the `feedback_*.md` inoculation list?

If any answer is no, the PR is on a different plan.

## Open Questions

The plan makes three assumptions that can halt execution and that no
document currently resolves. Each is named here so the next agent
discovers them as plan-state, not as runtime surprise.

1. **94-domain corpus reproducibility.** §7.2 alone is underspecified (see P5). If the arXiv supplementary material is unavailable, the next agent must either: (a) transcribe the per-domain figures from the paper (§7.3 Figure 2 / §8.3.1) into the corpus header, or (b) declare a smaller honest corpus and amend §"Status" claim 1's evidence to reference the new sample size. The plan does NOT permit a quietly-different corpus.
2. **arXiv amendment process.** The honesty contingency assumes a signed amendment to arXiv:2604.00694 is reachable. If the arXiv account is unavailable, the substitute is a public errata note in this repo's `docs/paper-errata.md` linked from §"Status" evidence. Either way: never silently revise a status row.
3. **Multi-agent execution discipline.** The DAG assumes single-threaded milestone execution. If two agents run in parallel (e.g. P1 and P3 simultaneously), the composite-score interface breaks because P3's `verification(endpoint)` value is consumed by P2 which depends on P1's signal surface. Branch-name discipline (`feat/agent-ux-<milestone>`) is the only enforcement; future loops may add a `.planning/STATE.md` lock file.

## Done State

The paper is achieved when:

```bash
bash scripts/paper-benchmark.sh --warmed --corpus harness/corpus/paper-94.txt
```

emits a report whose mean speedup, median speedup, p50 latency, cold-start
median, breakeven count, and protected/unprotected split match arXiv
2604.00694v1 §7.3 / §7.4 / §8.3.1 within ±25 % (2.7× to 4.5× mean speedup
acceptable). The paper does not publish stdev, so a narrower band would
assert false precision; ±25 % is typical first-pass reproducibility for
browser benchmarks where network, anti-bot escalation, and infra drift
dominate noise. *And* every row in §"Status of Each Paper Claim" reads
`shipped`.

### Preflight

If the command above fails with file-not-found on `scripts/paper-benchmark.sh`
or `harness/corpus/paper-94.txt`, P5 has not yet shipped. The agent should:

1. Read §"Status of Each Paper Claim" — every `partial` or `missing` row points to the milestone still owed.
2. Check the recommended order in §"Execution Order + Dependencies" — P5 cannot run until P1–P4 + P7 are `shipped`.
3. Pick the lowest-numbered unshipped milestone and execute it, scoping a `.planning/phases/<NN>-<slug>/` PLAN.md.

The opaque `bash: scripts/paper-benchmark.sh: No such file or directory` is
informative only with this clause; without it the next agent guesses.

### Honesty contingency

If P5 reveals the warmed-cache mean speedup is materially below 3.6× (e.g.
< 2.7×, beyond the ±25 % band), the next agent must NOT adjust harness
parameters to reach the number. Instead:

1. Investigate corpus drift: `git log --since=<paper-date> -- src/`, identify regressions, file `.planning/phases/<NN>-paper-regression/` with the suspect commits.
2. Publish the revised numbers as a signed amendment to arXiv:2604.00694, noting environmental deltas (network, server changes, anti-bot escalation) — never silently revise the paper's claim row in §"Status of Each Paper Claim" without an `evidence` link to the amendment.
3. Retain all raw per-domain telemetry under `evals/paper-benchmark-<date>.raw.jsonl` so the next reader can reproduce the gap.

Inoculation #2 ("Never fake momentum") binds this section. A 1.5× honest
report ships; a 3.6× fabricated report does not.

This is what it means for "the paper to become the codebase."
