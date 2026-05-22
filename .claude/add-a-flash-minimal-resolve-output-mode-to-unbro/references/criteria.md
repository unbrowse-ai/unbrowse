# Acceptance criteria for Add a flash minimal resolve output mode to unbrowse: a resolve flag that returns only endpoint_id plus a one-line evidence string per shortlist candidate instead of the full rich object with URL score samples schema requires and yields, cutting shortlist tokens so the two-tool-call contract is cheaper. Best practice source_id deepwiki:browser-use/browser-use (flash_mode minimal output format). Scoped to one upgrade, the full shortlist stays the default. Verified by a bun test asserting the flash shape and a bench-local row showing the agent still picks the correct endpoint from the minimal shortlist.

_Optional. If this file exists, `verify.sh` will collect per-lane raw evidence
into `lanes.jsonl` and the agent will judge in-thread. If absent, verify is
a single binary pass/fail._

_Borrowed from `/evidence-build` criteria.md shape. Every lane cites at least
one `source_id` that resolves in real evidence (file path, URL, transcript
line, etc.). No uncited criteria. This is one face of the inherited substrate
principle: see `references/SUBSTRATE-PRINCIPLE.md` (emitted into this scaffold)
and the same section in the plan state file. A lane must collect raw evidence
its `bench_command` emits; it must never encode a heuristic verdict._

## Lanes

```yaml
# Schema: each lane carries a stable id, a falsifiable bench question, the
# command that emits raw evidence (NOT a pass/fail), and the source_id(s)
# the lane derives from. The agent judges pass/fail in-thread from evidence.

lanes:
  - id: lane-1
    question: "Does <X> exist and contain <Y>?"
    bench_command: "test -f path/to/X && grep -q 'Y' path/to/X && echo FOUND || echo MISSING"
    source_id: "code:path/to/spec.md#L42"

  - id: lane-2
    question: "Does the integration test for <Z> green?"
    bench_command: "npx vitest run --reporter=verbose tests/Z.test.ts 2>&1 | tail -20"
    source_id: "issue:#123"
```

## How verify.sh treats this

If `criteria.md` exists with a `lanes:` block:

1. For each lane, run `bench_command`, capture stdout to `lanes.jsonl` as one row:
   `{lane_id, ts, exit_code, output_tail}`
2. Emit ONLY the raw `lanes.jsonl` — do not synthesize PASS/FAIL.
3. iterate.sh reads the rows and records per-lane outcomes alongside the iteration row.
4. The agent (you, reading the ledger) judges whether each lane is moving.

## What this does NOT do

- It does not assign a heuristic pass/fail to a lane. Agent judges from evidence.
- It does not invent lanes. Edit this file to add them.
- It does not override `verify_command` in the state file frontmatter — both run.
