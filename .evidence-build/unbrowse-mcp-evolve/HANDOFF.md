# unbrowse-mcp-evolve wave-1 handoff

Built across one Jesus Loop session, `default`, 9 Genesis Days, by `/evidence-build` orchestrating `/jesus-loop:take-the-wheel` over Reddit-cited criteria.

## TL;DR

Branch `jl/unbrowse-mcp-evolve-wave1` carries 9 commits ready for human cherry-pick. Three of six in-scope lanes shipped clean substrate improvements that benefit the agent UX immediately; one lane shipped a unit-green dev-harness with documented integration blockers; two lanes deferred to wave-2 with named fix surfaces.

## What landed (substrate value, ready to cherry-pick onto main)

| Commit | Lane | What |
|---|---|---|
| `edf014f2` | lane-01 | `rankEndpoints` demotes scalar-only response_schema endpoints for `LIST_INTENT` (canonical: `/search/count` no longer outranks `/search/repositories`) |
| `28661bb6` | lane-05 (snap) | `unbrowse_snap` gains `detail_level: "minimal" | "summary" | "full"` (default minimal, under 1KB on Wikipedia/HN/error fixtures) |
| `e445f6b8` | lane-07 | `unbrowse_execute` and `unbrowse_reflect` emit `improvement_suggestion` on failed-intent responses, ledger-sourced, no fabrication |

These three improve every Claude Code agent that calls the local unbrowse MCP. Recommended cherry-pick order: `edf014f2` → `28661bb6` → `e445f6b8`.

## What landed (dev harness, ready to use locally)

| Commit | What |
|---|---|
| `59ba6531` | Day-3 Land: `.claude/mcps/unbrowse-workbench/` proxy MCP skeleton (mcp.json + bin/proxy.ts + framing/fanout/spawn + 3 ops scripts) |
| `58ac1d3b` | Day-4 Luminaries: 12 unit tests for framing + fanout + swap (real child processes, no mocks) |
| `987241f1` | Day-5 W5 structural_diff: real `_workbench_delta.diff.structural_diff_summary` (replaced "TODO") + 9 falsifier tests |
| `f333ddb1` | CHANGELOG restoration (cherry-pick collateral) |
| `e678a4cb` + `96054d86` | em-dash purge + executable bit restoration on `workbench-fetch-baseline.sh` |

The workbench tree is gitignored from `.claude/*` with `!.claude/mcps/` + `!.claude/mcps/**` exception so source-of-truth files track while jesus-loop session state stays per-developer. Tests pass cold: `bun test ./.claude/mcps/unbrowse-workbench/tests/` = 21 pass / 0 fail / 52 expects in ~340ms.

## What is HELD with documented rationale (deferred to wave-2)

| Lane | Why HELD | Fix surface |
|---|---|---|
| **lane-04** (AC3 drift-recapture) | Day-6 plan slot consumed by integration findings | `src/execution/index.ts:3789` near existing `detectSchemaDrift` call; add `recipe_replay_drift_recapture` step + headful one-shot re-capture |
| **lane-05 resolve half** (AC4 second half) | snap-side shipped; resolve-side not attempted | Copy-paste the `applySnapDetailLevel` pattern to `unbrowse_resolve` schema + handler |
| **lane-06 integration** (AC1 north-star integration) | Workbench unit-green but 3 integration blockers documented | (1) `workbench-fetch-baseline.sh` `git describe --match='v*' --exclude='*preview*' --exclude='*rc*'` so v6.16.0 picks; (2) propagate non-zero on Strategy A+B failure; (3) plan R6 mitigation: pre-spawn worktree-base verification |
| **lane-08** (AC6 mobile-android-fallback) | Plan declared OPTIONAL | New `tryMobileOrigin` step in capture-dispatcher seam BEFORE headful fallback |
| **W4 parseCommand shlex** | Worker correctly refused due to worktree base-fork | `.claude/mcps/unbrowse-workbench/src/spawn.ts:85` replace naive whitespace split with shlex-style state machine (single + double quote + backslash + unterminated throw) |

## How to use the workbench right now

1. Cherry-pick the workbench commits onto main (or stay on `jl/unbrowse-mcp-evolve-wave1`).
2. Build a baseline binary manually until Day-6 blocker 1 lands:
   ```bash
   git worktree add /tmp/baseline-v6.16.0 v6.16.0
   cd /tmp/baseline-v6.16.0 && bash scripts/build-binaries.sh
   mkdir -p .workbench-baseline/v6.16.0/
   cp dist/unbrowse-darwin-arm64 .workbench-baseline/v6.16.0/unbrowse
   chmod +x .workbench-baseline/v6.16.0/unbrowse
   ```
3. Register the workbench in Claude Code's `~/.claude.json` `mcpServers`:
   ```json
   {
     "unbrowse-workbench": {
       "command": "bun",
       "args": ["run", "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/.claude/mcps/unbrowse-workbench/bin/proxy.ts"],
       "env": {
         "UNBROWSE_BIN_CANDIDATE": "bun run /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/src/mcp.ts",
         "UNBROWSE_BIN_BASELINE": "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/.workbench-baseline/v6.16.0/unbrowse"
       }
     }
   }
   ```
4. Hot-swap during a Claude Code session: `kill -HUP $(pgrep -f 'unbrowse-workbench/bin/proxy.ts')`.
5. Run the smoke: `bash .claude/mcps/unbrowse-workbench/scripts/workbench-smoke.sh` to verify the swap end-to-end.

## How to start wave-2

Recommended single bounded task for next loop firing: **"clear the 3 Day-6 dominion blockers + ship AC3 (drift-recapture)"**. That sequence unlocks end-to-end workbench use against a real baseline, then lets the drift-recapture path be A/B tested in-session via the workbench itself (the whole point).

Specifically:
1. Inline edit `workbench-fetch-baseline.sh`: exclude preview tags, propagate non-zero exit.
2. Inline write `recipe_replay_drift_recapture` path + failing test in `src/execution/index.ts`.
3. Optional: ship W4 parseCommand shlex (small workbench-side commit).
4. Run workbench-smoke.sh against v6.16.0 baseline + the new CANDIDATE; observe `_workbench_delta` showing the drift-recapture branch firing on candidate and not on baseline.

## Evidence trail

- `.evidence-build/unbrowse-mcp-evolve/spec.yaml` — Reddit-cited product spec
- `.evidence-build/unbrowse-mcp-evolve/criteria.md` — 8 falsifiable lanes
- `.evidence-build/unbrowse-mcp-evolve/reddit-20260515T184112Z.jsonl` — 78 source threads
- `.evidence-build/unbrowse-mcp-evolve/convergence.jsonl` — pre-row + post-row, verdict CONVERGING
- `.bench-history/unbrowse-mcp-evolve-runs.jsonl` — bench evidence per lane
- `.claude/jesus-loop.default.plan.md` — the loop's plan (GOAL/NON-GOALS/ACs/RISKS/OUT-OF-SCOPE)
- `.claude/jesus-loop.default.firmament.md` — Day-2 architecture
- `.claude/jesus-loop.default.dominion.local.md` — Day-6 integration findings
- `.claude/jesus-loop.default.teachings.local.md` — per-day teachings
- `.claude/jesus-loop.default.grades.local.md` — per-step grades

## Hand-off note

I did NOT emit `<promise>SHIPPED</promise>` despite the completion-promise grammar being technically satisfiable by HELD-with-rationale. The substrate principle in `~/.claude/CLAUDE.md` and the project memory `feedback_no_fake_momentum.md` ("never overstate") both point at honesty over ceremony. The wave converged, did not complete. Lewis fires the next iteration when ready; the workbench will be the harness it runs against.
