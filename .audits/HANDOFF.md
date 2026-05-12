# Hand-off — Unbrowse MCP Audit loop (jl/default) — Round 2

**Loop status:** Day 9 / 9 — Emergence. SHIPPED on AC1 / AC2 / AC3 / AC3.5. Tickets filed for the 3 pre-existing test failures the prior loop hand-off mis-labeled "rename leftovers."

**Branch:** `jl/default` (worktree at `/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse-jl-default`).

**Commits on this branch above `9f1752eb` (prior loop's hand-off commit):**

| Commit | Day | Subject | AC |
|---|---|---|---|
| `163e08af` | 5 Creatures | `fix(mcp): remove domain field from unbrowse_resolve schema (substrate-lie)` | AC2 |
| `cbfc2537` | 5 Creatures | `fix(orchestrator): add marketplace_by_host racer for cold-domain resolves` | AC1 |
| `0129d7aa` | 5 Creatures | `fix(mcp): apply dietIfOversize in successResult so all handlers inherit wire cap` | AC3 |
| `b8e339e2` | 5 Creatures | `fix(mcp): reserve envelope headroom in successResult diet cap` | AC3.5 (lost sheep) |

All four use `fix(...)` conventional-commit prefixes; release-it will pick
them up into the next CHANGELOG without manual edit.

## What shipped (AC1, AC2, AC3, AC3.5)

### AC1 — Marketplace racer fires for cold hosts

- `src/orchestrator/resolve-race.ts` — added a second marketplace racer
  alongside the existing `knownSkillId`-gated one. New racer fires whenever
  `URL(args.contextUrl).host` resolves; reuses the existing `marketplaceLookup`
  DI seam (test contract was a single callable receiving the host string).
  Guards against double-call when host happens to equal `knownSkillId`.
- Test: `tests/mcp-marketplace-host-racer.test.ts` — 1 pass.

### AC2 — `unbrowse_resolve` no longer advertises `domain`

- `src/mcp.ts` — removed `domain` from `unbrowse_resolve`'s
  `inputSchema.properties` and the L1189-1191 `args.domain` body-merge.
- Root cause: Day-1 sub-agent traced domain-only path — it silently
  degrades to `normalizeRouteContext("root")` in
  `src/orchestrator/index.ts:3669-3672`. Schema was lying about what the
  field unlocks. Future loop can re-add the field once AC1's
  `marketplace_by_host` racer makes domain-only meaningful.
- Test: `tests/mcp-resolve-domain-input.test.ts` — 1 pass.

### AC3 — Diet coverage extended to all tool returns

- `src/mcp.ts` — exported `successResult` and `dietIfOversize`; modified
  `successResult` to pass values through `dietIfOversize` before envelope
  assembly. All 7 content-returning handlers (`unbrowse_resolve`,
  `unbrowse_execute`, `unbrowse_snap`, `unbrowse_text`,
  `unbrowse_markdown`, `unbrowse_skills`, `unbrowse_trace`,
  `unbrowse_validate`) now inherit the wire-budget cap from one site.
- `maybePostProcessResult` was NOT touched — it handles `path`/`extract`/
  `limit` projection, a different concern. Its inner `dietIfOversize` calls
  become idempotent no-ops after this change.
- Test: `tests/mcp-diet-coverage.test.ts` — 2 pass.

### AC3.5 — Envelope headroom (lost sheep, Day-5 adversarial test)

- `src/mcp.ts:successResult` — pass `WIRE_BUDGET_CHARS - 1024` to
  `dietIfOversize` instead of the default. Reserves 1024 chars for envelope
  overhead (text preview + structuredContent wrapper + JSON-RPC framing).
- Found by `tests/mcp-diet-coverage-adversarial.test.ts` case 3 (array of
  100 × 10K-char strings) — wire body was 25_254 chars before fix, ≤25_000
  after.
- Test: 4/4 cases pass (surrogate-pair boundary, deep nesting, oversize
  array of oversize strings, JSON-encoded body field).

## Test status (AC4 baseline)

```
bun test tests/mcp-*.test.ts
→ 41 pass / 3 fail
```

The 3 failures are the SAME 3 pre-existing failures from the prior loop's
hand-off — no new regressions. Each one is filed as a distinct ticket in
this directory (AC5):

- [`.audits/ticket-mcp-stdio-listchanged-contract-drift.md`](./ticket-mcp-stdio-listchanged-contract-drift.md)
- [`.audits/ticket-mcp-cheatsheet-tool-count-stale.md`](./ticket-mcp-cheatsheet-tool-count-stale.md)
- [`.audits/ticket-mcp-resolve-guidance-next-tools-rename.md`](./ticket-mcp-resolve-guidance-next-tools-rename.md)

The prior loop's hand-off labeled all three "rename leftovers." Day-8
Audit 7 (carried forward in this loop's plan) established they are three
different bugs. Tickets split them correctly.

## What is owed (next loop)

| Item | Severity | Surface | Notes |
|---|---|---|---|
| Issue #4 from prior hand-off — `ok:false` on `shortlist_returned` | P2 | `src/mcp.ts` near `successResult` / `errorResult` | Deferred from this loop's plan as out-of-scope. ~20 LoC at handler boundary. |
| AC1 backend follow-up — `GET /v1/skills?host=` | P2 | `backend/src/routes/skills.ts`, `backend/src/services/marketplace.ts` | Today's racer reuses the existing marketplaceLookup callback (works in tests). For scale, add a host-filtered backend route — see `getSkillByDomain` at `backend/src/services/marketplace.ts:122-137` for the seed. |
| SKILL.md docs reference removed `--domain` flag | P3 | `SKILL.md:255`, `SKILL.md:379` | Day-5 ripple-search found these; not touched in this loop. Resolve CLI example + search example still mention `--domain "..."`. |
| Three filed tickets (above) | P2 | `tests/` | Three small isolated fixes; pick up in any order. |

## Pre-merge checklist

- [ ] Branch base: `rach/restart-base` (working branch per project CLAUDE.md;
      `main` is broken).
- [ ] Cherry-pick `163e08af`, `cbfc2537`, `0129d7aa`, `b8e339e2`. Order doesn't
      matter — they touch disjoint surfaces (`resolve-race.ts` vs `mcp.ts`).
- [ ] Drop the prior loop's `957f1c52` (release-gate harness) if not relevant
      to this PR.
- [ ] Kill stale `unbrowse|kuri` processes before any local re-test:
      `pkill -9 -f 'unbrowse mcp|kuri serve'`.
- [ ] `bun run release:preview` to cut the next version. The four `fix(...)`
      commits flow through release-it's conventional-changelog into
      `CHANGELOG.md` automatically.

## Loop self-grade

| Day | Verdict |
|---|---|
| 1 Light | Inventory complete; one contradiction surfaced (B was downstream, not at MCP boundary); baseline reproduces |
| 2 Firmament | Three vessels picked: 2nd racer (AC1), schema removal option-b (AC2), `successResult` as diet site (AC3) |
| 4 Luminaries | 3 failing tests / 4 assertions installed; all red as designed (Steps 3, 6, 7, 8 skipped by framework) |
| 5 Creatures | 4 commits land all ACs; adversarial test caught a 254-char envelope overshoot; mustard-seed fix flips it green; 41 pass / 3 baseline fail; no new regressions |
| 9 Emergence | Three tickets filed correctly (the prior loop's "rename leftovers" was a mis-classification — Day-8 was right that they're 3 different bugs); CHANGELOG flows via conventional-commit machinery; this doc |

PROMOTE on all four shipped ACs. HOLD on the three filed tickets and the AC1
backend route (clearly delegated to next loop, not silently dropped).
