---
name: unbrowse-bench-history-tracker
description: Append every agent-judged bench-gate run to a per-run history ledger and surface deltas in release notes. Default output is always one new row in `.bench-history/bench-gate-runs.jsonl` plus a markdown delta block ready for `.release-notes.md`. Never re-judges, never invents coverage numbers, never overwrites prior rows.
---

# Unbrowse Bench History Tracker

## Output mode (load-bearing)

Default output per invocation is two artifacts:

1. One appended JSONL row in `.bench-history/bench-gate-runs.jsonl` with fields pulled from the agent-judged bench-gate run: run_id, ts, git_sha, cli_version, index/retrieve coverage, lane breakdown, new_passes, new_fails, hostile_suspicious, and a free-text agent comment.
2. One markdown block on stdout, suitable for paste into `.release-notes.md`, that names the delta vs the prior recorded run.

The skill never:

- Auto-derives a verdict (the agent already did via `verdict.json`).
- Edits `.release-notes.md` for you.
- Mutates prior rows in `bench-gate-runs.jsonl`.
- Posts to GitHub or Linear.

If you want raw bench artifacts, call `/unbrowse-bench-improvement-loop`. If you want to add probes, call `/unbrowse-bench-corpus-builder`. This skill is the post-judge ledger only.

## Workflow

1. Run an agent-judged bench-gate cycle (collect → verdict → compare). Confirm both `.bench-gate/<run-id>/verdict.json` and `.bench-gate/<run-id>/gate.json` exist.
2. Record the run with a one-line comment summarizing what shipped that run:
   ```bash
   bun run bench:history:record --artifacts .bench-gate/<run-id> --comment "what shipped"
   ```
3. When preparing a release, generate the delta block:
   ```bash
   bun run bench:history:release-notes --since <prev-tag-or-run-id>
   ```
4. Paste the markdown block into `.release-notes.md` under a `## Bench` section.
5. Commit the appended `.bench-history/bench-gate-runs.jsonl` row alongside the release.

## Hard rules (gates)

1. A row is rejected if `verdict.json` is missing, malformed, or has fewer probes than the manifest.
2. A row is rejected if `gate.json` is missing.
3. Comment must be 1–280 chars and contain no coverage numerals (those come from gate.json, separate field).
4. The script never overwrites a row whose `run_id` matches an existing entry; pass `--force` to replace.
5. Release notes generator must reference at least one concrete probe_id when claiming a new pass or new fail.
6. No script in this skill ever mutates `.bench-gate/<run-id>/` artifacts. Read-only on inputs.

Run the structural validator:

```bash
.agents/skills/unbrowse-bench-history-tracker/scripts/validate.sh
```

## What this skill does NOT do

- Judge probes. Judging stays with the agent reading `judge.bundle.md`.
- Decide release readiness. That stays with `bench-gate-prerelease.sh` + the agent-judged stamp.
- Write to GitHub releases or Linear. Surfaces text only.
- Re-run a bench. Inputs are agent-judged artifacts.
- Hide regressions. New_fails are surfaced verbatim with probe_id.

## References

- `references/plan.md`: Day 0 plan, non-goals, acceptance criteria.
- `references/contract.md`: exact JSONL row shape, field semantics, schema invariants.
- `references/release-notes-flow.md`: how the markdown block plugs into `.release-notes.md` and `release-it`.
- `assets/run-row-template.json`: copyable starter row.
