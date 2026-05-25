# Hallmark · brief — archival-editorial fusion (Unbrowse landing redesign)

Hybrid mood: **archival-editorial** — Editions cadence on Unbrowse surface.
Macrostructure: **Long Document** (chapter-led vertical spine)
Genre: **modern-minimal** (developer / API / B2B)
Theme route: **studied-DNA** (source: shopify.com/editions/winter2026, rebound to Unbrowse identity)
Nav archetype: **N5 Floating pill** (chapter rail, IntersectionObserver-driven)
Footer archetype: **Ft5 Statement** (dark closer; replaces the fixed-bottom chrome bar)

---

## 1. Pre-emit critique (target scores before implementation)

Score the **implementation** 1–5 per axis once the build is in. The targets:

| Axis | Target | What it means here |
|------|--------|---------|
| **P · Philosophy** | 5 | The page takes one position: *Unbrowse is the API layer agents read the internet through, organised as a chapter spine* — not a feature catalogue. |
| **H · Hierarchy** | 5 | Reader in 2s: H1 → eyebrow + numeral → chapter title → lede → figure → sub-rows. Repeated 7×. |
| **E · Execution** | 4–5 | Hairlines + clamp-fixed title + locked tokens. Penalty only if any inline colour escapes the token block. |
| **S · Specificity** | 5 | Could not be anyone else's landing — orange-on-near-black + CRT hands + chapter cadence is unique. |
| **R · Restraint** | 5 | 15 sections → 7 chapters. Word-stagger fade only (no translateY, no blur). One accent (orange). One hairline. |
| **V · Variety** | 4–5 | Differs from every prior wave: prior waves were either cream rebuilds (wave3+) or feature-band SaaS (banger-w1). This is the FUSION. |

Stamp at top of `page.tsx`:
```
/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 */
```

---

## 2. Locked token block (extend globals.css `:root` and `[data-theme="dark"]`)

Every colour and font in the redesign references one of these tokens. No inline hex, no inline oklch, no bare `font-family`. (Slop-test gate 58.)

```css
/* Hallmark · archival-editorial theme tokens
 * theme: studied-DNA (source: shopify.com/editions/winter2026)
 * paper: orange-on-near-black (NOT cream — Unbrowse identity preserved)
 * paper-band: dark (L≈3%) · display-style: condensed-display (Fonetika) · accent-hue: warm (orange 20°)
 */

:root[data-theme="dark"] {
  /* === Hallmark · archival-editorial chapter tokens === */
  --color-paper:          rgba(7, 5, 3, 1);          /* #070503 — chapter surface */
  --color-paper-2:        rgba(12, 8, 4, 1);          /* card surface inside chapter */
  --color-paper-3:        rgba(6, 4, 2, 0.85);        /* nested card */
  --color-ink:            #F5F3EF;                    /* primary text */
  --color-ink-muted:      #A89E92;                    /* secondary text */
  --color-ink-faint:      rgba(255, 188, 120, 0.55);  /* eyebrow / label / numeral */
  --color-accent:         #FF5200;                    /* orange — single accent, ≤5% footprint */
  --color-accent-warm:    #FFB060;                    /* hover state, hairlines-on-figure */
  --color-accent-ink:     #1a0d00;                    /* text on orange fills */

  --color-hairline:       rgba(255, 122, 32, 0.18);   /* primary chapter divider, full-bleed */
  --color-hairline-faint: rgba(255, 122, 32, 0.10);   /* nested row divider */

  --color-focus:          #FF8B4A;                    /* keyboard ring */

  --font-display:         'Fonetika', 'Google Sans Display', system-ui, sans-serif;
  --font-body:            var(--font-google-sans), system-ui, sans-serif;
  --font-mono:            var(--font-jetbrains-mono), 'JetBrains Mono', ui-monospace, monospace;
  --font-narrative:       var(--font-google-sans), system-ui, sans-serif; /* italic at narrative-1 */

  /* === Editions clamps (literal from SPEC.md §2, rebound to display = Fonetika) === */
  --text-headline-1:      clamp(4.5rem, 35.7895px + 9.5vw, 9.5rem);   /* hero H1: smaller than editions because Fonetika is wider */
  --text-headline-2:      clamp(3.25rem, 30px + 2.8vw, 5.25rem);       /* chapter H2 */
  --text-headline-3:      clamp(2rem, 18.5263px + 1.75439vw, 3rem);     /* sub-section H3 */
  --text-narrative-1:     1.5rem;                                       /* lede: 24px (editions is 28; we're orange-on-dark, lighter) */
  --text-narrative-2:     1.125rem;                                     /* sub-row prose */
  --text-eyebrow:         0.6875rem;                                    /* 11px mono cap labels */

  --lh-display:           0.94;
  --lh-narrative:         1.35;
  --tracking-display:     -0.03em;
  --tracking-narrative:   -0.01em;
  --tracking-eyebrow:     0.22em;

  --chapter-padding-y:    clamp(5rem, 8vw, 7.5rem);
  --chapter-gap:          clamp(2rem, 4vw, 4rem);
  --banner-height:        56px;                                          /* sticky nav offset */

  --dur-short:            150ms;
  --dur-curtain:          600ms;
  --ease-out:             cubic-bezier(0.4, 0, 0.2, 1);
}
```

---

## 3. New chapter sequence (the structural reorder)

Current 15-section spine → New 7-chapter spine. Each row: archetype · intent · what changes from current.

| # | Chapter | Archetype | Intent | Reorder / fuse / kill |
|---|---------|-----------|--------|------------------------|
| **00** | **Masthead** (Hero) | H1 Marquee + figure-card | One promise: "The API layer for AI agents." Word-stagger fade-in. CRT Sistine hands underneath. AgentWireTerminal inside figure-card (right). | **Fuse**: hero + AgentWireTerminal → single chapter. Strip HeroTerminalGated from above-fold (demote to ch04 figure). Drop the 2-CTA row → 1 primary CTA, 1 typographic-only link. |
| **01** | **The shadow API** (Premise) | Chapter (Long Doc) | Why this exists. The agent calls the JSON the browser would have called. ChatDemo as figure-card. | **New**: this chapter REPLACES the disconnected UniversalProofBand + UseCasesBand + ZeroSetupBand triad with one narrative chapter. Use one of the UseCasesBand examples as the figure. |
| **02** | **Install** | Chapter + InstallInstructions figure | `$ npx unbrowse setup --mcp`. Plugs into Claude Code, Cursor, Codex, Windsurf, OpenClaw. | **Reorder**: was section 3; now chapter 2. Drop the "Plugs into agent stack" pill row → merge into chapter lede prose. |
| **03** | **The numbers** | Chapter + HeroTerminalGated figure | 3.6× mean / 5.4× median / ~5K vs ~114K tokens / 18 of 94 sub-100ms cached (paper §7). Live counters: 600+ domains, 1M+ calls, 18K+ endpoints. Speed chart as figure. | **Fuse**: live-counters band + BenchmarkTable + 3.6x band + HeroTerminalGated → ONE numbers chapter. Drop the BenchmarkTable component (the numbers chapter quotes 4 numbers from it; the agent who cares opens `/papers`). |
| **04** | **Earn while you browse** | Chapter + InstallFigure / counter visual | Capture is free. Every shadow-API route your agent indexes goes to the public marketplace. When the next agent reuses your route → USDC on Solana via Faremeter Flex. Sponsor tier $1/day/agent. | **Reorder + keep**: EarnSection survives; reframe as chapter 4 with hairline-top + chapter numeral. |
| **05** | **The marketplace** | Chapter + RegistryShowcase figure | Twelve domains your agent can skip the browser on (PopularSkillsGrid). 600+ domains in registry. | **Fuse**: PopularSkillsGrid + RegistryShowcase + ThreePanelVisual → one marketplace chapter. ThreePanelVisual becomes a secondary figure under the registry grid. |
| **06** | **Answers** | Chapter + ObjectionFaq | The 8 FAQ entries already exist; reframe as a chapter with hairline-top numeral. AntiIcpBlock fused as a sub-card at the bottom ("who Unbrowse is not for"). | **Fuse**: ObjectionFaq + AntiIcpBlock → ONE chapter. |
| **07** | **Statement footer** | Ft5 Statement | Dark closer, full-bleed end-of-page. Not a fixed chrome bar. One sentence + GitHub + FAQ + Terms + Privacy + © year. | **Kill** the `fixed bottom-0` chrome footer. Replace with Ft5 at end of page flow. |

**Killed sections** (compared to current spine):
- BenchmarkTable component dropped from page render (numbers chapter quotes its 4 numbers).
- Standalone "Demo: airbnb.com" section dropped (ChatDemo absorbed into ch01).
- AntiIcpBlock as standalone section dropped (absorbed into ch06).
- Fixed-bottom footer chrome dropped (replaced by Ft5 closer).
- 3-CTA row in hero dropped (1 primary + 1 typographic-only).
- All `##  ...` mono-cap eyebrows per section dropped — replaced by chapter numerals (01 / 02 / ...) per editions discipline.

---

## 4. Motion budget (per editions DNA, gate-32 compliant)

- **Hero entrance**: word-stagger opacity-only on H1 + lede. NO translateY, NO blur (strip the existing `animate-fade-up` translate from the new chapter elements; keep `animate-fade-up` on legacy elements not touched this wave).
- **Chapter reveal**: each chapter wraps in `<ScrollReveal>` (already exists in `editions/scroll-reveal.tsx`). IntersectionObserver fires opacity 0→1 per chapter. NO scroll-tied parallax across chapters.
- **Sticky chapter nav**: pill rail with IntersectionObserver rootMargin "5%". Active pill flips `color: var(--color-ink-faint)` → `color: var(--color-ink)`. Already wired in `editions/editions-nav.tsx`.
- **Lenis smooth scroll**: already mounted via `editions/lenis-provider.tsx`.
- **`prefers-reduced-motion`**: existing globals.css block kills all animations to 0.001ms — covers gate 29.

---

## 5. Honest copy (gate-56 inventory)

Every metric on the page traces to this list:

- 3.6× mean over Playwright (n=94 domains, paper §7) ✓
- 5.4× median ✓
- ~5K tokens vs ~114K Playwright ✓
- 18 of 94 sub-100ms cached ✓
- 600+ domains in registry, 1M+ agent calls, 18K+ shadow endpoints — pulled live from `/v1/stats/summary` with these as honest fallbacks ✓
- USDC on Solana via Faremeter Flex (NEVER "Base L2") ✓
- Sponsor tier: $1/day/agent + $50/day/platform ✓
- AGPL-3.0, open source, runs locally ✓

Forbidden additions: no testimonial logos, no "trusted by N teams", no fabricated +X% conversion, no "save Y hours per week".

---

## 6. Mobile non-negotiable (gates 36, 59, 61–65)

Verified at 320 / 375 / 414 / 768:
- `html, body { overflow-x: clip }` already in globals.css ✓
- Display H1 wraps inside long words: `overflow-wrap: anywhere; min-width: 0` on `.hl-display`.
- Image-bearing grid tracks: figure cards use `minmax(0, 1fr)`.
- Chapter sub-rows collapse to one column under 48rem.
- Sticky chapter nav scrolls horizontally on mobile (already in `editions-nav.tsx`).
- All CTAs `white-space: nowrap` + shortened: "Start free" / "See it in action" — single-line.

---

## 7. Files to create / edit

**Create**:
- `frontend/src/components/hallmark/chapter-spine.tsx` — page composition: H1 + 7 chapters + Ft5.
- `frontend/src/components/hallmark/statement-footer.tsx` — Ft5 dark closer.

**Edit** (in-place):
- `frontend/src/app/page.tsx` — re-author composition to render `<ChapterSpine />` instead of the 15-section omnibus. Stamp at top.
- `frontend/src/app/globals.css` — append the locked-token block from §2. Add `.hl-*` utility classes.
- `frontend/src/components/editions/chapter.tsx` — rebind tokens (`--color-paper`, `--color-hairline`) so the existing chapter primitive works on near-black instead of cream. Single-source-of-truth: the token; not the component.

**Preserve** (do not edit / do not delete):
- `frontend/src/components/hero-hands.tsx`, `flowing-dot-field.tsx`, `agent-wire-terminal.tsx`, `chat-demo.tsx`, `three-panel-visual.tsx`, `registry-showcase.tsx`, `earn-section.tsx`, `objection-faq.tsx`, `anti-icp-block.tsx`, `install-instructions.tsx`, `install-figure.tsx`, `hero-terminal-gated.tsx`, `universal-proof-band.tsx`, `use-cases-band.tsx` — load-bearing assets, reframed inside chapters.
- `frontend/src/app/layout.tsx` — Navbar / SiteFooter / DocsEmbed stay mounted.
- `frontend/scripts/four-dim-gate.sh`, `screenshot-archival.mjs` — gate substrate, do not touch.

---

## 8. Build order (Step 6 of Hallmark Design flow)

1. Append token block to globals.css. Add `.hl-*` utility classes.
2. Create `hallmark/statement-footer.tsx` (Ft5).
3. Create `hallmark/chapter-spine.tsx` — imports existing editions/chapter primitive, composes 7 chapters, embeds the load-bearing components as figure-cards.
4. Re-author `page.tsx` — drop the omnibus composition, render `<ChapterSpine />`. Stamp at top.
5. Build (`bun run build`). Take screenshots at 1440 + 375.
6. Commit. Conventional prefix `feat(frontend): hallmark redesign — archival-editorial fusion`.
