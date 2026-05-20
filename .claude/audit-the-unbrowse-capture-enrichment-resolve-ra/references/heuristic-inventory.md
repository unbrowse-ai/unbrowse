# Heuristic inventory — wave-4 audit pass (2026-05-20)

Sweep against the three canonical CLAUDE.md audit greps:

```bash
zigrep -E 'host === "[a-z]|skill\.domain === "[a-z]' src/ | grep -v 'auto"|unknown"|codex"|claude"|"http'
zigrep -E 'computeConfidence|case "spa-|case "json-ld|case "itemlist' src/
zigrep -E 'REFUSAL_OPENERS|SUBSTITUTE_NOUNS|BANNED_PHRASES|q -> rawQuery|q -> rawQuery' src/
```

## Result tally

| Surface (CLAUDE.md "eight forbidden") | Hits | Status |
|---|---|---|
| Per-host arms (`host ===`, `skill.domain ===`) | 0 real (10 raw, all install-host = `codex` / `claude` / `openclaw` / `auto` / `unknown`, exempt) | CLEAN |
| Confidence type-switch (`computeConfidence`) | 0 (was 1; wave-5 ported to signal-derived 2026-05-20) | CLEAN |
| Refusal / substitute / banned lists | 0 | CLEAN |
| `q -> rawQuery` alias table | 0 | CLEAN |
| Hand-maintained alias map (related class) | 1 (`BINDING_ENTITY_ALIASES`, graph/index.ts:597) | SURVIVES |
| Ranker magic-number arms over regex haystacks | LinkedIn / X / company / profile / feed / article / detail cluster, execution/index.ts:6045-6105 (W3) — KEY-LIST PATH REGEX (W4) CLEAN as of wave-6 2026-05-20 | W3 SURVIVES |

The canonical Ranker-philosophy audit grep `grep -nE 'host === "[a-z]' src/ | grep -v 'auto"|unknown"|codex"|claude"'` returns **0 hits**. Per-host registries are extinct in src/ (Phase 8.3 invariant holds). Peer-codex PRs #569 (dev.to), #580 (xprofile), #584 (LinkedIn), #577 (pypi degenerate-row) shipped the deletions.

## Surviving prescriptive heuristics (wave candidates)

### W1 — `computeConfidence` hardcoded extractor-type ladder  ✅ DONE (wave-5, 2026-05-20)
**File**: src/extraction/index.ts:2787 (function `computeConfidence`)
**Shape (was)**: `switch (structure.type) { case "spa-nextjs": 0.9; case "json-ld": 0.9; case "article": 0.9; case "itemlist": 0.9; case "table": 0.8; case "repeated-elements": 0.7; case "key-value": 0.7; case "meta": 0.6; case "list": 0.5; default: 0.3 }`. New extractor types silently fell to 0.3 and missed the 0.5 promotion gate.
**Replaced with**: signal-derived `inspectExtractedShape(data)` returning one of `array_of_objects` | `array_of_primitives` | `object_with_keys` | `scalar_or_empty`, contributing 0.3 / 0.15 / 0.1 / 0 based on shape richness (avg keys per item for arrays of objects; key count for objects). Combined with the existing element-count and relevance-score signals. The 0.5 gate is now clearable by any extractor that returns structurally rich data, regardless of `structure.type`.
**Verify result**: tsc baseline 224 → 224 (0 delta, all 3 extraction errors at the pre-existing L1766 site unrelated); 47/47 extraction-focused tests pass (`extraction-aggregator-link`, `extraction-article-body`, `extraction-config-shape-demotion`, `extraction-degenerate-row-demote`, `extraction-intent-specials`, `extraction-spa-array-branch`, `extraction-spa-payloads`, `extraction-specials`).

### W2 — `BINDING_ENTITY_ALIASES` hand-maintained alias map
**File**: src/graph/index.ts:597-623, consumed at line 652 (`canonicalBindingEntity`)
**Shape**: literal map `{ repo -> repository, owner -> repository, profile -> profile, person -> profile, member -> profile, user -> profile, account -> profile, org -> company, organization -> company, item -> listing, product -> listing, server -> guild, tweet -> post, status -> post, update -> post, trend -> topic, ... }`. Forbidden surface #4 (substituted nouns) plus a second-tier "owner == repository" tells a domain-model lie LLMs can spot but the graph hardcodes.
**Generic primitive to replace**: surface the raw `binding.entity` name + `binding.semantic_type` + sample values on every `OperationBinding` evidence object. Let the LLM judge equivalence (it already does this when picking endpoints). For the DAG-edge join, key on STRUCTURAL equality (same captured param-name string after lower+singularize) OR same `semantic_type` enum, both of which are evidence-derived. If two bindings disagree, expose them as distinct candidates with `match_basis: "name_singular"` / `"semantic_type"` rather than silently merging via the alias map.
**Risk**: MEDIUM. Used in graph join logic; agent-side execute path is already clean (it never consults this map). Need bench-local delta over multi-step graph traversals (repo -> issues, owner -> repo, list -> detail).

### W3 — Ranker per-intent regex-haystack magnitudes (LinkedIn / X / feed cluster)
**File**: src/execution/index.ts:6045-6105 (the dense block under `COMPANY_INTENT` / `PROFILE_INTENT` / feed-intent / article-intent / question-intent guards)
**Shape**: 14 lines of magic numbers `score += 110 / 95 / 80 / 170 / 180 / 900 / 120 / 55 / 40` and `score -= 35 / 70 / 90 / 140 / 150 / 180 / 200 / 320 / 900`, gated on regex matches like `(organizationdashcompanies|universalname|companyprofile|...)`, `(voyagerfeeddashmainfeed|voyagerfeeddashfeedupdates|...)`, `(userbyscreenname|profile|profiles|memberprofile|...)`. Concrete substrings: `voyagerfeeddashmainfeed` (LinkedIn), `userbyscreenname` (Twitter/X), `usersbyrestids` (X), `aboutthisprofile` (LinkedIn). This is the "per-domain registry disguised as a regex" pattern — same bug at a different layer.
**Generic primitive to replace**: collapse to 2 evidence-derived signals already in scope — (a) BM25 of intent tokens over the endpoint's *captured semantic metadata* (response_schema property names, agent-augmented description); (b) URL-path keyword overlap with intent. Both are present (lines 5658, 5774). Emit the matched-token list + per-token weight as part of the shortlist evidence so the agent LLM sees WHY each candidate ranks where it does. Delete the per-vendor regex magnitudes; the BM25 of "voyager" / "userbyscreenname" against intent already happens generically.
**Risk**: HIGH blast radius — touches the master ranker on every resolve. SCOPE-CONFIRM with Lewis before doing W3. Must run full bench-local + MCP gate.

### W4 (borderline) — Ranker keyword-list path regex  ✅ DONE (wave-6, 2026-05-20)
**File**: src/execution/index.ts:5774 (was; now comment block at L5773-5780)
**Shape (was)**: `if (/\/api\/v?\d*\/(search|products?|items?|results?|catalog|listings?|goods|feed)\b/i.test(pathname)) score += 25;`. The structural `/api/v\d*/` part is generic; the 8-keyword inner list was prescriptive (preferred 8 specific resource nouns over equally-valid alternatives like orders/accounts/users).
**Replaced with**: removed entirely. The remaining evidence-side signals cover the case structurally — `DATA_INDICATORS` (line above), `response_schema` richness (+5/+10/+20 at L5714-5720), BM25 over intent vs endpoint text, `API_SUBDOMAIN` bonus (+10/+40 at L5759/5761), `dom_extraction` bonus (+25 at L5707). Resource-noun intent matching is BM25's job. Also dropped a dead-code `if (rawTokens.length > 0 && !intent?.match...) { /* comment-only */ }` no-op arm that lived alongside it.
**Verify result**: tsc 224 → 224 (0 delta); 46/47 ranker tests pass + 1 pre-existing failure (`rank-cross-subdomain-and-deep-leak` A10 youtube subdomain demote) confirmed identical pre/post change; 12 execution-correctness tests pass (intent-truth, quality, strategy, probe).

## Clean / no longer flagged

- `next_step` / `_workflow_hints` prose templates — 11 hits across 3 files, all structured (`payments/index.ts:7`, `execution/recipe-replay-hints.ts:1`, `api/browse-snap-diagnostics.ts:3`). `_workflow_hints` literal: 0 hits. Prose-template surface is no longer present in src/.
- BM25, URL-path overlap, schema richness, host-pattern (`API_SUBDOMAIN`), response-shape bonuses, `decomposeGraphqlEndpoint`, `buildSkillOperationGraph`, `extractEndpoints` generic filters — kept (allowed primitives per CLAUDE.md "Ranker philosophy IN").
## Recommended wave order

1. ~~**W1 computeConfidence**~~ — DONE wave-5 2026-05-20 (signal-derived).
2. ~~**W4 ranker keyword-list path regex**~~ — DONE wave-6 2026-05-20 (deleted; structural signals carry it).
3. **W2 BINDING_ENTITY_ALIASES** — medium, graph-only; execute path unaffected. Next.
4. **W3 ranker per-intent regex magnitudes** — last, scope-confirm. Highest blast radius on the gate.

## Verdict

W1 + W4 closed. Two forbidden-surface instances survive (W2, W3). Per-host arms, refusal lists, alias tables, prose templates, keyword-list path regex remain CLEAN. The scaffold stays `status: pending` until W2 ships and W3 is scoped.
