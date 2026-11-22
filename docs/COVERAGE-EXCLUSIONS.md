# Coverage exclusions

Code left out of the line-coverage count that gates a promotion of staging to public (UNB-208, AGENTS.md "Tests,
requirements and the merge scorecard"). The count covers the Rust workspaces (`unbrowse-node`,
`unbrowse-node/crates/browser`, `unbrowse-browser/cli`) and both SDKs (`unbrowse-sdk/typescript`, `unbrowse-sdk/python`).

Only a row in the table below is excluded, and only once Lewis has approved it: the approval column names when and
where. Nothing else is left out, and nothing is left out to reach the number. A file that is only built on another
system, or written by a generator, is the kind of thing that belongs here; code that is hard to test is not.

`.github/scripts/promotion_gate.py coverage` reads this table. Each path is a glob over repository paths
(`fnmatch`: `*` crosses `/`). A row whose approval cell is empty is refused, not applied.

## Approved

| Path (glob) | Why | Approved by Lewis (date, where) |
|---|---|---|
| `unbrowse-sdk/typescript/src/types.ts` | Type declarations only: nothing in it runs, so no test can cover it | 18 Nov 2026, approved by Lewis (programme 7f35ecb8 plan, 09:10 SGT) |
| `unbrowse-sdk/typescript/src/owner-types.ts` | Type declarations only: nothing in it runs, so no test can cover it | 18 Nov 2026, approved by Lewis (programme 7f35ecb8 plan, 09:10 SGT) |
| `unbrowse-sdk/typescript/src/generated.ts` | Written by `unbrowse-sdk/codegen/generate.py` from `unbrowse-node/agent-api.json`; the codegen check guards it | 18 Nov 2026, approved by Lewis (programme 7f35ecb8 plan, 09:10 SGT) |
| `unbrowse-sdk/python/src/unbrowse/_generated.py` | Written by `unbrowse-sdk/codegen/generate.py` from `unbrowse-node/agent-api.json`; the codegen check guards it | 18 Nov 2026, approved by Lewis (programme 7f35ecb8 plan, 09:10 SGT) |
| `unbrowse-settlement/src/lean/v4/*.sol` | Uniswap v4's maths copied unchanged (its LICENSE is in the folder); tested upstream | 18 Nov 2026, approved by Lewis (programme 7f35ecb8 plan, 09:10 SGT) |

## Sizes of what is left out

Measured on staging `0df04b63`, 19 Nov 2026 (UNB-208 step 13). Lines are the ones the coverage tools count, not file lengths.

- `unbrowse-sdk/typescript/src/types.ts`: 478 lines. Compiles to `export {}`.
- `unbrowse-sdk/typescript/src/owner-types.ts`: 219 lines. Compiles to `export {}`.
- `unbrowse-sdk/typescript/src/generated.ts`: 2,231 lines, written by `unbrowse-sdk/codegen/generate.py`.
- `unbrowse-sdk/python/src/unbrowse/_generated.py`: 1,516 lines, written by the same script.
- `unbrowse-settlement/src/lean/v4/*.sol`: 1,050 lines in nine files (the settlement part is reported apart, not gated).
- Not applied: `unbrowse-node/crates/learn/src/generated.rs`, 861 lines (see below).

The two SDKs without these rows: TypeScript 86.64% (4,987 of 5,756 lines), Python 98.65% (2,987 of 3,028). With them: TypeScript 99.93% (2,826 of 2,828), Python 100% (1,512 of 1,512).

## Not applied

`unbrowse-node/crates/learn/src/generated.rs` was on the list Lewis approved on 18 Nov 2026 as generated code. It is
not: it is the engine's own hand-written code that checks and runs the programs an agent writes for a header (the
name means "a generated producer"). It stays in the count until Lewis says otherwise with that in view.

## Where the count is read

`coverage.yml`'s `Coverage, per part` job (the summary and the pull request's table) and `Coverage, ratchet` job (the
check every pull request to staging must pass) both read this file, and the ratchet reads staging's numbers with it
too, so a row added here is not counted as a fall.
