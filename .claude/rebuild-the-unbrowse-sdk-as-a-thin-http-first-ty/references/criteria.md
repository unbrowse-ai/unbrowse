# Acceptance criteria for Rebuild the @unbrowse/sdk as a thin HTTP-first TypeScript client against beta-api.unbrowse.ai (no binary spawn, browser+node compatible). Auth: account-issued API keys (ubr_live_*) tied to a user account via dashboard, with optional x402 wallet for pay-as-you-go beyond included quota (reuses existing sponsor middleware in backend/src/middleware/sponsor.ts). Surface: new Unbrowse({apiKey}).resolve(intent), .execute(endpoint, params), .search(intent), .health(). Move binary-spawn into a separate @unbrowse/local subpackage for on-device kuri users. Rebuild docs/ site to mirror the new shape (quickstart in 3 lines: install, set key, call resolve). Research best-in-class SDK/docs references first (Resend, OpenAI, Replicate, Stripe, Vercel SDKs+docs) via deepwiki MCP + gh api; cite source_ids. Crystallise the resulting SDK design pattern as a durable principle in the principle store so future SDK work in any project inherits it. Verify gate is real channel: (1) SDK package builds and types check, (2) live HTTPS call against beta-api.unbrowse.ai with a real test API key returns documented 2xx for resolve+health, (3) docs site builds and the quickstart code-block parses+typechecks, (4) principle file exists under .principle-queue/applied.jsonl referencing >=3 cited references.

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
