# Bench-Gate (MCP-driven, subagent fan-out)

The release gate measures what a real agent actually does when it talks to
unbrowse over MCP — empty index, full browse + index + publish + retrieve +
execute loop, repeated N times per probe so stability is observable, not
inferred from one-shot luck.

This document describes the new `bench:gate:mcp` flow. The old `bench:gate`
(one-shot `unbrowse capture` CLI call per probe) remains available, but it
does not exercise the MCP surface and does not measure cache stability.

## Why

The previous gate ran one `unbrowse capture` per probe — a single CLI
shortcut that conflates browse + index + publish into one call. It does
not exercise:

- The MCP transport (`mcp__unbrowse__*` tools that real agents call)
- The empty-index → discovery → publish → re-resolve loop
- Repeated iteration to catch flakiness (cache hits, race conditions,
  Kuri restart resilience)

The MCP gate runs each probe through an LLM subagent that drives the
full pipeline through MCP, repeats it N times (default 3), and reports
per-iteration outcomes. The parent agent reads consolidated results and
judges the run.

## Pipeline shape

```
scripts/bench-gate-mcp.sh           — prep (wipes index + writes per-probe prompts)
        │
        ▼
parent agent fans out N Agent tool calls (one per probe)
        │  each subagent uses ONLY mcp__unbrowse__* tools to run the loop
        │  iterations:
        │    1. unbrowse_resolve   (verify empty)
        │    2. unbrowse_go        (open session)
        │    3. unbrowse_snap/eval (load + interact if needed)
        │    4. unbrowse_close     (triggers index + publish)
        │    5. unbrowse_resolve   (verify published skill resolves)
        │    6. unbrowse_execute   (raw, verify response shape)
        │  writes subagent.result.json with {iterations[], stability, summary}
        ▼
scripts/bench-gate-mcp-collect.ts    — sweep per-probe results into verdict.json
        │
        ▼
scripts/bench-gate-judge.ts --validate — schema-check the verdict
        │
        ▼
scripts/bench-gate-compare.ts --stamp — compare vs baseline + write stamp.json
        │
        ▼
git add .bench-gate/stamp.json && git commit
        │
        ▼
release-it before:init hook passes → release proceeds
```

## Running it

```bash
# 1. Prep — wipes ~/.unbrowse/{skill-snapshots,queue/pending,route-cache},
#    writes per-probe subagent.prompt.md files, prints the run dir.
bun run bench:gate:mcp
# or with a smaller probe count for development:
bun run bench:gate:mcp --limit 5 --iterations 2
```

The script prints a run dir like `.bench-gate/20260517T...Z`. Read the
generated `fanout-instructions.md`. Then the **parent agent** (Claude
Code in-thread) spawns the subagents:

```
for each probe-dir in <run-dir>/*:
  Agent({
    subagent_type: "general-purpose",
    description: "bench-gate probe <probe_id>",
    prompt: <contents of <probe-dir>/subagent.prompt.md>
  })
```

Batch the fan-out at 4-6 concurrent Agents. The MCP server's per-session
Kuri broker is known-flaky at conc>6 on macOS (see CLAUDE.md "Parallel
gate collection"). At conc=4 the falsifier passes 4/4; at conc=6 it
holds. >6 is unverified.

When all subagents have written `subagent.result.json`, the parent runs:

```bash
bun run bench:gate:mcp:collect -- --artifacts <run-dir>
bun run bench:gate:validate -- --artifacts <run-dir>
bun run bench:gate:compare -- --artifacts <run-dir> --stamp
git add .bench-gate/stamp.json
git commit -m "chore: bench-gate stamp <run-id>"
```

After the stamp commit, `bun run release` reads it and the gate passes.

## Outcome labels (subagent-rendered)

Per iteration:

- `PASS` — empty resolve, browse OK, publish OK, resolve-after-publish
  saw the new skill, execute returned data the subagent judged relevant.
- `FAIL_BROWSE` — `unbrowse_go` errored or never opened a session.
- `FAIL_INDEX_NO_ENDPOINTS` — close ran, no endpoints published.
- `FAIL_PUBLISH_NOT_VISIBLE` — endpoints published but not in the local
  skill index after close returned.
- `FAIL_RESOLVE_AFTER_PUBLISH` — resolve still empty after publish.
- `FAIL_EXECUTE_ERROR` — execute returned a non-2xx or threw.
- `FAIL_EXECUTE_EMPTY` — execute returned 2xx but the body was empty or
  obviously irrelevant to the intent.
- `EXCLUDED_AUTH` — site requires interactive login; not a regression.
- `EXCLUDED_BLOCKED` — anti-bot vendor refused; not a regression.

Per probe (across iterations):

- `STABLE` — all iterations same outcome.
- `FLAKY` — outcomes vary.
- `UNSTABLE` — any iteration crashed or timed out without a clean
  outcome.

## What the harness does NOT do

Per CLAUDE.md "harness makes visible, agent judges" and the memory
`feedback_harness_makes_visible_agent_judges.md`:

- No regex/grep verdicts. The subagent judges per-iteration outcomes
  in-thread.
- No LLM call from the harness scripts. The harness writes prompts and
  reads result.json; the Agent tool calls are owned by the parent.
- No prescribed correct outcome. The probe's expected verdict comes from
  the corpus lane tags + the agent's judgment, not from heuristic rules
  in the harness.

## Old gate still works

`bun run bench:gate:full` still works — it runs the CLI-shortcut harness
followed by the dry-run / agent-judge bundle. Use it for fast spot-checks
where the MCP loop's stability dimension isn't load-bearing.

For release stamping, prefer `bench:gate:mcp`.
