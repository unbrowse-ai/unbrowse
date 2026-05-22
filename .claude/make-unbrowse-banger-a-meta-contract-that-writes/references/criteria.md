# Acceptance criteria — make-unbrowse-banger (the contract-writer)

The umbrella's job: write contracts that write contracts, each derived
from cited best-practice research, each making unbrowse measurably more
"banger". These lanes emit raw evidence; the agent judges in-thread. No
lane encodes a pass/fail verdict.

## Lanes

```yaml
lanes:
  - id: generic-writer
    question: "Is generate-child.sh a GENERIC primitive — no baked contract choice, no hardcoded slug list, no per-domain branch?"
    bench_command: "grep -nE 'harness build|PLAN_TEXT' .claude/make-unbrowse-banger-a-meta-contract-that-writes/scripts/generate-child.sh | head -8; echo '--- baked-choice scan (want 0) ---'; grep -cnE 'if .*(domain|host|intent) ==' .claude/make-unbrowse-banger-a-meta-contract-that-writes/scripts/generate-child.sh || echo 0"
    source_id: "code:.claude/make-unbrowse-banger-a-meta-contract-that-writes/scripts/generate-child.sh"

  - id: children-written
    question: "How many child contracts has the umbrella written, and are they all bound?"
    bench_command: "M=.claude/make-unbrowse-banger-a-meta-contract-that-writes/ledgers/children.txt; echo \"manifest=$(test -s $M && grep -c . $M || echo 0)\"; echo 'bound:'; grep -nA40 '^bound_contracts:' .claude/make-unbrowse-banger-a-meta-contract-that-writes.local.md | grep -E '^[0-9]+- +- ' || echo '(none bound)'"
    source_id: "code:.claude/make-unbrowse-banger-a-meta-contract-that-writes.local.md#bound_contracts"

  - id: cited-research
    question: "Does every distilled best-practice row carry a real source_id (deepwiki/code/url), not a remembered guess?"
    bench_command: "F=.claude/make-unbrowse-banger-a-meta-contract-that-writes/references/banger-best-practices.md; echo \"BP_rows=$(grep -c '^### BP-' $F)\"; echo \"source_id_rows=$(grep -c 'source_id:' $F)\""
    source_id: "code:.claude/make-unbrowse-banger-a-meta-contract-that-writes/references/banger-best-practices.md"
```

## How verify.sh treats this

verify.sh runs the umbrella structural gate (G1..G5: generator scripts
present, every bound child a valid iterable scaffold), then runs each lane
above and appends one raw row to `ledgers/lanes.jsonl`. The bound-contracts
phase of iterate.sh separately stitches each child's latest ledger row as a
conductor row in `iterations.jsonl`. The agent reads all three — G-rows,
lane rows, conductor rows — and judges whether the recursive tree is
moving unbrowse toward banger.

## What this does NOT do

- It does not score "bangerness" with a heuristic. The agent judges from
  the stitched child ledger rows.
- It does not invent child contracts. The agent pairs a pain row with a
  best-practice row and calls `generate-child.sh`.
