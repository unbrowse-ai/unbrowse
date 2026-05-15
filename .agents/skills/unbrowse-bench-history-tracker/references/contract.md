# Bench-Gate Run Row Contract

Each appended line in `.bench-history/bench-gate-runs.jsonl` is a single JSON object.

## Required fields

- `run_id` (string): same as the directory name under `.bench-gate/`.
- `ts` (ISO8601 string): when the row was recorded.
- `git_sha` (string): HEAD SHA at record time, short or long.
- `cli_version` (string): from `version.json` or `gate.json.cli_version`.
- `index_pass` (int): from gate.json.
- `index_total` (int): from gate.json.
- `index_coverage` (float, 0–1): index_pass / index_total. Recompute, do not trust prose.
- `retrieve_pass` (int): from gate.json.
- `retrieve_total` (int): from gate.json.
- `retrieve_coverage` (float, 0–1): retrieve_pass / retrieve_total.
- `anchor_pass` (int) + `anchor_total` (int): hard release floor.
- `by_lane` (object): `{lane_name: {index_pass, index_total, retrieve_pass, retrieve_total}}`.
- `hostile_suspicious_probes` (string[]): probe_ids flagged suspicious in verdict.json.

## Comparison fields (vs prior recorded run)

- `new_passes` (string[]): probe_ids that retrieve-passed this run but failed last run.
- `new_fails` (string[]): probe_ids that retrieve-failed this run but passed last run.
- `new_excluded` (string[]): probe_ids that newly excluded (auth or block).

## Optional fields

- `comment` (string, 1–280 chars, no coverage numerals): free-text agent note.
- `commit_subject` (string): subject of HEAD commit at record time.
- `corpus_size` (int): probes in this run.
- `gate_passed` (bool): from gate.json.

## Schema invariants

- `run_id` is unique. Re-recording requires `--force`.
- Coverage floats must equal pass/total to within 1e-6.
- `new_passes ∩ new_fails = ∅`.
- Every probe_id in new_passes or new_fails must exist in the run's verdict.json.
- Comments must not contain `\d+%`, `\d+/\d+`, or `coverage`.
