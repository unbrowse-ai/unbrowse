# Day 0 Plan

## GOAL

Make every agent-judged bench-gate run a permanent, queryable point on a coverage timeline so the team can see what shipped between releases and how the gate moved.

## NON-GOALS

- No re-judging of probes. The agent already judged via verdict.json.
- No automatic release-notes editing. The skill emits markdown; the human/agent pastes.
- No GitHub releases or Linear posting.
- No re-derivation of coverage from raw probe artifacts. Numbers come from gate.json.
- No silent overwrite of prior rows.

## ACCEPTANCE CRITERIA

- New rows append, never overwrite (without --force).
- Each row carries: run_id, ts, git_sha, cli_version, index_pass/total, retrieve_pass/total, anchor counts, by-lane counts, new_passes vs prior, new_fails vs prior, hostile_suspicious, comment.
- The release-notes generator names at least one concrete probe_id for each new pass or fail.
- Coverage numbers in the release-notes block are sourced from gate.json, not invented.
- Comment field validation rejects coverage numerals (those go in their own fields).

## RISKS

- Race condition on parallel writes. Mitigated: append-only single-process semantics.
- Comment drift over time becomes the source of truth. Mitigated: comments stay free-text but coverage numbers stay machine-derived.
- Stale runs may be recorded after a corpus change. Mitigated: the row carries cli_version and git_sha so the agent can reason about whether the change was code or corpus.

## OUT-OF-SCOPE

- Per-probe history (already exists in `.bench-history/runs.jsonl` from bench-hard runs).
- Multi-tenant or shared remote storage.
- Aggregate dashboards.
