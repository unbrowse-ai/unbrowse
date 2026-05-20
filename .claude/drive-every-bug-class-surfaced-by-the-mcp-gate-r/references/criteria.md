# Acceptance criteria for Drive every bug class surfaced by the MCP-gate run .bench-gate/20260519T203955Z (gate.passed=false; index 30/45=66.7% < 80% floor; retrieve 17/44=38.6% < 65% floor; 3 anchor failures: 002 npm go_failed, 010 hub.docker wrong-endpoint, 011 dev.to wrong-shape) to GREEN in a convergence loop. CITED EVIDENCE on disk: .bench-gate/20260519T203955Z/{verdict.json (66 schema-validated per-probe verdicts), gate.json (comparator output), gate.md, per-probe artifacts capture.meta/html.excerpt/index.store/resolve.shortlist/resolve.pick/execute.input/execute.response.raw/execute.meta}. PRIORITIZED BUG CLASSES (impact-ranked from verdict.json): (W1) schema_drift refusal of real bodies — affects 8+ probes (016 stackoverflow, 020/021/043/049 x.com, 047 youtube subs, 057 southwest); substrate emits 200-wrapped schema_drift_recapture_required envelope INSTEAD of the real body when fields drift, even on auth-walled real data, masking working capture; single fix multiplies coverage. (W2) capture_did_not_emit_skill_id on cold-fetch failures — affects 002 npm (go_failed), 013/014/015 reddit/github, 026 amazon, 029 beatsaver, 033 openlibrary search, 064 google maps; the cold browse/fetch path errors do not produce a skill artifact even when partial signal exists. (W3) wrong-shape page-shell extraction — DOM extractor latches on nav/breadcrumb/translations/SPA-config instead of data nodes; 011 dev.to (signup CTA), 018/019 openlibrary (sidebar chips), 031 priceline (Org boilerplate), 052 ticketmaster (i18n), 057 southwest (marketing tiles), 059 target (breadcrumbs), 066 vinted (Next.js RSC stub). (W4) wrong endpoint pick — 010 hub.docker picked 'Returns user details' over tags-DOM (ranker). (W5) auth-gated crash-not-handoff — 043 x.com/home returns marketplace-op error envelope instead of resolve_hard_handoff. (W6) cold-fetch Akamai despite good capture — 032 ebay; substrate should prefer captured DOM artifact over re-trying server_fetch when it knows the host is bot-walled. (W7) auth-cookies real-bug — 047 youtube subs has cookies but schema_drift envelope instead of returning subscriptions (overlaps with W1). CONSTRAINTS: each wave is ONE scoped commit on a dev-repo branch via /unbrowse-improvement-loop (NEVER direct main); the substrate principle binds (no heuristic verdicts; harness collects; agent judges); re-run THIS skill /unbrowse-mcp-gate after every wave's PR merges to measure delta; STAMP only fires when gate.json.passed=true. EXIT condition for the loop: gate.json.passed=true (a real .bench-gate/stamp.mcp.json gets written), at which point convergence is declared.

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
