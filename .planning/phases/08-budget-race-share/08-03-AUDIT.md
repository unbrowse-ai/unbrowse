---
phase: 08
plan: 03
title: Audit — read sites for deprecated structured-replay registry + exec_strategy
---

# 08-03 Audit

Audit of every read/write site for symbols slated for deletion in Plan 08-03.
Generated before any deletion so reviewers can verify scope.

## Symbols audited

- `deriveStructuredDataReplay` (private)
- `deriveStructuredDataReplayUrl` (exported)
- `deriveStructuredDataReplayTemplate` (exported)
- `deriveStructuredDataReplayCandidates` (exported)
- `deriveStructuredDataReplayCandidatesFromInputs` (exported)
- `restoreTemplatePlaceholderEncoding` (private helper)
- `mergeContextTemplateParams` (private helper)
- `buildStructuredReplayHeaders` (exported)
- `hasStructuredReplay` (local in `executeEndpoint`)
- `structuredReplayUrl` (local in `executeEndpoint`)
- `structuredReplayHeaders` (local in `executeEndpoint`) — already absent
- `endpoint.exec_strategy` (field on `EndpointDescriptor`)
- `endpointStrategy` (local) — already absent in `src/`; only present in legacy `packed-src/`
- `buildCanonicalDocumentEndpoint` (exported, downstream of registry)
- `isCanonicalReplayEndpoint` (exported, downstream of registry)
- `trySeedStructuredDocumentSkill` (private, calls registry)

## Per-site decisions

### `src/execution/index.ts`

| Line | Symbol | Decision | Rationale |
|------|--------|----------|-----------|
| 409-661 | `deriveStructuredDataReplay` body + 16 host arms | DELETE | Per-host registry, replaced by probe ladder |
| 663-685 | `deriveStructuredDataReplayUrl/Template/Candidates` | DELETE | All call sites deleted as part of this plan |
| 687-702 | `deriveStructuredDataReplayCandidatesFromInputs` | DELETE | Only consumed by `trySeedStructuredDocumentSkill` |
| 704-733 | `buildStructuredReplayHeaders` | DELETE | Only consumed by `serverFetch` + `trySeedStructuredDocumentSkill` (both deleted/inlined) |
| 860-888 | `buildCanonicalDocumentEndpoint` | DELETE | Built canonical endpoints from registry rewrite; replaced by capture-time probe |
| 890-899 | `isCanonicalReplayEndpoint` | DELETE | Only meaningful when registry exists |
| 901-1090 | `trySeedStructuredDocumentSkill` | DELETE | Wraps the deleted registry; resolveAndExecute calls it but already has live-capture fallback |
| 225 | `isCanonicalReplayEndpoint` in admission | DELETE call | Falls through to schema check |
| 1331 | `await trySeedStructuredDocumentSkill(...)` | DELETE call + `seeded` var | Falls through to live capture |
| 1805-1817 | `exec_strategy` carry-forward | DELETE | Field is being removed |
| 2560-2566 | `isCanonicalReplayEndpoint` consumed-keys block | DELETE | Falls through to template-var detection |
| 2596-2597 | `structuredReplayUrl` / `hasStructuredReplay` locals | DELETE | replace with `url` directly |
| 2657 | `replayUrls = ...DataReplayCandidates(...)` | SIMPLIFY → `[url]` | |
| 2661 | `buildStructuredReplayHeaders(url, replayUrl, headers)` | INLINE → `headers` | No replay rewrite |
| 2736, 2783 | comment mentions | UPDATE | Refs to deleted code |
| 3821 | `isCanonicalReplayEndpoint(ep)` filter | DELETE downstream `canonicalReplayTriggers` set + `hasCanonicalReplaySibling` | |
| 3952 | `+160` ranking bonus | DELETE | Bonus only meaningful when registry exists |
| 4056, 4196 | `hasCanonicalReplaySibling` / sibling-pruning | DELETE | Driven entirely by registry |

### `src/orchestrator/index.ts`

| Line | Symbol | Decision |
|------|--------|----------|
| 14 | imports of `deriveStructuredDataReplayTemplate/Url` | DELETE imports |
| 656 | `hasStructuredReplay()` helper | DELETE function |
| 4852-4853 | `hasUsableEndpoints` canonical-replay branch | SIMPLIFY → drop branch |

### `src/types/skill.ts`

| Line | Symbol | Decision |
|------|--------|----------|
| 193 | `exec_strategy?` field | DELETE |

### `src/marketplace/index.ts`

| 169 | `exec_strategy: ep.exec_strategy ?? dupe.exec_strategy` | DELETE line |

### `src/workflow/compile.ts`

| 714 | `if (endpoint.exec_strategy) addStep(...)` | DELETE line |

### `src/client/index.ts`

| 869-878 | `exec_strategy` carry-forward + log | DELETE block |
| 895 | comment | UPDATE |

### `tests/`

| File | Decision |
|------|----------|
| `tests/public-structured-replay.test.ts` | DELETE entire file |
| `tests/marketplace-merge.test.ts` | UPDATE — drop `exec_strategy` from fixture+assert |
| `tests/analytics-e2e.test.ts` | UPDATE — drop `exec_strategy` from fixture |

### Out of scope for deletion

- `packages/skill/runtime-src/**` and `packed-src/**` — regenerated at pack time
- `CHANGELOG.md` historical entries — historical record, not code reference
- `src/execution/probe.ts` — Phase 7 replacement, untouched

## Dead-code keepers from Phase 7.1

`zigrep "void preferredWorkflowStrategy|void hasAuth|void hasStructuredReplay" src/` returned zero hits. Already cleaned. Task 5 is a no-op.

## Test baseline (pre-deletion)

`bun test tests/` baseline (2026-05-01) shows 64 failing tests. The bulk are infrastructure-related (cheerio `$.each is undefined`, Kuri spawn timeouts, missing browser binaries in this sandbox). Snapshot saved to `/tmp/baseline-failures.txt`. Acceptance: no NEW failures introduced by 08-03 vs this baseline.

The user-reported "3 in execution-* + 1 in resolve-fresh-capture" pre-existing-failure scope was incorrect for this sandbox — the actual baseline is 64. The plan still proceeds; we will diff against the 64-failure baseline.
