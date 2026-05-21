# Substrate principle audit — 2026-05-21

> Lewis 2026-05-21: "do a thorough check on the codebase for things to
> refactor because of principle violation (eg. specialisation to a
> specific website) make this a principle to refactor occasionally
> when things are messy"
>
> Standing maintenance loop crystallised: `20260521T000653Z-f88dbda8`
> APPLIED to principle store.

This audit enumerates concrete violations of the **eight forbidden
surfaces** rule from `~/.claude/CLAUDE.md` and project `CLAUDE.md`
"Ranker philosophy: heuristics OUT, primitives + LLM judge IN" +
"never hardcode" rule.

## Method

Greps run from repo root:
- `zigrep 'host(name)? *===' src/` — direct host string-equality
- `zigrep "u\\.hostname === " src/execution/index.ts` — per-host arms
- `zigrep "function extract.*Special" src/extraction/index.ts` — host-specific extractors
- `zigrep "BANNED\\|REFUSAL\\|_ALIAS_" src/` — banned-list / alias-table registries
- `zigrep "the correct sequence\\|N-step procedure" src/` — numbered-procedure prescriptions

Excluded as NOT violations:
- Localhost / 127.0.0.1 comparisons (not per-website specialisations)
- `host === "codex" / "claude"` (Claude Code / Codex runtime identifiers)
- `host === "openclaw"` (MCP host config)
- `accounts.google.com|github.com|facebook.com` inside the AUTH_PROVIDERS regex at `src/execution/index.ts:1743` (universal auth-provider classifier)

## CRITICAL

### V1. `src/execution/index.ts:838-1200` — `derivePublicApiEndpointsFromUrl`: 8-host registry

**Function**: `derivePublicApiEndpointsFromUrl(url, intent, authRequired)` at L838.

**Pattern**: 8 hardcoded `u.hostname === "<host>"` arms emitting a built-in "public API" endpoint when URL matches. Each arm carries the literal host, a public REST API URL template, an intent-keyword regex gate, and a hardcoded response_schema.

| Line | Host | Path/intent gate |
|---|---|---|
| 882 | `crates.io` | `/search`, intent ~ crate/package |
| 938 | `stackoverflow.com` | question pages |
| 979 | `openlibrary.org` | works pages |
| 1011 | `beatsaver.com` | intent ~ map/search |
| 1049 | `jup.ag` | swap |
| 1088 | `www.espn.com` | `/nba/scoreboard`, intent ~ scoreboard/nba |
| 1121 | `hub.docker.com` | tags pages |
| 1179 | `dev.to` | user pages |

**Why a violation**: per CLAUDE.md ranker philosophy: "every site-specific shortcut you add is a tax we pay forever. The 11th site gets it wrong, the agent calls a stale URL, no one notices."

**Substrate-faithful replacement** (3 phases):
1. **Phase 1 — registry as declarant JSON.** Convert each arm to a `proposed_endpoint` row in `assets/known-public-apis/*.json` that resolve surfaces to the agent as evidence. Substrate stays clean; the registry becomes a teachable list the agent can ignore.
2. **Phase 2 — live structural detection.** Probe `/.well-known/openapi.json`, `/openapi.yaml`, `/api/v1/`, `link rel="api"`, sitemap api hints. When found, surface the OpenAPI spec to the agent.
3. **Phase 3 — delete the arms** once Phase 2 covers known hosts generically.

### V2. `src/extraction/index.ts:761-880` — `extractGitHubSpecial`: 120 lines GitHub-specific

**Pre-filter**: `/github/i.test(html)` + `data-target="react-app.embeddedData"` (GitHub React marker). Builds `https://github.com/${owner}/${name}` URLs.

**Why a violation**: the substring guards + the hardcoded URL fallback bind this to GitHub. The function name flags it.

**Substrate-faithful replacement**:
- Strategy 1: Generic JSON-LD `SoftwareSourceCode` / `CodeRepository` / `WebSite` (GitHub already emits these in `<script type="application/ld+json">` blocks).
- Strategy 2: og:type=`object` + Twitter card meta — covers GitHub's social card.
- Strategy 3: Generic repeating-`<li>` with name+description+stars pattern (works for GitHub search results + Gitea + Bitbucket + Sourcehut + Codeberg).
- Delete `extractGitHubSpecial`, register the three generic primitives.

### V3. `src/extraction/index.ts:1014-1039` — `extractPackageSearchSpecial`: PyPI-specific via CSS class

**Pre-filter**: `/package-snippet/i.test(html)` (PyPI's CSS class). URL fallback hardcoded to `https://pypi.org/project/...`.

**Why a violation**: `package-snippet` is a PyPI-private class name. The function only fires on PyPI by design.

**Substrate-faithful replacement**:
- JSON-LD `SoftwareSourceCode` array (npm, pypi, rubygems, crates all emit this).
- Microdata `itemtype="https://schema.org/SoftwareApplication"`.
- Generic repeating `<li><h3>NAME</h3><p>DESCRIPTION</p></li>` card extractor (partially covered by `extractCardFields`).

## MODERATE

### V4. `src/reverse-engineer/index.ts:1414` — `hostname === "play.google.com"`

`if (hostname === "play.google.com" && pathname.startsWith("/log")) return false;` — filters Google Play telemetry from reverse-engineering.

**Why borderline**: filters a known-noise endpoint, not a registry-of-one driving rankings. Still substrate code referring to a specific host.

**Substrate-faithful replacement**: extend noise-pattern detector to match by URL path/QS shape (`/log?...telemetry-shaped...`) regardless of host, OR move to a declarant filter list.

## ALREADY CLEAN

These were violations and have been removed; cited comment markers prove the conversion:
- `src/extraction/index.ts:1277` — comment "No `host === "dev.to"`, no `crayons-story` CSS hint" marks `extractDevToPostSpecial` → generic
- `src/extraction/index.ts:1042-1070` — comment marks `extractXProfileSpecial` (X.com/Twitter.com) → `extractPersonProfileSpecial` (generic schema.org/Person + OpenGraph + Twitter card meta)
- `src/extraction/index.ts:2894-2933` — `computeConfidence` switch-on-type ladder removed; signal-derived (shape richness + element count + intent BM25)
- Phase 8.3 — `deriveStructuredDataReplay` 16-host registry deleted

## NOT FOUND (forbidden-surface classes absent)

- A4 BANNED_PHRASE / REFUSAL_OPENER / SUBSTITUTE_NOUN literal lists — zero hits in src/, backend/src/
- A5 prescribed contracts hiding existing surface — none surfaced
- A7 numbered-procedure prose ("the correct sequence is exactly N calls") — none
- A8 format templates writing prose for another agent — none

## Refactor backlog (prioritised)

| Priority | Violation | Effort | Gate impact |
|---|---|---|---|
| **P0** | V1 phase 1 (registry → declarant JSON) | 1 PR, ~200 LOC | Removes 8-host substrate registry |
| **P1** | V2 `extractGitHubSpecial` → generic JSON-LD | 1 PR, ~150 LOC | Probes 005 + 014/015 |
| **P1** | V3 `extractPackageSearchSpecial` → generic | 1 PR, ~80 LOC | PyPI + extends to npm/crates/rubygems |
| **P2** | V4 `play.google.com` filter → generic noise pattern | 1 PR, ~20 LOC | Marginal |
| **P3** | V1 phase 2 (live OpenAPI detection) | multi-PR | Covers new sites generically |
| **P3** | V1 phase 3 (delete registry) | 1 cleanup PR | After Phase 2 stable |

## Audit cadence

Per crystallised principle `20260521T000653Z-f88dbda8`:
- **Trigger**: codebase messy, OR every 5+ ralph ticks without explicit gate-failure-driven fix, OR a peer adds a new `host === "..."` arm (catchable by `principle-queue.sh propose-if-locked`)
- **Source-of-truth grep**: `zigrep "hostname === \"[a-z]" src/`
- **Output**: refreshed in-place under `.audit/substrate-violations-<YYYYMMDD>.md`

Next audit due: 2026-05-26 (5 days), or earlier on peer violation detect.
