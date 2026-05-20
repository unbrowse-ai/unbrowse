# Gate Status Snapshot — 2026-05-20

Measurement wave only. No code changes. Reads `.bench-gate/` stamps and
compares the latest full-corpus stamped run against the plan_text
baseline `20260519T203955Z`.

## Verdict: STILL-FAILING (but moving)

`gate.json.passed=false` on every stamped run today. The 80% index /
65% retrieve floor + clean-anchor-lane requirement is not met.

One run (`20260520T081602Z` against mcp:c0f06fd2) cleared the index
floor (82.0%) but failed retrieve (44.7%) and anchor (4 anchor probes
red). It is the only run today that flipped any floor.

## Numbers

| run_id              | cli_version    | indexable | index%  | retrievable | retrieve% | anchor fails | gate.passed |
|---------------------|----------------|-----------|---------|-------------|-----------|--------------|-------------|
| 20260519T203955Z (baseline) | mcp:cb97d6a7 | 45 | 66.7% | 44 | 38.6% | 3 (002 npm go_failed, 010 hub.docker err-body, 011 dev.to wrong-shape) | false |
| 20260520T015714Z    | mcp:433486c3   | 32        | 68.8%   | 32          | 37.5%     | 5            | false       |
| 20260520T025154Z    | mcp:2826bc16   | 28        | 50.0%   | 28          | 39.3%     | 3            | false       |
| 20260520T071810Z    | mcp:c0f06fd2   | 42        | 64.3%   | 42          | 42.9%     | 3            | false       |
| 20260520T081602Z    | mcp:c0f06fd2   | 50        | **82.0%** | 38        | 44.7%     | 4            | false       |
| 20260520T093742Z (latest stamped) | mcp:62168964 | 51 | 76.5% | 38 | **42.1%** | 5 | **false**   |
| 20260520T111104Z    | (in-flight)    | n/a       | n/a     | n/a         | n/a       | n/a          | n/a         |

## Delta vs baseline (latest stamped = 20260520T093742Z)

- index_coverage: 66.7% -> 76.5% (+9.8 pp, indexable denom grew 45 -> 51)
- retrieve_coverage: 38.6% -> 42.1% (+3.5 pp, retrievable shrank 44 -> 38)
- anchor failures: 3 -> 5 (cast changed; 010 hub.docker and 011 dev.to
  no longer top the anchor-fail list; new anchor reds: 004 lobste.rs,
  005 github search, 006 wikipedia, 009 pypi)
- gate.passed: false -> false

The shrinking retrievable denominator (44 -> 38) means the harness is
classifying more probes as non-retrievable (auth-excluded / hostile-
excluded) than the baseline cast did. This dampens the apparent retrieve
delta and is itself worth an in-thread agent judgment in a future wave.

## Anchor-failure shape (per plan_text, the 3 cited anchors)

- **002 npm** (go_failed in baseline): still failing on 5 of 6 stamped
  runs today (idx=INDEX_FAIL_NO_ENDPOINTS or INDEX_PASS + ret=ERROR_BODY).
  Bug class W2 (cold-fetch skill-id) not closed.
- **010 hub.docker** (wrong-endpoint in baseline): off the anchor-fail
  list on 4 of 6 runs today. Bug class W4 partially closed by W4 ship
  (#541) and W4-followup (#543, #545), though the ledger records
  multiple investigations showing the production resolve path was not
  always loading the cached page-artifact skill.
- **011 dev.to** (wrong-shape in baseline): still RETRIEVE_FAIL_WRONG_SHAPE
  on 4 of 6 runs today. Bug class W3 (config-shape demotion #542) green
  on the latest 093742Z run but red on earlier stamps. Mixed signal.

## What shipped in-loop (per ledgers/iterations.jsonl)

W1 #536 (drift envelope), W6 #540 (Akamai detect), W4 #541 (LIST_INTENT
promotion), W3 #542 (config-shape demotion), W4-followup #543,
W4-followup-2 #545, W0 #544 (collector per-probe timeout).
W2 (heavy cold-fetch redesign) and W5 (orchestrator stale-vs-fresh)
remain unshipped per the ledger HOLD rows.

## Convergence call

NOT promoted. gate.passed=false on every stamped run. The index floor
has been touched once (082 run hit 82.0%) but the retrieve floor (65%)
and anchor-lane-clean check are both far from green. The scaffold's
EXIT condition (`gate.json.passed=true` -> `.bench-gate/stamp.mcp.json`
written) is unmet.

Highest-leverage next bug classes (read from latest gate.json anchor
fails): RETRIEVE_FAIL_ERROR_BODY now dominates (npm, lobste.rs, github
search, wikipedia, pypi) -- a different shape than the baseline's
mix (no_endpoints + wrong-shape + error-body). This suggests recent
ships moved the index needle but introduced or exposed a retrieve-side
error-body envelope that the agent should diagnose next.

## Notes

- The latest two `.bench-gate/` dirs by mtime (`w3-targeted-20260520T180500Z`
  and `w3-targeted-20260520T180000Z`) are 7-probe `[dry-run stub]` runs,
  not real collections. They report 0/7 on both floors and are not
  decision-grade. Excluded from the table above.
- An in-flight collection at `20260520T111104Z` has no `gate.json` yet.
- Baseline `20260519T203955Z` exists on disk; my initial scoped search
  missed it.
