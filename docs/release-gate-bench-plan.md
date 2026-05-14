# Release-gate bench — agent-judged regression gate

The release-gate bench prevents agent-experience regressions in indexing,
retrieval, and execution accuracy. It is **agent-judged**: the harness
collects raw artifacts and prints a consolidated bundle; the agent
running the harness (Claude Code in-thread) reads the bundle and renders
per-probe verdicts; a deterministic compare step diffs those verdicts
against a frozen baseline.

This follows CLAUDE.md "harness collects, agent judges" and memory
`feedback_harness_makes_visible_agent_judges.md` — no LLM subprocess,
no API call, no token. The agent that ran the harness is the judge.

## Pieces

| File | Role |
|------|------|
| `harness/probes/corpus-gate.txt` | 50-probe corpus, 6 lanes (anchor, semantic-rank, graphql, ssr-list, auth-gated, hostile) |
| `harness/probes/GATE_JUDGE.md` | Rubric the agent applies; INDEX_* + RETRIEVE_* verdict enum |
| `harness/probes/bench-gate-baseline.json` | Frozen baseline + thresholds |
| `scripts/bench-gate.sh` | Phase 1: collect per-probe capture / resolve / execute artifacts |
| `scripts/bench-gate-judge.ts` | Phase 2/4: prep `judge.bundle.md` + `verdict.template.json` for the agent; validate the agent-written `verdict.json` |
| `scripts/bench-gate-compare.ts` | Phase 5: deterministic gate over agent-judged verdicts |
| `scripts/bench-gate-full.sh` | Orchestrator: runs phases 1+2, stops, prints what the agent must do |
| `.github/workflows/bench-gate.yml` | CI runs phases 1+2 only; uploads artifacts; comments review-required pointer |

## Phases

```
corpus-gate.txt
     │
     ▼
[bench-gate.sh] ── per-probe artifacts (capture.out, resolve.shortlist.json, execute.response.raw, ...)
     │             NO verdicts. Zero heuristics.
     ▼
[bench-gate-judge.ts] ── judge.bundle.md + verdict.template.json
     │                   Prep only. No LLM call. The script writes a
     │                   consolidated markdown the agent reads.
     ▼
[ agent in-thread ] ── reads judge.bundle.md, writes verdict.json per the rubric
     │
     ▼
[bench-gate-judge.ts --validate] ── schema check on the agent's verdict.json
     │
     ▼
[bench-gate-compare.ts] ── gate.json + gate.md (PASS/FAIL + delta vs baseline)
                          Deterministic threshold + per-probe regression check
```

## Why no LLM subprocess

Earlier iterations of this gate called `claude -p` or `@anthropic-ai/sdk`
under the hood. That was wrong:

1. It made CI pretend to render verdicts without an agent present, which
   defeats the "harness makes visible, agent judges" principle.
2. It added an auth-token dependency (OAuth / API key) the harness should
   not have.
3. It hid the rubric application inside a black-box subprocess instead of
   producing inspectable, agent-written verdict reasoning.

Now: the agent who runs `bun run bench:gate:full` reads `judge.bundle.md`
in the same conversation and writes `verdict.json` directly. The bundle
includes the rubric inline, every probe's artifacts inline, and the
verdict JSON schema inline. The agent's reasoning is preserved in
`verdict.json` (`index_reasoning`, `retrieve_reasoning`, `evidence_quote`).

## Verdicts

The agent emits one of:

**Indexing:**
- `INDEX_PASS` — captured at least one endpoint whose URL + sample shape match the intent
- `INDEX_FAIL_NO_ENDPOINTS` — capture returned 0 endpoints (or filter ate everything real)
- `INDEX_FAIL_WRONG_SHAPE` — endpoints captured but none matched the intent (telemetry/config only)
- `INDEX_EXCLUDED_BLOCKED` — hostile-lane block (vendor tag); excluded from denominator
- `INDEX_EXCLUDED_AUTH` — auth-gated handoff; excluded from denominator

**Retrieval (covers execution accuracy):**
- `RETRIEVE_PASS` — execute response contains content for the right entity, with concrete data quoted
- `RETRIEVE_FAIL_WRONG_ENTITY` — A8 regression; right template, wrong entity
- `RETRIEVE_FAIL_EMPTY` — structurally valid but empty
- `RETRIEVE_FAIL_WRONG_SHAPE` — config / telemetry / feature flags returned instead of data
- `RETRIEVE_FAIL_ERROR_BODY` — captcha / error JSON / auth wall / 200-with-error
- `RETRIEVE_EXCLUDED_BLOCKED` / `RETRIEVE_EXCLUDED_AUTH` — same exclusion rules as INDEX

## Thresholds (baseline)

`harness/probes/bench-gate-baseline.json`:

```json
{
  "thresholds": {
    "index_coverage_min": 0.80,
    "retrieve_coverage_min": 0.65,
    "anchor_must_pass": true,
    "max_new_suspicious_hostile": 0
  }
}
```

- `index_coverage_min` — `count(INDEX_PASS) / count(indexable)` floor
- `retrieve_coverage_min` — `count(RETRIEVE_PASS) / count(retrievable)` floor (lower than index because retrieval is the harder downstream signal)
- `anchor_must_pass` — every anchor-lane probe must be `*_PASS` or `*_EXCLUDED_*`; anchors are non-negotiable
- `max_new_suspicious_hostile` — new hostile-lane `*_PASS` is a yellow flag (anti-bot honey-trap risk), held at 0 by default

Adjust thresholds + freeze per-probe baselines after a clean canonical run:

```bash
bun run bench:gate:freeze --artifacts .bench-gate/<latest-run-id>
```

## How to run (agent, in a Claude Code conversation)

```bash
# 1. Collect artifacts + prep the judge bundle. Stops at "agent judge required".
bun run bench:gate:full

# 2. Read the bundle (in this Claude Code conversation, via Read tool):
#       .bench-gate/<run-id>/judge.bundle.md
#    Apply the rubric verbatim from GATE_JUDGE.md.

# 3. Write the agent verdict (Write tool):
#       .bench-gate/<run-id>/verdict.json
#    Schema:
#       { "run_id": "<run-id>", "verdicts": [{ probe_id, index_verdict, index_reasoning,
#         retrieve_verdict, retrieve_reasoning, evidence_quote, suspicious }, ...] }

# 4. Validate the schema before comparing.
bun run bench:gate:judge -- --artifacts .bench-gate/<run-id> --validate

# 5. Compare vs baseline; non-zero exit on regression.
bun run bench:gate:compare -- --artifacts .bench-gate/<run-id>

# Optional: --soft never exits non-zero
bun run bench:gate:compare -- --artifacts .bench-gate/<run-id> --soft

# Optional: freeze this verdict as the new baseline
bun run bench:gate:freeze -- --artifacts .bench-gate/<run-id>

# Optional: dry-run (stub verdicts, no agent step) — for harness↔compare contract tests
bash scripts/bench-gate-full.sh --dry-run-judge --soft
```

## CI wiring

CI **does not auto-judge**. It collects artifacts, preps the bundle,
uploads everything, and comments a review-required pointer on the PR.
An agent picks up the artifact locally, judges in-thread, runs validate
+ compare, then commits the resulting `gate.md` back to the PR.

- **PRs** — add the `run-bench-gate` label to trigger collection.
  Marker `<!-- bench-gate -->`.
- **Manual** — `gh workflow run bench-gate.yml -f limit=0`.
- **Post-release** — `workflow_run` after `Release` completes; same
  collect-and-comment behavior on whatever ref the release ran on.

The decision to ship/hold a release is the agent's, not CI's.

## Release flow — bench-gate is a release-it hook

The bench-gate is wired as a **`release-it` `before:init` hook**:
`.release-it.json` runs `scripts/bench-gate-prerelease.sh` before any
version bump or tag is created. The hook does NOT run the gate itself
(the agent must, since the agent is the judge); it verifies a fresh
**stamp** exists for the current code state and refuses to start the
release if not.

### Stamp protocol

After a successful agent-judged gate run, the agent commits
`.bench-gate/stamp.json`:

```json
{
  "schema_version": 1,
  "commit_sha": "<git rev-parse HEAD at the time the gate passed>",
  "run_id": "<bench-gate run id>",
  "gate_passed": true,
  "stamped_at": "<ISO timestamp>",
  "index_coverage": 0.92,
  "retrieve_coverage": 0.75,
  "artifact_dir": ".bench-gate/<run-id>"
}
```

The stamp is emitted by `bun run bench:gate:compare -- --stamp`. The
flag only writes the stamp on PASS; FAIL never produces a stamp.

### What the prerelease hook checks

The hook PASSes only when ALL of the following hold:

1. `.bench-gate/stamp.json` exists with `gate_passed: true`
2. No uncommitted changes to gate-affecting paths: `src/`,
   `packages/sdk/`, `harness/probes/corpus-gate.txt`,
   `harness/probes/GATE_JUDGE.md`,
   `harness/probes/bench-gate-baseline.json`
3. EITHER stamp.commit_sha == HEAD, OR no gate-affecting paths changed
   between stamp.commit_sha and HEAD. Docs-only changes since the stamp
   are allowed — they cannot regress capability.

### Full release flow

```bash
# 1. Agent runs the bench harness + judges + compares + stamps
bun run bench:gate:full
# (agent reads judge.bundle.md, writes verdict.json in-thread)
bun run bench:gate:validate -- --artifacts .bench-gate/<run-id>
bun run bench:gate:compare -- --artifacts .bench-gate/<run-id> --stamp

# 2. Commit the stamp
git add .bench-gate/stamp.json
git commit -m "chore: bench-gate stamp"

# 3. release-it now sees the stamp and runs
bun run release:preview
```

### Bypass (deliberate, audited)

`BENCH_GATE_BYPASS=1 bun run release` skips the prerelease check with a
loud stderr warning. Use only for emergencies; never in CI; document in
CHANGELOG why the release wasn't gated.

`bash scripts/release-and-verify.sh --bench-gate` is the legacy opt-in
helper that runs `bench:gate:full` then exits, expecting the agent to
judge + stamp + retry. The release-it hook is the canonical gate now.

## Why no global lockstep

The per-probe baseline freezes PASS verdicts only. We don't lockstep FAIL
verdicts — if a probe was FAIL last run and is now PASS, that's an
improvement, not a regression. The compare script doesn't enforce
symmetric behavior; only PASS→FAIL is a regression.

## Anti-patterns this avoids

- **Status-code verdicts** — `status_code == 200` doesn't mean the agent
  got useful data. Captcha pages return 200. The agent reads the body.
- **Per-host registries** — no `if (host === "amazon.com")` arms in the
  rubric. The agent reads response shape against intent.
- **Heuristic classifiers** — no regex / grep / awk PASS/FAIL on
  unstructured artifacts. The verdict is the agent's written reasoning.
- **LLM-subprocess "automation"** — a hidden `claude -p` invocation
  pretends an agent judged when no agent was present. Removed in favor
  of explicit in-thread judging.
- **Test-author tautology** — the corpus + judge prompt + baseline are
  in one place; the compare script reads them. Never asserts hardcoded
  expected strings against production output.

## Operational notes

- The 50-probe corpus runs in ~10-15 min on a warm machine with `bun src/cli.ts`.
- Artifacts retained: `judge.bundle.md` (what the agent read), `verdict.json`
  (what the agent wrote, including reasoning + evidence quotes),
  `gate.md` (the deterministic comparison output). Together these are a
  full audit trail of one release-gate decision.
- Hostile-lane PASS is flagged `suspicious: true` and surfaced in
  `gate.md`'s "New hostile-lane PASS" section; review before celebrating.
