# Release-Gate Bench Plan

Status: proposal — not yet built
Owner: Lewis
Last updated: 2026-05-12

## Problem

We keep shipping broken Unbrowse builds — MCP server, skill CLI, packaged
binary — to npm and to users. Every release post-mortem traces back to
the same root cause: there is no merge/release gate that judges whether
**indexing** and **execution retrieval** still work on a representative
corpus.

The existing benches do not gate, and the ones that try (`bench-two-phase`,
`bench-hard`, `bench-local`) classify results with deterministic heuristics
(`status_code == 200`, `has_available_operations > 0`, regex over response
bodies). That violates the project's standing rule:

> Harness collects, agent judges. Heuristic verdicts are leaven.
> (see `feedback_harness_makes_visible_agent_judges.md`, `feedback_no_heuristics_in_judge_jobs.md`)

So a bench whose verdict is computed by `if status_code == 200` is worse
than no bench — it gives false confidence and lets category errors
(captcha page returning HTTP 200, empty arrays, wrong-entity responses)
ship to main.

## Goals

1. **Indexing coverage** — for each probe, did capture surface ≥1 callable
   endpoint shaped like the intent?
2. **Execution retrieval accuracy** — when the agent picks the top-ranked
   endpoint and executes, does the **raw response body** actually contain
   what the intent asked for, for the entity in `contextUrl` (A8)?
3. **Verdict by LLM judge**, reading per-probe artifacts. No regex, no
   `status_code` shortcuts, no field-presence checks dressed up as success.
4. **Gate on release tag publication**, not on every PR. Failure blocks
   the GitHub release (and therefore npm publish — release-it chains them).

## Non-goals

- Not a UI/CLI ergonomics regression test (different harness).
- Not a per-PR gate. Mid-cycle src/ regressions can land on main; the gate
  catches them before any release leaves the building.
- Not a replacement for `bench-local` (dev iteration loop, kept) or
  `agent-experience` (in-thread dogfooding, kept).
- Not auto-ratcheting thresholds. We adjust pass floors manually as the
  product improves.

## Canonical base

`scripts/bench-two-phase.sh` is the closest existing harness:

- Already runs per-URL **capture phase** (indexing) + **execute phase**
  (retrieval) sequentially
- Already dumps full artifacts per URL: capture stdout, response body,
  signals, browser_block_signals
- 506 lines, in production, already debugged

It will be **forked**, not extended, because we are stripping its verdict
layer entirely. The functions to delete: `triage_bucket`, both `score`
functions, the `combined_verdict` column. After the fork lands and is
green, the original `bench-two-phase.sh` is deleted.

## Architecture

```
                    ┌─────────────────────────────────────┐
   release tag push │ .github/workflows/release-gate.yml  │
        (v*)        │                                     │
                    │ 1. spin up turbobox                 │
                    │ 2. npm i -g unbrowse@<tag>          │
                    │ 3. ./scripts/bench-gate.sh          │
                    │ 4. bun run bench-gate-judge         │
                    │ 5. parse verdict.json               │
                    │ 6. compute coverage ratios          │
                    │ 7. fail step if below threshold     │
                    └─────────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────┐
                    │ scripts/bench-gate.sh               │
                    │   for probe in corpus-gate.txt:     │
                    │     phase1: unbrowse capture ...    │
                    │       → capture.out, capture.meta   │
                    │     phase2: unbrowse resolve ...    │
                    │       → resolve.shortlist.json      │
                    │     phase2b: unbrowse execute ...   │
                    │       → execute.response.raw        │
                    │   write manifest.json (NO verdict)  │
                    └─────────────────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────┐
                    │ scripts/bench-gate-judge.ts         │
                    │   for each probe (batched 5x):      │
                    │     anthropic.messages.create({     │
                    │       system: GATE_JUDGE.md,        │
                    │         (prompt-cached)             │
                    │       user: probe artifact bundle,  │
                    │       model: claude-opus-4-7        │
                    │     })                              │
                    │   write verdict.json + verdict.md   │
                    └─────────────────────────────────────┘
```

## Corpus

`harness/probes/corpus-gate.txt` — **~50 probes, six explicit lanes**,
medium tier per Lewis's choice. Format:

```
lane | intent | contextUrl
```

Lane buckets and why each exists:

| Lane | Count | Purpose | Examples |
|------|-------|---------|----------|
| `anchor` | 10 | Must-pass baseline. Public APIs / SSR pages we have always handled. Regression here = ship-blocker. | HN top, npm pkg, crates.io search, GitHub repo search, Wikipedia article, MDN page, arXiv abstract, PyPI pkg, hub.docker tag, devto post |
| `semantic-rank` | 8 | A1/A8 entity substitution. Same captured template, different contextUrl entity. Catches the reddit r/singularity → r/programming bug. | reddit r/{sub}, github /{user}/{repo}, openlibrary /works/{id}, stackoverflow /questions/{id}, gitlab /{user}/{repo}, gitea repos |
| `graphql` | 6 | POST + `operationName` extraction. Catches X timeline regression. | x.com search, x.com home, x.com user, linkedin feed, threads timeline, instagram reels |
| `ssr-list` | 8 | Data-rich SSR pages where the page IS the data (page-artifact promotion). | amazon /s, bing /search, jup.ag swap, beatsaver search, pubmed search, hotels.com, priceline, ebay search |
| `auth-gated` | 8 | Expected to hand off gracefully (`next_step: open_browse_session`), not crash. Tests the failure-mode contract. | gmail, linkedin /feed, x /home (cold), jmail, notion, gdrive, figma file, slack |
| `hostile` | 10 | Expected `BROWSER_BLOCK` — vendor-shielded surfaces. Excluded from coverage denominator per existing bench-local rubric. | cloudflare-fronted, datadome, perimeterx, akamai_bot_manager, captcha vendors, kasada |

Lane drives the judge rubric branch. A `hostile` probe with `INDEX_PASS`
is suspicious (anti-bot honey-trap); a `hostile` probe with `BROWSER_BLOCK`
is expected and excluded from denominator.

## Per-probe artifacts (what bench-gate.sh writes)

```
.bench-gate/<run-id>/
  manifest.json             ← top-level: probes[], cli_version, kuri_version, started_at
  <probe-id>/
    capture.out             ← full stdout of `unbrowse capture` (raw, untruncated)
    capture.meta.json       ← derived signals (filter_rejections, browser_block_signals,
                              total_endpoints_captured, n_operations, captured_title)
    capture.html.excerpt    ← first 8KB of captured HTML (judge reads this to detect
                              captcha pages disguised as HTTP 200)
    resolve.shortlist.json  ← `unbrowse resolve --intent X --url Y` full JSON,
                              including evidence per candidate
    resolve.pick.json       ← top-1 endpoint_id + score + reasoning
    execute.out             ← full stdout of `unbrowse execute --raw <id>`
    execute.response.raw    ← raw response body, uncapped, NO extraction
    execute.meta.json       ← status_code, response_bytes, decision_trace
    timings.json            ← per-phase duration ms
```

**No `verdict` field anywhere.** The verdict is computed externally by
the judge, persisted to `verdict.json`, kept in a sibling directory so
re-judging on the same artifacts is cheap.

## Judge rubric (`harness/probes/GATE_JUDGE.md`)

Two phase judgments per probe. Each emits one verdict from a fixed
enum + free-form `reasoning` (3-5 sentences quoting specific artifact
content).

### Phase 1 — Indexing verdict

Read `capture.meta.json` + `capture.html.excerpt` + lane.

| Verdict | Condition |
|---------|-----------|
| `INDEX_PASS` | At least one captured endpoint has a URL + sample shape consistent with the intent. Judge quotes the URL + ≥1 sample field. |
| `INDEX_FAIL_NO_ENDPOINTS` | `total_endpoints_captured == 0` and lane is not `hostile`/`auth-gated`. Includes the case where filter_rejections ate everything real. |
| `INDEX_FAIL_WRONG_SHAPE` | Endpoints captured but none match the intent (e.g. only telemetry/config XHRs). Judge must name what was captured vs what was missing. |
| `INDEX_EXCLUDED_BLOCKED` | `browser_block_signals` contains a vendor tag or `challenge_title`. Excluded from denominator. |
| `INDEX_EXCLUDED_AUTH` | Lane is `auth-gated` AND capture returned a usable handoff (`next_step` present). Excluded — this is the success mode for that lane. |

### Phase 2 — Retrieval verdict

Read `resolve.shortlist.json` + `resolve.pick.json` + `execute.response.raw` + lane.

| Verdict | Condition |
|---------|-----------|
| `RETRIEVE_PASS` | Response body contains the content the intent asked for, for the right entity from contextUrl. Judge quotes ≥1 concrete data field from the response. |
| `RETRIEVE_FAIL_WRONG_ENTITY` | Response is well-shaped but for the wrong entity (A8 regression). E.g. intent says r/singularity, response is r/programming. |
| `RETRIEVE_FAIL_EMPTY` | Response is structurally valid but empty (e.g. `{items:[]}`) when the page clearly had content. |
| `RETRIEVE_FAIL_WRONG_SHAPE` | Response is config/telemetry/feature-flags, not the data the intent asked for. |
| `RETRIEVE_FAIL_ERROR_BODY` | Response is a captcha page, error JSON, auth wall, or 200-with-error-body. |
| `RETRIEVE_EXCLUDED_BLOCKED` | Same as INDEX_EXCLUDED_BLOCKED. |
| `RETRIEVE_EXCLUDED_AUTH` | Same as INDEX_EXCLUDED_AUTH. |

The judge MUST quote response content. A verdict without a quote from
`execute.response.raw` is rejected and re-run.

### Coverage ratios

```
indexable_total    = total - INDEX_EXCLUDED_*
retrievable_total  = total - RETRIEVE_EXCLUDED_*

index_coverage     = count(INDEX_PASS) / indexable_total
retrieve_coverage  = count(RETRIEVE_PASS) / retrievable_total
```

Initial floors (set from current bench-local pass rates — confirm at
build time, not pinned now):

- `index_coverage ≥ 0.75`
- `retrieve_coverage ≥ 0.65`

Ratchet upward at each green release. Never lower except via explicit
commit + PR description explaining why.

## Judge runtime (`scripts/bench-gate-judge.ts`)

- Anthropic SDK direct (per `claude-api` skill — prompt caching enabled
  on the system prompt = `GATE_JUDGE.md`)
- Model: `claude-opus-4-7`
- Batch: 5 probes in flight at once (asyncio semaphore equivalent)
- Per-probe prompt: lane + intent + contextUrl + all 7 artifact files
  inlined as fenced blocks
- Response: structured JSON via tool-use (`emit_verdict` tool with
  `index_verdict`, `index_reasoning`, `retrieve_verdict`, `retrieve_reasoning`)
- Retries: 1 retry on rate-limit; 1 retry if the response omits a quote
  from `execute.response.raw`
- Outputs:
  - `.bench-gate/<run-id>/verdict.json` — machine-readable
  - `.bench-gate/<run-id>/verdict.md` — human summary, table per lane, top 5 failures with quoted reasoning
- Cost target: ≤ $10 per release. ~50 probes × 1 Opus call each, with
  the system prompt cached, lands at $5-8 in practice.

## CI workflow (`.github/workflows/release-gate.yml`)

Triggers: `push: tags: ['v*']`

Steps:

1. Checkout repo at tag
2. Provision turbobox (existing pattern from `scripts/agent-experience-test.sh`)
3. `npm i -g unbrowse@<tag>` on remote (wait for npm to propagate, 60s
   timeout with retry)
4. SSH-run `bash scripts/bench-gate.sh --corpus harness/probes/corpus-gate.txt --out /tmp/.bench-gate`
5. `rsync` artifacts back to runner
6. `bun run bench-gate-judge -- --artifacts .bench-gate/<run-id>` with
   `ANTHROPIC_API_KEY` from secrets
7. Parse verdict.json. Compute coverage ratios.
8. If either ratio below floor → `exit 1` with markdown summary in step
   output
9. Upload `.bench-gate/<run-id>/` as workflow artifact (10-day retention)
10. On success: post `verdict.md` as a comment on the GitHub release
11. On failure: workflow status check blocks the release (release-it's
    GitHub release publish requires this check to be green)

### Escape hatch

A human can manually publish the GitHub release with the failed check
visible. This is intentional — silent escapes are banned, visible escapes
are fine. The failed check stays attached to the release for the audit
trail.

## Deprecation plan

Done in a **separate PR after the gate is green for 2 consecutive releases**:

| File | Action | Why |
|------|--------|-----|
| `scripts/bench-two-phase.sh` | delete | Replaced by `bench-gate.sh` |
| `harness/probes/bench-hard.sh` | audit, likely delete | Heuristic verdict; redundant with gate |
| `harness/probes/cold-start-bench.sh` | audit | May be unique |
| `harness/probes/coverage-harness.sh` | audit | Likely redundant |
| `harness/probes/ralph-bench-loop.sh` | audit | Was for ralph autonomous loop |
| `harness/probes/benchmark-historical.sh` | keep | Time-series, different purpose |
| `harness/probes/benchmark-over-time.sh` | keep | Time-series, different purpose |
| `harness/probes/turbobox-bench.sh` | audit | May fold into gate |
| `harness/probes/benchmark-turbobox-parallel.sh` | audit | May fold into gate |
| `harness/probes/test_bench_classifier.py` | delete | Tested heuristics that no longer exist |
| `harness/probes/bench-*-triage.py` | delete | Heuristic classifiers |
| `harness/probes/bench-local.sh` | **keep** | Dev iteration loop, single-machine, fast |
| `harness/probes/agent-experience.sh` | **keep** | In-thread agent dogfooding, different purpose |

## Build order

1. `harness/probes/corpus-gate.txt` + `harness/probes/GATE_JUDGE.md`
   *(cheap, defines the contract; review before any code lands)*
2. `scripts/bench-gate.sh` *(fork bench-two-phase, strip heuristics,
   write the artifact layout above)*
3. `scripts/bench-gate-judge.ts` *(the new piece — Anthropic SDK
   per-probe loop, structured tool-use response, verdict.{json,md} output)*
4. Manual end-to-end run on remote turbobox; iterate on judge prompt
   until verdicts are stable across 3 re-judges of the same artifacts
5. `.github/workflows/release-gate.yml` + secrets wired
6. One dry-run release with the gate non-blocking (warn-only); fix any
   surprises
7. Flip the gate to blocking
8. Deprecation PR (2 releases later)

## Invariants

These are non-negotiable. If a future change would violate one, revert
and revisit the plan:

- **No heuristic verdicts.** `bench-gate.sh` never writes a verdict field.
- **No `status_code` shortcut.** Judge MUST read response body content.
- **Judge MUST quote.** Verdicts without a concrete quote from the artifact
  are rejected.
- **Lane drives rubric.** Hostile-lane PASS is suspicious, not celebrated.
- **Visible escape hatches.** Manual release override is allowed, failed
  check stays visible.
- **Coverage denominator excludes BROWSER_BLOCK + AUTH_GATED.** Matches
  existing bench-local rubric in CLAUDE.md.
- **Floors never silently lower.** Lowering a floor requires PR + reason.

## Open questions

- **Threshold floors at build time** — current bench-local pass rate
  should set the initial floor. Read the most recent green
  `.bench-local/results.jsonl` when building the workflow file.
- **Two-tier pre-filter?** Rejected for v1 (pure agent-judged). Revisit
  only if cost ≥ $15/release or if Opus is mis-classifying obvious
  hostile-lane probes.
- **Judge model choice** — Opus 4.7 for v1. Sonnet 4.6 if cost is an
  issue; revisit with stability data, not a priori.
- **Frequency outside release tags** — should the gate also run nightly
  on `main` to catch regressions before someone cuts a tag? Probably yes,
  as a separate workflow that posts to Slack but doesn't block anything.
  Out of scope for v1.
