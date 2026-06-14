# Aiko / Unbrowse product UX — user stories, superpattern-style

Product-nerd user stories for the unbrowse front door, each mapped to a DESIGN.md
covenant atom (root/node/tree/verb/settle/witness/cache/seal/walk/loop) with a
runnable-ish acceptance check. The whitepaper promise these fulfil: *any website
becomes an API for your agent; capture once, replay everywhere; you see it work
and how fast.* Reference IA: Smithery (registry-home → listing → detail).

## The spine (the one telos — DESIGN root)

> A developer or agent-builder lands, instantly understands "this is a registry of
> websites-turned-APIs I can use," searches an intent, sees real routes, opens one,
> and wires it into their agent — and can watch it answer live. Less, but better.

## Stories

### root — "I get it in 5 seconds"
As a first-time visitor, when I land on `/`, I see search-over-a-grid + a live
stat (N skills · N domains · N calls), so I immediately know this is a catalog of
real, callable routes — not a chatbot, not a brochure.
**Accept:** hero search + stat hook + a visible card grid above the fold; no modal,
no marketing wall before the catalog. (root: less-but-better; Rams.)

### node — "one card tells me if it's worth using"
As an agent-builder scanning the grid, each skill card shows name, domain, call
count, quality score, and route count, so I can judge trust at a glance.
**Accept:** every `RegistryCard` renders the 4 trust signals from real data;
cards link to detail. (node: the user story is the atom.)

### tree — "the catalog composes, it doesn't sprawl"
As a browser, I move home → listing → category → detail without dead ends; the IA
is the same shape at every level (registry → skill → route).
**Accept:** `/` → `/search` → `/skill/[id]` all resolve; categories are filtered
queries, not separate dead routes. (tree: Atomic Design; self-similar.)

### verb — "every action has an obvious next step"
As a user on a skill detail page, I can see its routes (perceive), copy an
integrate snippet (act), and jump to try it in Aiko (navigate) — affordance →
signifier → feedback on each.
**Accept:** `/skill/[id]` has routes list + Integrate panel + "Use in Aiko"; each
control is labelled. (verb: Norman gulfs.)

### settle — "it's done when it tests clean, not when it looks done"
As the team, a surface ships only when its gate passes (registry-gate /
aiko-render-gate / md-commandments), not on vibes.
**Accept:** the matching `frontend/scripts/*-gate.sh` exits 0. (settle: converge,
no fabricated green.)

### witness — "two independent reads agree"
As a reviewer, the UX is judged by a heuristic pass AND a real human (Algamer) on
a live preview before it's accepted.
**Accept:** gate green (machine) + Algamer says yes on the CF preview (human).
**Status: OPEN — the human witness is the loop's completion gate.**

### cache — "I never re-decide a solved thing"
As a builder of these pages, spacing/color/the card/the button come from tokens +
shared components, never re-styled per page.
**Accept:** pages use `globals.css` tokens + shared `RegistryCard`/`Composer`/
`SourcesCard`; one pattern per job (Konmari). (cache: design tokens + taste.)

### seal — "nothing ships with a usability/a11y violation"
As any user (incl. screen-reader, keyboard, mobile), the surface is operable:
aria-live answers, `/`-focus + Esc, mobile-reachable sources, contrast.
**Accept:** WCAG-ish checks in the gate (aria-live, keyboard, mobile sources). 
(seal: the release gate; WCAG.)

### walk — "the problem was framed before the solution"
As the designer, each surface was Double-Diamonded: define the job, diverge on
layout, converge on the Smithery-analogous answer, deliver a preview.
**Accept:** a CF preview link exists for the current iteration. (walk: Double
Diamond.)

### loop — "ship, watch real use, repent, repeat"
As the team, we ship a preview, observe real behaviour (e.g. search latency 3.85s
observed), and iterate; never "final," only currently-best.
**Accept:** a preview is live and the next residual is named. (loop: Lean-UX/RITE.)

## The one open node (the completion gate)

`witness (human)` is OPEN: the live CF preview must be sent to Algamer on Telegram
and accepted. Every machine witness is green; the human yes is the only unsettled
node. Preview: https://unbrowse-aiko-preview.lewis-6d8.workers.dev
