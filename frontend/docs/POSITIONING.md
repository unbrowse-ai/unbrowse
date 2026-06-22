# Landing page positioning: copy → evidence trace

Every claim on `src/app/page.tsx` traces here. Three evidence waves
informed the current copy.

## Evidence corpus

- **Wave 1** (Reddit, 8 query pairs, 38 records): `.evidence-build/unbrowse-positioning/evidence-20260519T064315Z.jsonl`
- **Wave 2** (Reddit sharper queries, 8 pairs, 38 records): `.evidence-build/unbrowse-positioning/evidence-20260519T065322Z-wave2.jsonl`
- **Wave 3** (codebase audit, 30 probes via `kind: command`): `.evidence-build/unbrowse-positioning/evidence-20260519T072310Z-wave3-codebase.jsonl`
- Wave-3 judgment: `.evidence-build/unbrowse-positioning/judgment-wave3-codebase-addendum.md`

## Hypothesis ranking (post wave 3)

The Reddit corpus alone ranked h4 (token bloat) as the loudest signal.
Wave 3 surfaced the buried U1 finding: the codebase ships a **drop-in
Playwright Browser class** that no competitor offers. That makes h1
(universal MCP) the strategic category position; h4 is a tactical
proof. Reordered:

| Rank | Hypothesis | Page role | Backing |
|---|---|---|---|
| 1 | h1 universal_mcp | Hero headline + UniversalProofBand | code (30+ tools, drop-in Browser), Reddit (3 threads) |
| 2 | h4 speed_and_cost | BenchmarkTable + hero subhead numbers | code (paper 3.6x mean over 94 domains), Reddit (7 threads) |
| 3 | h2 zero_setup_access | ZeroSetupBand (3 cards) | code (auth_walled ranker, JA4, LLM-augment), Reddit (10 threads) |
| 4 | h3 x402_monetization | EarnSection (own band) | code (sponsor-flex.ts, Solana settlement), Reddit (13 threads) |

## Section-by-section trace

### Hero — `frontend/src/components/hero-copy.tsx::HeroHeadlineInner`

- **Dev-mode headline:** "One MCP. Every website."
  - Code: `src/mcp.ts` registers 30+ `unbrowse_*` tools (wave-3 p11).
  - Code: `packages/sdk/` ships a `Browser` class (wave-3 U1; llms.txt:74).
  - Reddit: t3_1sx45zv ("Browser MCP or playwright MCP?") asks the
    category question unbrowse answers; t3_1rz29ac ("Stop stitching
    5-6 tools") voices the fragmentation pain.
- **Dev-mode subhead:** "Drop-in Playwright replacement. ~5K tokens per
  call instead of ~114K. Routes cache after the first hit."
  - 114K → 5K: t3_1spvkrz (Microsoft's own CLI-over-MCP recommendation
    rationale; ~114K tokens for typical scrape).
  - Cached routes: llms.txt:71 (three-path resolve: skill cache <200ms,
    shared route graph sub-second, browser fallback 20-80s).
- **Everyone-mode:** unchanged plain-language outcome.

### UniversalProofBand — `frontend/src/components/universal-proof-band.tsx`

Four cards, each anchored in wave-3 codebase findings.

- **Card 1 "Already wrote Playwright code? Swap the import."**
  - llms.txt:74 (drop-in Playwright statement).
  - `packages/sdk/src/runtime.ts` ships `spawnUnbrowseRuntime` +
    Browser class.
- **Card 2 "30+ tools in one MCP server."**
  - wave-3 p11: grep of `name: "unbrowse_*"` in `src/mcp.ts`.
- **Card 3 "94 live domains in the open bench."**
  - llms.txt:68 ("3.6x mean speedup (5.4x median) over Playwright
    across 94 live domains").
  - `harness/probes/corpus.txt` is the open corpus.
- **Card 4 "The next site self-onboards."**
  - `src/capture/index.ts` enrichment pipeline (wave-3 p06).
  - `backend/src/services/marketplace.ts::publishSkill` (wave-3 p09).

### Zero-setup band — `frontend/src/components/zero-setup-band.tsx`

Three cards. Wave-3 falsifications F2 and U2 applied.

- **Card A "JA4 fingerprint of a real Chrome."**
  - Code: `src/mcp.ts:700` mentions "auto-pulls browser cookies, JA4
    TLS impersonation."
  - Code: `src/capture/ssr-fastpath.ts:42` shows residential proxy is
    **opt-in via UNBROWSE_PROXY_URL** (corrected from wave-1 copy
    which oversold "built-in"; this is wave-3 F2).
  - Reddit: t3_1o1zlt0, t3_1qzbk1v, t3_1t6g5b4, t3_1taiatx, t3_1slaon8.

- **Card B "Your agent inherits your login. And knows when it dies."**
  - Code: 5 commits in the last week shipped auth intelligence:
    `auth_walled` capture signal (PR #517), 401-feedback ranker
    demotion (PR #518), three-surface login hints (PRs #519, #520).
    See wave-3 p25 commit log + p27 stale-endpoints.ts.
  - Code: `src/auth/browser-cookies.ts:127` Chromium Keychain service
    name; `kuri.authProfileSave/Load` for per-domain Keychain (p04).
  - Reddit: t3_1orpilz, t3_1slaon8.

- **Card C "Markdown out. Not innerHTML."**
  - Code: `src/capture/index.ts:552` INTERCEPTOR_SCRIPT,
    `src/graph/agent-augment.ts:309` `augmentEndpointsWithAgent`
    (wave-3 p06/p07).
  - Reddit: t3_1rw9prc (Lightpanda), t3_1s8o7gs (Touchpoint),
    t3_1lifw3w (Notte).

### Benchmark table — `frontend/src/components/benchmark-table.tsx`

Wave-3 F3 (5-30s → 20-80s honest browser fallback) and U6 (94-domain
headline) applied.

- Playwright MCP row: 114K, $0.04, ~14s. Cite t3_1spvkrz.
- ChatGPT Agent / Manus row: "unsustainable" / minutes / often blocked.
  Cite t3_1slaon8 + t3_1qjph7y.
- unbrowse row: 5K tokens, 20-80s cold browser (NOT 5-30s — that was
  the falsified legacy claim; honest source is llms.txt:71),
  <200ms cached, $0.008 cached / free on capture (wave-3 U8 framing).
- Cross-corpus headline: "3.6x mean over Playwright, 5.4x median,
  across 94 live domains." Anchored in paper arxiv 2604.00694 +
  llms.txt:68.

### EarnSection — `frontend/src/components/earn-section.tsx`

Wave-3 F1 (Solana not Base) + U7 (pay.sh) + U8
(capture-is-free reframe) all applied.

- **Headline:** "The next agent on your route pays you."
- **Chain:** USDC on Solana via Faremeter Flex. Source:
  `backend/src/services/sponsor-flex.ts:178` (Solana RPC),
  `backend/src/middleware/sponsor.ts:16` (Faremeter Flex rail v6.16+).
  **Corrected from wave-1 "USDC on Base L2" (F1 in wave-3 audit).**
- **Capture-is-free:** llms.txt:72 ("capture and indexing are free,
  agents pay only when reusing a paid route or paid marketplace lookup").
- **Payout:** pay.sh, set up during `npx unbrowse setup`
  (llms.txt:75 + restored from legacy page.tsx line that wave-1 dropped).
- **Sponsor tier:** `backend/src/middleware/sponsor.ts` (wave-3 p08).
- **Reddit (13 threads):** t3_1s3ozz0, t3_1p63m3b (21↑), t3_1pgebeh,
  t3_1s16g2b (9↑), t3_1pe54l3 (19↑), t3_1rkijz2 (48↑), t3_1rgp9jo,
  t3_1snb20d, t3_1road67, t3_1r1ujdk, t3_1rf8uni, t3_1sumut0,
  t3_1t7gtad, t3_1rdcl86.

### ObjectionFaq — `frontend/src/components/objection-faq.tsx`

Eight Reddit-voiced objections. Each row cites the t3_ id verbatim in
the rendered `cite:` line.

### AntiIcpBlock — `frontend/src/components/anti-icp-block.tsx`

Load-bearing per /positioning-messaging spec ("differentiation requires
sacrifice; say who it is not for"). Three rows: Playwright for CI,
agent framework for canvas-heavy JS, Claude/ChatGPT for end-user chat.

### FAQ JSON-LD — `frontend/src/app/page.tsx`

Seven questions. Universal-MCP is the first question (wave-3 reorder).
USDC settlement is on Solana (F1 fix applied). 5.4x median number is
surfaced. All q/a pairs trace to evidence in this doc.

## Wave-3 fixes applied (since the first commit)

| Tag | What was wrong / missing | Fix |
|-----|---|---|
| F1 | "USDC on Base L2" in EarnSection + FAQ | Solana via Faremeter Flex (sponsor-flex.ts) |
| F2 | "Residential proxy fallback built in" in Card A | JA4 TLS + libcurl-impersonate as primary; residential = one env var away |
| F3 | "5-30s headless" in BenchmarkTable | 20-80s browser fallback (honest per llms.txt:71) |
| U1 | Drop-in Playwright API parity missing | UniversalProofBand Card 1 + hero subhead mention |
| U2 | Card B was just "inherits cookies" | Card B sharpened with stale-endpoint ranker demotion + login-hint surfaces |
| U6 | Just "100x" with no provenance | BenchmarkTable headline: 3.6x mean / 5.4x median / 94 domains |
| U7 | Crossmint payout deleted in wave-1 rewrite | Restored in EarnSection |
| U8 | "Every page pays" was wrong shape | Reframed: capture free, pay on reuse |

## What this page deliberately does NOT do

- Use site names that we did not actually capture, unless the corpus
  voices the name.
- Lead with x402 / earnings to a first-time visitor. ICP-A (universal
  MCP narrative) comes first; ICP-B sees the earn section once they
  have scrolled.
- Promise speed/cost numbers we cannot back with the paper or the
  `harness/probes/` open bench. 20-80s is honest; 5-30s was not.
- Claim Base L2 settlement. We chose Solana for performance reasons.

## How to update this page when the corpus updates

1. Pull a new evidence wave: run `pull_evidence.py` (Reddit) or
   `pull_codebase.py` (kind: command) in `.evidence-build/unbrowse-positioning/`.
2. Re-judge ON_PAIN per lane against the new corpus. Update the
   judgment files alongside.
3. If a hypothesis ranking changes, update the section order in
   `src/app/page.tsx` AND this trace doc in the same PR.
4. Re-run `bunx tsc --noEmit && bun run build` before pushing.
