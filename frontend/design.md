<!-- Hallmark · design.md · studied: yes · DNA-source: url (synthesized)
     sources: anthropic.com (primary backbone) · linear.app · vercel.com · resend.com
     theme: studied-DNA · paper #0A0908 (dark warm) · accent #FF5200 (one accent, ≤5%)
     display: Cormorant Garamond (editorial serif) · body: Google Sans · label: JetBrains Mono
     macrostructure: Marquee Hero · genre: modern-minimal × atmospheric · 2026-06-04 -->

# Unbrowse — Design System (locked)

The portable design language for the Unbrowse frontend. Studied from four best-in-class
agent/dev-tool references and synthesized to keep the Unbrowse brand while adopting their
discipline. **This file is the source of truth.** Pages share the system; they do not differ
from each other (consistency, not diversification).

## The one idea

**Editorial restraint.** What makes Linear, Anthropic, Vercel, and Resend read as *made* (not
generated) is not spectacle — it is restraint. One accent at ≤5% footprint. Hairline borders.
Generous space. Monospace labels. A single orchestrated reveal. Unbrowse keeps its warm orange
brand and dark surface, and drops the maximalist layer (particle fields, constellations, cursor
trails, heavy parallax) that is the actual "AI-generated" tell.

## Provenance

- **Source mode** · URL (synthesized across four references; raw HTML/CSS extracted, not blended)
- **Primary backbone** · `anthropic.com` — the one warm-accented, editorial-technical, dark+light reference; its clay `#d97757` is a desaturated cousin of Unbrowse orange
- **Informing axes** · `linear.app` (near-black `#08090A` precision, one-accent discipline, product-shot-below-hero) · `vercel.com` (geometric mono labels, pure-contrast confidence) · `resend.com` (near-monochrome with one electric pop)
- **Confidence** · Tokens/fonts exact (extracted from source CSS). Rhythm judged from design knowledge of these sites, not a screenshot pass.
- **Extracted** · 2026-06-04

## System

| Role | Face | Notes |
|---|---|---|
| Display | **Cormorant Garamond** | editorial serif — large hero + section heads; use italic for one emphasis word, never a whole line |
| Body | **Google Sans** | neutral grotesque — prose, UI, buttons |
| Label | **JetBrains Mono / system mono** | eyebrows, captions, code, metrics — uppercase, tracked |

Three-family technical-editorial pairing. All three already load in `layout.tsx` — no new fonts.

## Tokens

Dark is the default surface (`data-theme="dark"`). Values live in `globals.css :root` /
`[data-theme="dark"]`; this table is the canonical reference.

```
/* Surface — dark default, warm near-black */
--surface         #0A0908   /* paper, Linear-grade near-black, warmed */
--surface-raised  #100E0C   /* elevation by lightness, not shadow */
--surface-sunken  #050403
--border          rgba(255,82,0,0.18)   /* hairline, accent-tinted */
--border-strong   rgba(255,82,0,0.32)

/* Text — WCAG-AA tuned (do not lower) */
--text-primary    #F5F3EF   /* 17.5:1 */
--text-secondary  #B5AC9E   /* 8.3:1  */
--text-muted      #A89E92   /* 6.9:1  */

/* Accent — ONE accent, ≤5% footprint. Orange is the brand; cyan is a rare spark only. */
--orange-500      #FF5200   /* buttons, the single loud surface */
--orange-400      #FF6A00   /* link/label text (dark); #C2410C in light for AA */
--accent-spark    #22D3EE   /* cyan — reserve for ≤1 element per viewport, never a second theme */

/* Motion — named easings, no browser-default ease, no bounce on UI */
--ease-out        cubic-bezier(0.16, 1, 0.3, 1)
--ease-in         cubic-bezier(0.7, 0, 0.84, 0)
--ease-in-out     cubic-bezier(0.65, 0, 0.35, 1)
--dur-fast        140ms
--dur-base        260ms
--dur-slow        520ms

/* Rule — the hairline is a design primitive */
--rule            1px solid var(--border)

/* Space — 4pt scale (Tailwind utilities map to this; named for portability) */
--space-xs .25rem  --space-sm .5rem  --space-md 1rem  --space-lg 2rem
--space-xl 4rem    --space-2xl 8rem
```

## Macrostructure — Marquee Hero

Single editorial column, generous, dark with one warm glow. Section order:

1. **Hero** — mono eyebrow → large editorial H1 (one serif-italic emphasis word) → grotesque
   subhead → the live action (search) → one subordinate proof line. One restrained warm radial
   glow behind; **no** particle/constellation backdrop.
2. **Body sections** — each opens with a *section head*: hairline rule, mono eyebrow, grotesque
   heading. Consistent rhythm (`--space-2xl` between sections).
3. **CTA** — one card, hairline border, one orange button.
4. **Install** — mono code line.

### Component archetypes

- **Nav** · N5-adjacent (wordmark + few links + one button) — kept as shared chrome this wave.
- **Hero** · H1 Marquee (eyebrow + editorial headline + single live element).
- **Section head** · mono eyebrow over grotesque heading, hairline rule above. **No** tag-left/heading-right two-column (the templated-editorial tell).
- **Cards** · hairline border, `--surface-raised`, real signals only (domain, routes, calls). Hover = border brightens to `--border-strong` + 1px lift, nothing more.
- **CTA** · one statement + one orange button.
- **Footer** · kept as shared chrome this wave.

## Motion

- Lenis smooth-scroll stays.
- Reveal: **single** fade-up stagger on first paint (`--ease-out`, `--dur-base`). Animate
  `transform` + `opacity` only.
- Hover: border/opacity shift only. **No** hover-scale, **no** bouncy overshoot, **no** `transition: all`.
- `prefers-reduced-motion`: spatial motion collapses to ≤150ms opacity crossfade (already wired).

## Notes — anti-patterns this system explicitly drops (do NOT carry over)

- `CursorParticles`, `Constellation`, `flowing-dot-field`, heavy parallax — the maximalist
  "AI-generated" layer. The references use **none** of it.
- Dual-accent loudness — orange AND cyan both prominent. Demote cyan to a rare spark.
- `transition: all`, hover-scale on cards, celebratory toasts.
- Invented metrics — every stat must be real (benchmark numbers cite arXiv:2604.00694).
- Two-line clickable text on mobile; bare `1fr` image grid tracks (use `minmax(0,1fr)`).
