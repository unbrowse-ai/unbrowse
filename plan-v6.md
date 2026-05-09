# Plan v6: Unlock walmart by shipping `--raw` default (plan-v5 #1)

## Diagnosis (evidence from `.bench-history/20260508T160745Z/`)

Walmart's last bench row:

| Field | Value |
|---|---|
| `phase2_status_code` | `200` |
| `phase2_trace_success` | `true` |
| `phase2_response_bytes` (bench) | `0` |
| `phase2_excerpt` (bench) | `""` |
| **execute.out raw `response_bytes`** | **`951863` (930KB)** |
| `extraction_hints.schema_tree.initialData.searchResult.aggregatedCount` | `number` |
| `extraction_hints.schema_tree.initialData.searchResult.title` | `string` ("Results for \"coffee\"") |
| `triage_bucket` | `z_likely_browser_block_empty_200` |

**Walmart is not failing.** Execute fetched 930KB of real search results. The body landed in the `extraction_hints` envelope (default truncation when >64KB), and the bench rubric only reads `result`. Result: walmart looks like an empty 200 to the bench classifier even though the data is right there.

## Fix: plan-v5 #1 (`execute --raw` default)

Plan-v5 already specified this. Restating with walmart as the canonical proof case:

**Surface area** (≈10 LoC, 30 min):

1. `src/cli.ts:cmdExecute` (line ~1411): invert the truncation gate
   ```ts
   // OLD
   if (!rawFlag && !pathFlag && !extractFlag && !schemaFlag && raw.length > 64*1024) {
     // emit extraction_hints envelope
   }
   // NEW
   if (summarizeFlag && raw.length > 64*1024) {
     // emit extraction_hints envelope
   }
   ```
2. `src/cli.ts`: drop `--raw` parsing (or alias to no-op for back-compat); add `--summarize` parsing
3. `src/cli.ts:CLI_REFERENCE`: update help text
4. `scripts/bench-two-phase.sh`: drop `--raw` from execute invocations (no longer needed)

**Tests**:
- `tests/cli-execute-raw-default.test.ts` (new): execute against a >64KB fixture, assert `result` contains the body, no `extraction_hints` envelope
- `tests/cli-execute-summarize-flag.test.ts` (new): execute with `--summarize` against same fixture, assert `extraction_hints` envelope present
- Audit: any existing test asserting envelope shape on big responses must add `--summarize` or update expectation. Survey: `zigrep "extraction_hints" tests/`

## Coverage delta

Pre: PASS=8, denom=9 (walmart in BLOCK pool via z_*), **88.9%**
Post: walmart's 930KB response flows into `result` → bench bucket flips from `z_likely_browser_block_empty_200` to `PASS` → denom 9, PASS=9, **100%**

The Foot Locker `4xx_real_content` row (Phase C unlock) and walmart unlock together close the corpus.

## Sibling unlocks (for free)

Other corpus URLs whose bodies exceed 64KB and currently land in extraction_hints will move from envelope → raw body too. Likely candidates from the schema-rich captures: bing search, vinted, ticketmaster, indeed (post-Phase-B-wire). None of them are currently mis-bucketed, but their bench rows will show real bytes instead of 1KB envelope shells.

## Risk

- **Tests asserting envelope shape**: must update. Audit before flip.
- **MCP / external callers**: extraction_hints was opt-out via `--raw` already, so no contract guarantee. `--summarize` is the explicit opt-in for the rare interactive case.
- **Token cost on agents**: a 930KB raw body in result may exceed an LLM context. Mitigated by: (a) the agent who asked for execute already chose to fetch this URL knowing it's a search results page, (b) `--limit` and `--path` still work for narrowing.

## Order

Single commit on `feat/agent-ux-run-planner`:
1. Audit existing extraction_hints tests (5min)
2. Flip default + add `--summarize` (10min)
3. Update help text + bench wrapper (5min)
4. Run full test suite, fix any envelope-shape assertions (10min)
5. Re-run hard-target bench to confirm walmart → PASS (90s with marketplace-wipe)

## Definition of done

- 1 commit, independently revertable
- 2 new tests green; no regression in existing tests
- `.bench-history/<runid>/` shows walmart bucket = PASS, response_bytes ≈ 930KB
- Coverage on hard-target corpus = 9/9 = **100%**

## What this plan replaces / supersedes

- Plan-v3 Phase D's "5xx → page_fetch fallback" target was walmart; that approach was wrong because walmart isn't 5xx-ing on this corpus. Phase D's actual shipped behavior (5xx → ssr-fastpath) is still good defensive infrastructure for sites that DO 5xx.
- This plan re-targets walmart correctly: it's an envelope-truncation classification bug, not a fetch failure.

## Why not split walmart from `--raw` default

- The bug surface IS the truncation envelope hiding success. Fixing it for walmart only would mean a walmart-specific carve-out — exactly the "per-domain heuristic" anti-pattern from CLAUDE.md.
- The structural fix is to make `--raw` the default. Walmart benefits as a member of "every site whose body exceeds 64KB."
