# Release-gate bench — agent-judged regression gate

The release-gate bench prevents agent-experience regressions in indexing,
retrieval, and execution accuracy. It is **agent-judged**: the harness
collects raw artifacts, an LLM judge renders per-probe verdicts, and a
deterministic compare step diffs those verdicts against a frozen baseline
to render a single PASS/FAIL.

This follows CLAUDE.md "harness collects, agent judges" — no regex/grep
verdicts; the gate is a deterministic floor *over* agent judgment.

## Pieces

| File | Role |
|------|------|
| `harness/probes/corpus-gate.txt` | 50-probe corpus, 6 lanes (anchor, semantic-rank, graphql, ssr-list, auth-gated, hostile) |
| `harness/probes/GATE_JUDGE.md` | Rubric the judge LLM follows; INDEX_* + RETRIEVE_* verdict enum |
| `harness/probes/bench-gate-baseline.json` | Frozen baseline + thresholds |
| `scripts/bench-gate.sh` | Phase 1: collect per-probe capture / resolve / execute artifacts |
| `scripts/bench-gate-judge.ts` | Phase 2: shells out to `claude -p --bare` (the Claude Code agent itself) for per-probe verdicts |
| `scripts/bench-gate-compare.ts` | Phase 3: deterministic gate over judged verdicts |
| `scripts/bench-gate-full.sh` | Orchestrator: runs phases 1-3 |
| `.github/workflows/bench-gate.yml` | CI runs on PR label `run-bench-gate`, manual, and post-release |

## Phases

```
corpus-gate.txt
     │
     ▼
[bench-gate.sh] ── per-probe artifacts (capture.out, resolve.shortlist.json, execute.response.raw, ...)
     │             NO verdicts. Zero heuristics.
     ▼
[bench-gate-judge.ts] ── verdict.json (per-probe INDEX_* + RETRIEVE_*)
     │                   LLM reads artifacts, renders verdict per GATE_JUDGE.md
     ▼
[bench-gate-compare.ts] ── gate.json + gate.md (PASS/FAIL + delta vs baseline)
                          Deterministic threshold + per-probe regression check
```

## Verdicts

The judge emits one of:

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

This stamps `baseline_run`, `baseline_cli_version`, `baseline_frozen_at`,
and `per_probe_baseline` from the latest verdict. The per-probe map is the
PASS→FAIL regression check: any baselined PASS that flips to FAIL fails
the gate, even if global coverage holds.

## How to run

The judge is the **Claude Code agent itself** (`claude -p --bare ...`), not a
raw Anthropic API call. The `claude` CLI must be on PATH and authed.

```bash
# Local: full pipeline (claude CLI handles its own auth — no env var)
bun run bench:gate:full

# Local: harness only (no judge, no compare) — useful for iterating on the corpus
bun run bench:gate

# Local: judge an existing run dir
bun run bench:gate:judge --artifacts .bench-gate/<run-id>

# Local: compare an existing run dir vs baseline
bun run bench:gate:compare --artifacts .bench-gate/<run-id>

# Local: compare in soft mode (no non-zero exit)
bun run bench:gate:compare --artifacts .bench-gate/<run-id> --soft

# Local: freeze current run as the new baseline
bun run bench:gate:freeze --artifacts .bench-gate/<run-id>

# Local: dry-run judge (stub verdicts, no agent call) — for harness↔compare contract testing
bash scripts/bench-gate-full.sh --dry-run-judge --soft

# Override the judge model (default: sonnet)
bun run bench:gate:judge --artifacts .bench-gate/<run-id> --model opus

# Override the claude binary path
bun run bench:gate:judge --artifacts .bench-gate/<run-id> --claude-bin /usr/local/bin/claude
```

## CI wiring

- **PRs** — add the `run-bench-gate` label to trigger; runs in **soft** mode
  (comment-only, never blocks merge). Marker `<!-- bench-gate -->`.
- **Manual** — `gh workflow run bench-gate.yml -f mode=strict -f limit=0`.
- **Post-release** — `workflow_run` after `Release` completes. Runs **strict**;
  files a `bench-gate-regression` issue on FAIL.

## Release flow

`bash scripts/release-and-verify.sh --bench-gate` (or `RUN_BENCH_GATE=1
bun run release:preview`) runs the gate locally before cutting the tag.
The CI workflow runs it again post-release on the published npm CLI as a
backstop; if both you and CI skipped it, the worst case is a regression
ships and the post-release workflow files an issue against the new version.

Default `bun run release:preview` does NOT run the bench-gate, since it
costs credits + ~10 minutes wall-clock. Opt in deliberately.

## Why no global lockstep

The per-probe baseline freezes PASS verdicts only. We don't lockstep FAIL
verdicts — if a probe was FAIL last run and is now PASS, that's an
improvement, not a regression. The compare script doesn't enforce
symmetric behavior; only PASS→FAIL is a regression.

## Anti-patterns this avoids

- **Status-code verdicts** — `status_code == 200` doesn't mean the agent
  got useful data. Captcha pages return 200. Judge reads the body.
- **Per-host registries** — no `if (host === "amazon.com")` arms in the
  rubric. The judge reads response shape against intent.
- **Heuristic classifiers** — no regex / grep / awk PASS/FAIL on
  unstructured artifacts. The judge is an LLM with structured tool output.
- **Test-author tautology** — the corpus + judge prompt + baseline are
  in one place; the compare script reads them. Never asserts hardcoded
  expected strings against production output.

## Operational notes

- The 50-probe corpus runs in ~10-15 min on a warm machine with `bun src/cli.ts`.
- Judge invocation: `claude -p --bare --system-prompt <GATE_JUDGE.md> --json-schema <verdict> --output-format json --model sonnet`. Default model is `sonnet`; override with `--model opus` if needed.
- Artifacts retain `verdict.md` (judge tally) + `gate.md` (gate decision)
  so a human reading post-mortem can see both layers independently.
- Hostile-lane PASS is flagged `suspicious: true` and surfaced in
  `gate.md`'s "New hostile-lane PASS" section; review before celebrating.
