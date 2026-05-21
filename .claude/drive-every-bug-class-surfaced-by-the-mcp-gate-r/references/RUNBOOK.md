# Benchmax loop runbook

The autonomous loop for driving the MCP bench-gate to `gate.passed=true`.
Each phase has one script; one `harness iterate` call runs the whole chain.

## One-shot usage

```bash
bash ~/.claude/skills/meta-harness/scripts/harness iterate \
  drive-every-bug-class-surfaced-by-the-mcp-gate-r
```

That single command runs:

1. `scripts/measure.sh` - fire a fresh bench-gate run if the latest is
   older than `UNBROWSE_BENCH_MAX_AGE_MIN` (default 120 min), else reuse.
2. `scripts/auto-classify.sh` - structural verdict.json from per-probe
   artifacts (no LLM, no agent in the loop; rough cut).
3. `bench-gate-compare.ts` - gate.json verdict via deterministic threshold
   check.
4. Per-probe delta vs prior run, ledger row append.
5. `scripts/ship.sh` - if `gate.passed=false`, surface top-N blockers each
   with a ready-to-run `harness build "<plan>"` command.

## The autonomous /loop

For sustained convergence (run a wave, judge, ship a fix, re-bench,
repeat), wrap it in `/loop`:

```
/loop bash ~/.claude/skills/meta-harness/scripts/harness iterate drive-every-bug-class-surfaced-by-the-mcp-gate-r && bash ~/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/.claude/drive-every-bug-class-surfaced-by-the-mcp-gate-r/scripts/ship.sh
```

The agent in-thread:

1. Reads ship.sh output (top blockers + suggested `harness build`).
2. Judges which blocker matches a known scoped fix shape.
3. Either runs `harness build "<plan>"` and ships the fix in an isolated
   worktree (via the canonical `harness-session.sh spawn` flow) OR moves
   on if the blocker needs a multi-file refactor that's out of scope.
4. Re-iterates this harness to measure delta.

## Substrate principle (load-bearing)

This loop runs by surfacing evidence, never by baking a verdict:

- `measure.sh` collects; does not classify.
- `auto-classify.sh` writes a STRUCTURAL rough cut; the agent overrides
  per-probe in-thread when the qualitative truth differs from the
  bucket. Agent judgment is load-bearing.
- `bench-gate-compare.ts` is the only deterministic verdict (threshold
  + per-probe regression check), and even that just reads the
  agent-overridden verdict.json when present.
- `ship.sh` SURFACES top-N candidates each with a fix-shape hint and a
  ready-to-run command. The agent picks; the script never picks.

## Env knobs

| Env | Default | Effect |
|---|---|---|
| `UNBROWSE_BENCH_MAX_AGE_MIN` | 120 | Reuse latest run if younger than N minutes |
| `UNBROWSE_BENCH_CONCURRENCY` | 1 | Collector worker pool; raise to 4-6 only with isolation confidence |
| `UNBROWSE_BENCH_PROBE_TIMEOUT_MS` | 90000 | Per-probe ceiling |
| `UNBROWSE_BENCH_FORCE` | 0 | Force fresh run even if latest is fresh |
| `UNBROWSE_BENCH_SKIP_MEASURE` | 0 | Skip phase 1 in verify.sh; reuse latest |
| `UNBROWSE_BENCH_SKIP_CLASSIFY` | 0 | Skip phase 2 in verify.sh; keep existing verdict.json |
| `UNBROWSE_SHIP_TOP_N` | 3 | How many blocker candidates ship.sh surfaces |
| `UNBROWSE_NEXT_BLOCKER_LIMIT` | 5 | How many rows next-blocker.sh emits |

## Cycle-4 cross-contamination note

Bench at `UNBROWSE_BENCH_CONCURRENCY>1` produced session
cross-contamination (2026-05-21 cycle-4: probe 002 npmjs's snap landed
on `saiful.pages.dev/tasks` instead of `npmjs.com` at conc=2). The
default is conc=1 until kuri's per-session isolation gets a falsifier
that proves >1 is safe. The agent JUDGES whether to raise concurrency
for speed at the cost of isolation; do not auto-raise.

## Fix-shape taxonomy (suggested by next-blocker.sh)

| Fix-shape | Trigger signal | Target |
|---|---|---|
| `kuri-stability` | `crashed_during_collect` / `empty_snapshot` in browser_block_signals | submodules/kuri, vendor bundle |
| `kuri-session-isolation` | `iso_self_check.host_match: false` | per-broker isolation in src/api/browse-session.ts |
| `extractor-missed-signal-in-rich-html` | `INDEX_FAIL_NO_ENDPOINTS` with `dom_html_size>10KB` | src/extraction/index.ts |
| `capture-empty-dom` | `INDEX_FAIL_NO_ENDPOINTS` with small DOM | capture pipeline / SSR-only handling |
| `ranker-or-extractor-junk-shape` | `RETRIEVE_FAIL_WRONG_SHAPE` | extraction junk-shape gates, ranker demotions |
| `ranker-intent-overlap` | `RETRIEVE_FAIL_WRONG_ENTITY` | intent-vs-entity overlap scoring |
| `execute-returned-error-page` | `RETRIEVE_FAIL_ERROR_BODY` | drift recovery, page-fetch fallback |
| `extraction-produced-empty` | `RETRIEVE_FAIL_EMPTY` | tiny-extraction fallthrough |

Each shape suggests a target file region; the agent confirms by reading
the probe's `capture.html.excerpt` + `execute.response.raw` before
shipping a fix.

## Failure modes + recovery

| Symptom | Cause | Fix |
|---|---|---|
| `measure.sh` exits 1, "no prior manifest found" | First run on this branch with no `.bench-gate/*/manifest.json` | Copy `harness/probes/corpus-gate.txt` into a manifest via `scripts/bench-gate-mcp.sh` first |
| `verify.sh` exits 1, "gate.json missing" | `bench-gate-compare.ts` failed | Check `logs/wave-compare.log`; usually missing baseline or malformed verdict.json |
| `auto-classify.sh` returns all FAIL despite real data | Classifier rubric mismatch with new artifact shape | Read `capture.meta.json` of a known-good probe and update the rubric in `auto-classify.sh` |
| Bench never advances | Same regression keeps surfacing | The fix-shape suggestion needs human review; an out-of-scope refactor is needed |
