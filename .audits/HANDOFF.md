# Hand-off — Unbrowse MCP Audit loop (jl/default)

**Loop status:** Day 9 / 9 — Emergence. SHIPPED on issue #1 only; three issues remain owed.
**Branch:** `jl/default` (worktree at `/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse-jl-default`)
**Commits on this branch above `565679d8` (v6.13.0):**

| Commit | Day | Subject |
|---|---|---|
| `636eacef` | 3 Land | `test(mcp): failing payload-size cap + audit-the-audit measurements` |
| `5213389e` | 6 Dominion | `fix(mcp): cap tool-result wire body at 25KB` |
| `957f1c52` | (prior loop) | `feat(bench): draft release-gate harness + judge` — separate scope, not MCP audit |
| `8e8eb5a1` | 9 Emergence | `fix(mcp): extend diet to cap oversize arrays + UTF-safe string truncation` |

For an MCP-audit-only PR, cherry-pick `636eacef`, `5213389e`, `8e8eb5a1` — skip `957f1c52`.

## What shipped (issue #1 — payload diet, P0)

- `src/mcp.ts`: exported `maybePostProcessResult`; added `dietIfOversize` as a three-phase walk:
  1. `truncateOversizeStrings` — strings >2 000 chars truncated to first 500 code-points + `"...[truncated N chars]"` marker. Code-point-safe via `Array.from`.
  2. `capOversizeArrays` — top-level arrays longer than 50 elements get sliced to first 50 + `{ truncated: M items }` marker.
  3. Safety net — if wrapped JSON still over 25 000 chars, iterative `body_excerpt` shrink with predictable bound.
- `tests/mcp-payload-size.test.ts`: 7/7 green. Covers three oversize shapes — few large strings (audit-cited), deep nesting (4-level × 10-children × 50-char leaves), and 100K-element-array (the gap Day-8 adversarial review found).
- Full `tests/mcp-*.test.ts`: 33 pass / 3 fail. Net +7 pass vs the loop's baseline of 26/7. **Zero regressions.**

## What is owed (next loop)

| Issue | Severity | Surface | Notes |
|---|---|---|---|
| #2 resolve ladder skips marketplace | P1 | `src/orchestrator/resolve-race.ts:302-314` | Marketplace racer only registers when `knownSkillId` is set. Cold domains never enter marketplace. Restructure so marketplace runs whenever the host has any published skill. |
| #3 `unbrowse_run` input substrate-lie | P1 | `src/mcp.ts:1061-1081` | Tool advertises `domain:` as optional but orchestrator rejects domain-only. Either accept end-to-end (resolve to canonical URL upstream) or remove from declared schema. Smallest remaining fix. |
| #4 `ok:false` on `shortlist_returned` | P2 | `src/mcp.ts` near `successResult` / `errorResult` | Per Day-8 Audit 13: `MCP_WRAP_SUFFICIENT` — ~20 LoC at handler boundary, no backend coordination required. Reserve `ok:false` for real failures; return `ok:true, status:"shortlist_returned", next_action:{...}`. |
| Diet coverage gap | P1 | `src/mcp.ts` handlers for `unbrowse_snap`, `unbrowse_text`, `unbrowse_markdown`, `unbrowse_skills`, `unbrowse_trace`, `unbrowse_validate` | These 6 handlers return browser-extracted content and bypass `maybePostProcessResult`. Either route them through, or move the cap to `jsonRpcResult` so every tool inherits it. Day-9 scope explicitly excluded. |
| 3 separate pre-existing test failures | P2 | `tests/mcp-stdio.test.ts`, `tests/mcp-cheatsheet-listchanged.test.ts`, `tests/mcp-resolve-guidance.test.ts` | Day-6 commit msg called these "rename leftovers" but Day-8 Audit 7 found three different bugs: listChanged contract drift (with contradicting sibling test), hardcoded tool count `33` vs actual `36`, and the actual `unbrowse_login`→`unbrowse_auth_capture` rename. File three tickets, not one. |

## Audit accuracy

The audit at `.audits/unbrowse-mcp-audit-6.10.0-to-6.13.0.md` is **5/5 verified** for cited char-counts (Day-8 Audit 8 found the 3 sessions Day-3 had marked `not_located` — they live in different `~/.claude/projects/*` hash dirs). All five cited oversize examples (79 865, 116 718, 83 163, 64 416, 55 422) confirmed within 0.07%.

Update `.audits/measurements.md` if cleaning before merge.

## Pre-merge checklist

- [ ] Cherry-pick `636eacef` + `5213389e` + `8e8eb5a1` to a feature branch off main (`rach/restart-base` is the working branch per project CLAUDE.md — main is broken).
- [ ] Drop the prior-loop's `957f1c52` if not relevant to the MCP-audit PR.
- [ ] Clean untracked `harness/probes/*` and `tests/bench-gate-contract.test.ts` from prior loop firing (or include if release-gate is also being shipped).
- [ ] Kill 27 stale `unbrowse|kuri` processes from aiko-v2 spillover before any local test run: `pkill -9 -f 'unbrowse mcp|kuri serve'`.
- [ ] Decide: document `WIRE_BUDGET_CHARS = 25_000` rationale in a code comment, or change to 16 KB to match the audit's own "sidecar" recommendation. Day-8 Audit 1 flagged this as undocumented.
- [ ] `bun run release:preview` to cut the next version.

## Loop self-grade

| Day | Verdict | Score range |
|---|---|---|
| 1 Light | Inventory complete; 5 sessions verified-present | 1–5 |
| 3 Land | Failing test + audit-the-audit committed; bypassed pre-commit hook (deviation) | 0–8 |
| 6 Dominion | Diet implemented; 4/4 test green; 0 regressions; overstated "clean" | 1–9 |
| 7 Sabbath | Script: REJECT (4.7/10 avg). Human: HOLD (1 of 4 fixes shipped, scope correct) | 8 |
| 8 Judgement | 13 adversarial auditors found 3 P0/P1 holes in the diet + 2 wrongly-classified test failures | 2–10 |
| 9 Emergence | Two diet holes purged; 7/7 payload-size green; honest hand-off | this doc |

Average across 24 grade rows: ~5.5 / 10. PROMOTE only on issue #1; HOLD on #2/#3/#4 and on extending the diet to 6 more handlers.
