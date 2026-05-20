# Acceptance criteria for restore EmergentDB qdkv as the backend skills/stats KV store, reversing the Feb 24 2026 migration (commit 2e3f4ca3 that moved to Cloudflare SKILLS_KV/STATS_KV). Bring back the EdbKV class in backend/src/services/kv.ts (was 225 lines, replaced with thin CF KV wrappers). Re-route marketplace.ts, scoring.ts, agents.ts, perf.ts, stats.ts, discovery.ts in-memory search cache back to EdbKV. Remove SKILLS_KV + STATS_KV bindings from wrangler.toml and Env type. Keep the EmergentDB Graph API (graph.ts, /graph/search, /graph/batch_insert) as-is since it's already wired and working. ACCEPT the eventual-consistency trade-off the Feb 24 commit fixed (frequent 404s on read-after-write); add retry-on-404 helper to mitigate. Verify end-to-end: write a skill, read it back, run /v1/search and /v1/search/resolve, confirm both graph and qdkv paths return real data. Deploy to staging first, run agent-experience harness, then prod. Lewis 2026-05-21 decision: reverse the migration.

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
