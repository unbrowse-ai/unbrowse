# Shopify Editions Winter 2026 — Design Spec (for Unbrowse Editions rebuild)

Source: <https://www.shopify.com/editions/winter2026>
Evidence pulled from live bundles 2026-05-25:

- HTML: `https://www.shopify.com/editions/winter2026`
- CSS (Tailwind v4 bundle): `cdn.shopify.com/oxygen-v2/47215/49013/102837/3614982/assets/tailwind-G-N6aznT.css` (129 KB)
- Fonts CSS: `…/fonts-latin-CzfLCQn_.css`
- Components JS: `…/components-BdJai906.js` (252 KB)
- Page route JS: `…/(_locale).editions.winter2026-DLd_vpjA.js` (243 KB)
- Rive runtime JS: `…/rive-DN8nxF7J.js` (175 KB)
- Local copies: `/tmp/editions.html`, `/tmp/editions-tailwind.css`, `/tmp/editions-fonts.css`, `/tmp/editions-components.js`, `/tmp/editions-page-2.js`, `/tmp/editions-rive.js`

All values below are literal extractions, not paraphrases. Where a token is reverse-engineered from class usage rather than a `--var`, the source class is cited.

---

## 1. Surface tokens (literal hex)

The page uses a **paper-and-ink** palette, no oklch surface tokens. Tailwind oklch tokens exist in `:root` but are NOT used for surfaces — surface colors are raw hex applied via Tailwind v4 utility classes (`.bg-g1`, `.bg-dark`, …).

| Token                  | Hex          | Where it lives                                                                            |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| **Cream / paper (primary surface)** | `#dcdcd0`    | `body { background-color: #dcdcd0 }` — this is THE page surface                          |
| **Cream-light (cards / nested)**    | `#e2e2d9`    | Secondary card surface                                                                    |
| **Cream-warm (highlight cards)**    | `#f7f7ee`    | High-contrast accent surface (e.g. on dark figures, or as inverted text color on `#292919`) |
| **Ink (text on cream, primary)**    | `#292919`    | `.bg-dark { background-color: #292919 }` — dark olive-black; this is also fg on cream    |
| **Ink-muted**                        | `#5c5c4e`    | Hairline + muted body text                                                                |
| **Hairline (default divider)**       | `#909083`    | `border-color: #909083` — taupe-grey, NOT pure grey                                       |
| **Hairline (faint, on-cream)**       | `#2929191a`  | `border-color: #2929191a !important` — ink at 10 % opacity, used for ultra-subtle rules  |
| **Hairline (faint, on-dark)**        | `#ffffff1a`  | 10 % white on dark figures                                                                |
| **Accent (brand purple)**            | `#5433eb`    | `.counter { background-color: #5433eb }` — used for the badge/counter pill ONLY          |
| **Accent (secondary purple)**        | `#8051ff`    | One-off hover/active state                                                                |
| **Accent (blue figure)**             | `#57afdf`    | `.bg-blue { background-color: #57afdf }` — used inside specific figure backgrounds        |
| **Pure black (only inside dark figures)** | `#000`  | NOT a chapter surface; only used as a body-load colour (see §9) and inside contained figures |

Initial-paint body declaration (load animation):

```css
body{
  background-color: var(--color-black);   /* starts black */
  transition: background-color .6s var(--ease-in-out);
}
body{ background-color: #dcdcd0 }         /* settles to cream on hydration */
```

Surface rule for the rebuild: **`#dcdcd0` is the canonical surface; every chapter sits on it; dark only appears inside individual figures.**

---

## 2. Typography

Three custom faces, plus one Japanese fallback. Source: `/tmp/editions-fonts.css` + the type-scale utility classes in `tailwind-G-N6aznT.css`.

### Font families

| Role          | Family               | Weight | File                                                       |
| ------------- | -------------------- | ------ | ---------------------------------------------------------- |
| Display + UI  | **NeueMontreal**     | 700    | `…/3ee238256136fcfdfca35decbd44d0d4.woff2`                  |
| Editorial / narrative serif | **HWCigars** | 400    | `…/49a57a6e59f6a50f0627418abeb58fec.woff2`                  |
| Decorative script (initials, ornaments) | **ImperialScript** | 400 | `…/389d4f8566b3b9cbe083b682c7fabf06.woff2`                |
| JP fallback   | NotoSansJP, Hiragino Sans | -  | system                                                     |

Stack literals to use verbatim:

```css
font-family: NeueMontreal, Helvetica, Arial, sans-serif;        /* display */
font-family: HWCigars, Georgia, "Times New Roman", serif;       /* narrative */
font-family: ImperialScript, Georgia, serif;                    /* script */
```

### Type-scale (literal clamp ranges from the bundle)

| Class           | Family          | Base       | Clamp                                                | Line-h | Tracking |
| --------------- | --------------- | ---------- | ---------------------------------------------------- | ------ | -------- |
| `.headline-1`   | NeueMontreal-700| 72 px      | `clamp(7.5rem, 35.7895px + 10.9649vw, 13.75rem)`     | 0.9    | -0.03em  |
| `.headline-2`   | NeueMontreal-700| 64 px      | `clamp(6rem, 75.7895px + 2.63158vw, 7.5rem)`         | 0.9    | -0.03em  |
| `.headline-3`   | NeueMontreal-700| 54 px      | `clamp(4.375rem, 48.1053px + 2.85088vw, 6rem)`       | 0.9    | -0.02em  |
| `.headline-4`   | NeueMontreal-700| 32 px      | `clamp(2rem, 18.5263px + 1.75439vw, 3rem)`           | 0.95   | -0.03em  |
| `.headline-5`   | NeueMontreal-700| 24 px      | `clamp(1.5625rem, 21.6316px + 0.438597vw, 1.8125rem)`| 0.95   | -0.02em  |
| `.narrative-1`  | HWCigars-400    | 28 px      | (no clamp; ~28 px static)                            | 0.96   | -0.05em  |
| `.narrative-2`  | HWCigars-400    | 24 px      | (no clamp)                                           | 0.97   | -0.05em  |

Body (`body`): 14 px, antialiased.
Pretty wrap on every heading: `text-wrap: pretty; text-box: trim-both cap alphabetic;` (the cap-trim is the editions signature).

**Hero clamp** (use literally): `font-size: clamp(7.5rem, 35.7895px + 10.9649vw, 13.75rem)` — 120 px → 220 px.
**Chapter-title clamp** (use literally): `font-size: clamp(6rem, 75.7895px + 2.63158vw, 7.5rem)` — 96 px → 120 px (`headline-2`).
**Lede / narrative**: `narrative-1`, 28 px HWCigars, line-height 0.96, letter-spacing -0.05em.

---

## 3. Chapter anatomy

Each chapter section sits on cream `#dcdcd0`, separated by a top hairline. The dominant chapters in the source page: Sidekick, Agentic, Online, Retail, Marketing, Checkout, Operations, Shop app, B2B, Finance, Shipping, Developer.

```
┌──────────────────────────────────────────────────────────────────────┐  ← hairline #909083, 1px, full-bleed
│                                                                      │
│  ┌── EYEBROW ──┐    [01]                                             │  ← eyebrow: NeueMontreal-700, 14px, tracking 0.05em, uppercase
│   SIDEKICK                                                           │     number: same family, faint (color: #5c5c4e), top-right or top-left
│                                                                      │
│   Sidekick                          [HEADLINE-2 / 96→120px]          │  ← chapter title: .headline-2 (NeueMontreal-700, line-h 0.9, tracking -0.03em)
│                                                                      │
│   The AI-powered Shopify expert     [.narrative-1 / 28px HWCigars]   │  ← lede: serif HWCigars, line-h 0.96, tracking -0.05em
│   who's just as obsessed with                                        │
│   your business as you are.                                          │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │                                                              │   │
│   │     [ FIGURE / VIDEO / RIVE ANIMATION ]                      │   │  ← figure: black or dark-figure surface ALLOWED here
│   │       (dark surface #292919 lives INSIDE this card,          │   │     but NEVER the whole section
│   │        not as the chapter background)                        │   │
│   │                                                              │   │
│   └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   ◦ Smart suggestions     ◦ Custom app generation                    │  ← sub-features: .headline-5 + .narrative-2
│   ◦ Workflow automations  ◦ …                                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘  ← hairline #909083
```

Rules:

- The **number** is a small NeueMontreal numeral, never a circular badge.
- The **figure ALWAYS sits inside a contained card** with its own rounded radius (`--radius-xl: .75rem`). Dark surfaces live INSIDE these cards; they do not bleed to the chapter edges.
- Lede is HWCigars serif — this is the editions signature. Sans-serif lede = wrong.
- Sub-feature rows use `.headline-5` (24 px sans) for the label and `.narrative-2` (24 px serif) for the description, sitting on a `.bg-g1`/`.bg-g2` nested card or directly on cream with a faint hairline.

---

## 4. Sticky chapter nav

From the HTML: every chapter has an `#anchor` (`#sidekick`, `#agentic`, `#online`, …). The hero contains a chapter-link block that becomes the source-of-truth for navigation.

- **Position**: `position: sticky` at the top. `html { scroll-padding-top: 60px }` (desktop) / `50px` (≤ md), so anchor jumps don't hide under the nav.
- **Layout**: A horizontal pill row of all chapter labels (`Sidekick · Agentic · Online · …`). On mobile this becomes a single-row horizontally-scrollable strip.
- **Active-chapter detection**: hand-rolled `IntersectionObserver` with `rootMargin: "5%"` (literal in `editions-page-2.js`). The observer flips the active class on the matching nav pill as the chapter enters the viewport top.
- **Active style**: text color goes from muted `#5c5c4e` to ink `#292919`; underline OR an underlay pill is shown. (No JS-driven background colour change at section level.)
- **Smooth scroll**: Lenis is mounted globally (`window.lenis`); anchor clicks call its `scrollTo()` to ride the same easing as wheel scroll.

---

## 5. Hero motion (entrance)

The hero is **load-anchored**, not scroll-anchored. Source: keyframes in `tailwind-G-N6aznT.css` + orchestration in `editions-page-2.js`.

- Body kicks off black `#000`, then transitions to cream `#dcdcd0` over `.6s var(--ease-in-out)` on hydration. This is the global page reveal — feels like a curtain pulling back.
- Hero word entrance: `@keyframes stagger-fade-in { 0%{opacity:0} to{opacity:1} }` applied per-word with a staggered `animation-delay`. **Transform is pure opacity** — no `translateY`, no blur, no mask. Words appear in place.
- `nav-item-in` keyframe (used on the chapter-nav pills): `0% { opacity:0; transform: translateY(-100%) } to { opacity:1; transform: translateY(100%) }`. The pills slide down past their resting position and settle.
- `media-entrance` keyframe (figures): `0%{opacity:0} to{opacity:1}` — fade only.
- Easing: the page-default is `cubic-bezier(.4, 0, .2, 1)` (Tailwind `ease-in-out`); the chapter-nav pill uses an overshoot `cubic-bezier(.34, 1.56, .64, 1)`.
- **No SplitText library is present.** The "word split" effect is plain DOM: each word is an inline-block `<span>` with its own `animation-delay`.
- Stagger ms: the `--default-transition-duration` is `.15s` and the body-curtain runs `.6s`; the per-word stagger is implemented via CSS `animation-delay` increments (typical 60–80 ms per word; not encoded as a single token in the bundle).

---

## 6. Scroll motion across chapters

There is **no global scroll-tied parallax timeline**. Entry animation is per-element via IntersectionObserver, then CSS keyframes do the actual reveal.

What fires on entry:

- Chapter heading: `stagger-fade-in` (opacity 0 → 1) on the title's word `<span>`s.
- Figure cards: `media-entrance` (opacity 0 → 1).
- Sub-feature rows: same opacity keyframe, delayed.
- `timeline-start` keyframe exists for one specific 3D-feeling element: `0% { opacity:0; translate: 0 75cqw; rotate: x -90deg; scale: 1.5 } to { opacity:1; translate:0; rotate:x 0deg; scale:1 }`. Use sparingly — only for a single hero/intro element, NOT every chapter.
- Hairline dividers: NOT animated. They are static `1px` borders. No `line-fade` on dividers (that keyframe is for SVG stroke elements inside figures, not for section rules).

Easing for all scroll-entries: `cubic-bezier(.4, 0, .2, 1)`.
Scroll smoothness: **Lenis** is mounted globally (`window.lenis`, `window.lenisVersion`). It wraps `requestAnimationFrame` and gives wheel/touch a unified inertia. This is what makes the page feel "buttery" — without it, the cream surface looks ordinary.

---

## 7. Hairline dividers

- **Primary**: `1px solid #909083`, **full-bleed** (edge to edge of viewport, NOT inset).
- **Faint**: `1px solid #2929191a` (ink @ 10 %), used inside cards between sub-features.
- **Placement**: BETWEEN chapters (top of every chapter section). Within a chapter, faint hairlines separate the sub-feature rows beneath the figure.
- **Never** use dashed or thicker rules. Always `1px`. Always solid.
- The hairline is what makes the page feel "editorial" — losing it collapses the editions feel.

---

## 8. Motion library

**Hand-rolled, not framer-motion.** Evidence:

- `framer-motion` / `motion/react` / `whileInView` / `useScroll` / `useInView` / `AnimatePresence`: **0 hits** across all bundles (page, components, entry).
- `IntersectionObserver`: 3 hits in `components.js`, 2 hits in `rive.js`, many in `editions-page-2.js`.
- `requestAnimationFrame`: heavily used (custom RAF loops for the orbital-dot + skilltag systems).
- **Lenis**: 26 occurrences in `editions-page-2.js`. Mounted at `window.lenis`. Provides smooth-scroll + wheel inertia.
- **Rive**: separate runtime (`rive-DN8nxF7J.js`, 175 KB) drives the figure animations (Sidekick mascot, etc.). Not strictly required for the editions LOOK — the structural motion is CSS keyframes + IO.

Primitives the rebuild needs:

1. **Lenis** (`@studio-freight/lenis` or `lenis` package) for smooth scroll. One global instance.
2. **CSS `@keyframes`** for `stagger-fade-in`, `media-entrance`, `nav-item-in`. Apply via class toggle from IO callback.
3. **`IntersectionObserver`** with `rootMargin: "5%"` to (a) trigger entrance and (b) drive the sticky-nav active state.
4. (Optional) **Rive** if you want richly animated figures. Default to MP4/WEBM otherwise.

**Don't** install framer-motion just for this look — it's not what Shopify shipped, and `useInView` + framer adds 40 KB the editions team chose not to spend.

---

## 9. Don't go dark — explicit rule

**The page never inverts to a dark chapter surface.**

The body has ONE state-transition: on initial hydration, body goes from `#000` to `#dcdcd0` over 0.6 s. After that, **every chapter sits on `#dcdcd0`**. Dark surfaces (`#292919`, `#1a1a1a`, `#171716`, `#000`) only appear INSIDE individual figure cards (videos, code-blocks, screenshots of POS/checkout UI).

- The footer is dark (charcoal/black). That is the ONLY dark BLEED section, and it's the page edge — not a mid-page interrupt.
- Our prior rebuild went `cream → cream → cream → BLACK benchmark table → cream` mid-scroll. **That is the failure mode.** Tables, code blocks, and benchmark figures must stay on a contained card (rounded `0.75rem`, max-width inset), and the chapter background stays cream.
- If a figure card needs to be dark for contrast (e.g. a code block), it sits inside a margin-bounded box with a `0.75rem` radius. The cream wraps it on every side.

Rule for the rebuild: **`body { background-color: #dcdcd0 }` and never `bg-black` on a `<section>`.** Only `<figure>` / `<aside>` / `<.card>` elements may carry a dark fill, and they MUST have a non-zero inline margin so cream is visible around them.

---

## REBUILD CHECKLIST — 10 invariants

Open the rebuilt page side-by-side with `https://www.shopify.com/editions/winter2026`. Each invariant is testable.

1. **Cream surface literal**. `body { background-color: #dcdcd0 }`. DevTools → Elements → computed style on `<body>` must show `rgb(220, 220, 208)`. Not `oklch`, not "ish", not `#f7f7ee` (that's the highlight card, not body).
2. **Ink color literal**. Default text color must compute to `#292919` (RGB `41,41,25`) — a dark olive-black, not pure black, not pure grey. Pick any chapter title; computed `color` matches.
3. **Hairline literal**. Inspect the rule between two chapters: `border-top: 1px solid #909083` (taupe-grey). Full-bleed (no horizontal inset). Solid. 1 px.
4. **No dark chapter sections**. Scroll the whole page; the only dark surface that touches the viewport edges is the FOOTER. Every benchmark / code / table figure is a contained card with cream visible to its left and right. (Inspect each `<section>`: computed `background-color` is `rgb(220, 220, 208)` or transparent inheriting.)
5. **Font families correct**. Chapter title computed `font-family` starts with `NeueMontreal`. Lede paragraph computed `font-family` starts with `HWCigars`. If both are the same family, the editorial feel is gone.
6. **Hero clamp literal**. Hero `<h1>` computed `font-size` falls between 120 px (mobile) and 220 px (≥ 1280 px), matching `clamp(7.5rem, 35.7895px + 10.9649vw, 13.75rem)`. Resize the window from 375 → 1920 and verify the value tracks.
7. **Chapter title clamp literal**. Each chapter `<h2>` is `clamp(6rem, 75.7895px + 2.63158vw, 7.5rem)`. Inspect on a 1440 px viewport: ≈ 113 px.
8. **Sticky chapter nav active state**. Scroll slowly; the chapter nav pill for the section currently centered MUST change its color from `#5c5c4e` (muted) to `#292919` (ink) AND should engage by IntersectionObserver with `rootMargin: "5%"` (verify in DevTools → Sources by searching for `"5%"` in the bundle, or just test that the active pill flips before the chapter heading is centered on screen).
9. **Smooth scroll via Lenis**. In console, type `window.lenis` — if it exists and has `.version`, Lenis is wired. Wheel scroll feels inertial (~0.6 s decay), not OS-native instant.
10. **Hero entrance is opacity-only word stagger**. View the hero in slow-motion (Chrome DevTools → Rendering → Animation tab, or `prefers-reduced-motion`). Each word fades 0 → 1 in place, with a 60–80 ms stagger between words. **No `translateY`, no blur**. If you see words sliding up from below, that's framer-motion default — wrong shape.

---

## Surprising findings (record for the rebuilding agent)

- Tailwind oklch tokens exist in `:root` but are NOT used for any surface — they're an unused theme scaffold. Real surfaces are raw hex (`#dcdcd0`, `#292919`, `#f7f7ee`, `#909083`, `#5433eb`).
- The cream isn't pure: `#dcdcd0` has slight green-yellow chroma. Pure greyscale (`#dcdcdc`) looks wrong.
- The ink isn't black: `#292919` has a warm olive bias. Pure `#000` text on `#dcdcd0` looks too cold.
- There is no SplitText / GSAP / framer-motion in the bundle. Word-stagger is plain `<span>` per word with CSS `animation-delay`. Don't over-engineer.
- Rive is loaded but optional — it powers the animated mascots. You can ship the editions LOOK without Rive by using static figures or MP4.
- The brand purple `#5433eb` appears ONLY on a counter pill (`.counter` class). It is not a chapter background, not a CTA fill at large size. Use it as a small accent, never as a section surface.
- The body has a black-to-cream 0.6 s curtain on hydration. If your rebuild renders cream from frame 1 (SSR with cream body), you skip the curtain — that's fine, but if you want the editions identity you can replicate it.
