# Hallmark · study — Shopify Editions Winter 2026 (deepened with Hallmark framework)

Source: <https://www.shopify.com/editions/winter2026>
Mode: URL (deepened with the literal-token extraction already captured in `SPEC.md`)
Refusal: ok — public reference, used to extract DNA only; pixels never copied.

This study sits ON TOP of `SPEC.md` (245 lines, literal hex/clamp/keyframe values). SPEC names the *what*; this file names the *why* through Hallmark's lens (macrostructure, archetype, type-role, motion stance, rhythm).

---

## 1. Schema (Hallmark study fields)

```
source_mode:        url
source_url:         https://www.shopify.com/editions/winter2026
source:             public-reference
refusal:            ok

remote_safety:      { public_web_url: true, scheme: https, scripts_ignored: true,
                      prompt_injection_detected: false }

macrostructure:     Long Document (chapter-led — vertical chapter spine on one surface)
macrostructure_alt: Catalogue numbered  (it leans Long Doc; chapters carry numerals but the
                                         page reads as ordered narrative, not a grid of items)

hero: {
  archetype:        H1 Marquee (display-led, single column),
  knobs:            { size: xxl (clamp 7.5rem→13.75rem),
                      alignment: left/centred, lede: serif,
                      reveal: word-stagger opacity-only,
                      sticky-nav-pill below: yes }
}

nav: {
  archetype:        N5 Floating pill (chapter-pill rail) — sticky scroll-padding 60px,
                    IntersectionObserver rootMargin "5%" flips active state
}

footer: {
  archetype:        Ft5 Statement (dark closer; only dark surface that bleeds the viewport)
}

display_role:       heavy condensed sans (NeueMontreal 700, line-h 0.9, tracking -0.03em)
display_face:       NeueMontreal
body_role:          italic editorial serif (narrative-1: HWCigars 28px)
body_face:          HWCigars
label_role:         uppercase mono-cap sans (eyebrows: NeueMontreal 14px, tracking 0.05em)
label_face:         NeueMontreal

pairing_logic:      two families (sans display + serif narrative); script (ImperialScript)
                    appears once as ornament — not load-bearing

paper_band:         light (>85% L)   — #dcdcd0 cream
paper_value:        #dcdcd0
paper_hue:          warm (slight green-yellow chroma; NOT pure grey)
accent_hue_band:    indigo / violet  (the brand purple #5433eb counter pill — 1 surface, ~2%)
accent_value:       #5433eb
accent_footprint:   small ≤5% (one badge pill; everything else is ink-on-paper)

density:            medium-generous
asymmetry:          left-biased / single-column body, full-bleed hairlines

treatments:         [ hairline-#909083-fullbleed, dark-figures-INSIDE-cards-only,
                      black→cream 600ms hydration curtain, cap-trim text-box,
                      pretty-wrap on every heading ]

reveal:             word-stagger fade (opacity 0→1 ONLY; no translate, no blur)
motion_library:     Lenis (smooth scroll) + IntersectionObserver + CSS keyframes
                    (NO framer-motion; word-split is plain <span> per word + animation-delay)

anti_patterns:      [ NONE visible — the page is anti-slop by construction ]
```

---

## 2. DNA — the five things that MAKE editions read as editions

Not the visible surface (the cream, the serifs) — the **structural moves** that travel:

1. **Chapter cadence on ONE surface.** The page is twelve chapters laid head-to-toe on a single paper-band. Body never switches to a dark surface mid-page. Dark only appears INSIDE figure-cards, contained by inline margin. The cream is the spine; everything else hangs off it.
2. **Full-bleed 1px hairline as the only divider.** No colour shifts, no gradient bleeds, no padding-rhythm tricks. The hairline IS the section break. Same hairline (`#909083`) between every chapter — disciplined repetition becomes signature.
3. **Two-register typography — sans display + serif narrative.** Display carries the title at clamp 96→120px. Lede drops register to a 28px italic serif. The register-flip *inside* the chapter is the editorial move; sans-on-sans would be SaaS, serif-on-serif would be magazine.
4. **Sticky chapter nav with IntersectionObserver rootMargin 5%.** A horizontal pill row of chapter names floats below the hero. As you scroll, the active pill flips from muted ink to full ink — slightly BEFORE the chapter heading hits viewport centre (rootMargin 5%). The nav becomes a live reading-position indicator.
5. **Load-anchored opacity-only word stagger.** Hero words fade in *in place* (no translate, no blur, no scale). 60–80ms stagger between words. The body kicks off black, transitions to cream over 600ms. This is the ENTIRE hero motion budget — there is no scroll-anchored parallax, no scroll-tied reveal cascade. Restraint as voice.

Everything else (the fonts, the cream value, the script flourish) is **dress**. Take the dress off and the editions-ness still travels.

---

## 3. Hallmark's diagnosis

You sent me the canonical 2026 chapter-spine page.

The macrostructure is **Long Document**, not Catalogue — chapters are ordered narrative, not a grid. The hero is an **H1 Marquee** at xxl scale with word-stagger entrance, lede in serif. Nav is **N5 Floating pill** in the chapter-rail variant; footer is **Ft5 Statement** in dark.

The page loads NeueMontreal (heavy condensed sans, weight 700) for display and HWCigars (italic editorial serif) for body. Roles: heavy condensed sans + italic editorial serif + uppercase mono-cap labels.

The paper is `#dcdcd0` — a warm cream with slight green-yellow chroma. The accent is `#5433eb` — indigo, used at <2% footprint (one counter pill). Everything else is ink-on-paper.

Motion: Lenis smooth scroll + IntersectionObserver + CSS keyframes. No framer-motion. Reveal pattern is **opacity-only word stagger** — load-anchored, not scroll-anchored. Anti-patterns: NONE in the CSS or scripts.

**Rhythm — density and asymmetry — judged from screenshots, not HTML.** Density reads medium-generous; the page is left-biased single-column. Chapter padding is uniform (~120px top, ~120px bottom) which on lesser pages would feel templated but here works because every chapter shares the same shape — the hairline + clamp-fixed title is the rhythm.

**The DNA is structural, not dressed.** Take cream → ink and replace with near-black → orange and every one of the five DNA moves still works.

---

## 4. Hybrid mood for the Unbrowse landing — archival-editorial

The Unbrowse identity is already archival:

- Surface: near-black `#070503` / `#090806` (orange-50/100 at L≈3%)
- Ink-equivalent: orange `#FF5200` / `#FFB060`
- Display: Fonetika (custom retro display, treated as the *condensed-sans-equivalent* in role-space)
- Mono labels: JetBrains Mono (the editions `eyebrow` analogue)
- Body: Google Sans
- Decoration: CRT Sistine hands (load-bearing), FlowingDotField (canvas background), halftone overlay

The editions DNA contributes:

- **Chapter cadence on one surface** → twelve chapters on near-black, no surface-switches.
- **Full-bleed 1px hairline** at `rgba(255,122,32,0.18)` — orange-tinted hairline replaces taupe.
- **Two-register type** → Fonetika display + Google Sans serif-or-italic lede (we don't ship a serif; lede goes italic Google Sans at 28px, line-h 0.96, tracking -0.05em — same RHYTHM as HWCigars, different dress).
- **Sticky chapter nav** with IntersectionObserver rootMargin 5%, pill rail above first chapter.
- **Word-stagger opacity-only entrance** on hero (existing `animate-fade-up` cascade already opacity+translateY — strip the translateY for editions discipline).

NOT cream. NOT serif body. NOT framer-motion. The orange-on-near-black identity STAYS; editions DNA reshapes the spine.

---

## 5. Anti-patterns from the current Unbrowse landing (Hallmark audit overlay)

These will be FIXED by the redesign, not preserved:

- **15-section omnibus spine** (hero → counters → install → proof → use-cases → zero-setup → benchmark → top-routes → earn → demo → registry → three-panel → faq → anti-icp → footer). No chapter discipline. No through-line. Reads as a feature catalogue.
- **Dual H1 figure in hero** (HeroTerminalGated + AgentWireTerminal side-by-side). Centred display + 2-column figure → gate 53 (centred-everything). Pick at most two centred elements; break alignment for the others.
- **Multiple mono-cap eyebrows per section** (`##  Live, cumulative, public`, `##  Top routes already cached`, `##  See it in action`, `##  MCP Install`). Gate 66 — eyebrows are default OFF. Chapter numerals are the editorial discipline; the `##` shell-prompt mock is fine ONCE (the install chapter), not on every section.
- **Fixed-bottom footer bar** (`fixed bottom-0 inset-x-0 z-40`) bleeds over content on every scroll. Editions footer is a `Ft5 Statement` closer — dark, end-of-page, NOT a chrome bar.
- **Section padding rhythm uniform but uninstructed** — every section pads `py-16 sm:py-24` or `py-20 sm:py-28`. Editions chapters pad to the same RULE, but the RULE is hairline + clamp-fixed title, not arbitrary py-N.

---

## 6. What carries forward (load-bearing assets — never delete)

Per the brief, these are archival identity and stay mounted INSIDE new chapters:

- `<HeroHands />` — CRT Sistine hands (load-bearing visual).
- `<FlowingDotField />` — canvas background that runs under everything.
- `<AgentWireTerminal />` — the "product in hero" piece; reframe as figure-card inside chapter-1.
- `<ChatDemo />` — reframe as figure-card inside the airbnb chapter.
- `<ThreePanelVisual />` — reframe as figure-card inside the architecture chapter.
- `<RegistryShowcase />` — top-routes grid, becomes the figure of the marketplace chapter.
- `<InstallInstructions />` — terminal block, becomes the figure of the install chapter.
- `<HeroTerminalGated />` — speed-chart, becomes the figure of the numbers chapter.

Existing `frontend/src/components/editions/{chapter,editions-nav,scroll-reveal,lenis-provider}.tsx` already implement the editions primitives (chapter wrapper with hairline, sticky chapter nav, IntersectionObserver hooks, Lenis smooth scroll). The Hallmark redesign REUSES these as the chapter substrate — but rebinds tokens from cream→ink to near-black→orange so the archival identity is preserved.

---

## 7. Verdict — adopt the DNA, drop the dress

The editions DNA travels cleanly into the Unbrowse archival surface. Five structural moves come over; cream + serif + hydration-curtain stay home. The Hallmark brief in `HALLMARK-BRIEF.md` codifies the chapter sequence, the new structural order, and the locked-token block.
