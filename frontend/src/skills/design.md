---
name: design
description: >-
  The jesus-pattern (CLAUDE.md's universal structure) translated into product/UI
  DESIGN from first principles — and made usable. Where TASTE.md states the theory,
  DESIGN.md is the working method: study real inspiration first (capture a reference
  UI, name its pattern, extract the primitive, adapt to brand), then walk the ten
  atoms to build the thing. Each atom maps to a cited design primitive — Rams' "less
  but better", the user story, Atomic Design, Norman's gulfs/affordances, 5-user
  discount testing, Nielsen's heuristics, design tokens, WCAG, the Double Diamond,
  and Lean-UX continuous discovery. The worked example throughout is the Aiko chat
  homepage. This file IS a valid SKILL.md — walk the tree, settle each node by
  Plan → Build → Test → Judge.
---

# DESIGN.md — the covenant tree, translated into first-principles product design

> One instance of the jesus-pattern (`references/JESUS-PATTERN.md`). To design a
> product surface — a screen, a flow, a component — do NOT start in code. Start by
> **studying inspiration**, then walk the tree below. Taste is the trained faculty
> that recognizes quality on sight (Paul Graham, "Taste for Makers",
> https://paulgraham.com/taste.html); this file is the scaffold you walk *until*
> that faculty is trusted, valid only where feedback is fast and real
> (Kahneman–Klein: https://en.wikipedia.org/wiki/Recognition-primed_decision).

## Step 0 — Study inspiration before you design (/agent-browser)

First principle: **never design from a blank page; design from the best existing
answer, then improve it.** Before touching a layout, capture a reference UI and
map its decisions:

1. **Capture** the reference live (`/agent-browser` snap/screenshot, or read the
   real DOM). e.g. Google's Gemini "AI Mode" — https://gemini.google.com — the
   studied reference for the Aiko home: a centered greeting ("Hi, {name}. What's on
   your mind?"), one rounded prompt with an inline mode pill + suggestion chips,
   and on answer a two-pane split (conversational answer left, sources rail right).
2. **Name the pattern** (what job each element does), don't copy pixels. The chips
   are *recognition-not-recall* starters; the mode pill is a *signifier* of which
   engine answers; the sources rail is *system status / provenance*.
3. **Extract the primitive** and **adapt to brand**: keep the job, change the skin
   (Linear's reductionism https://linear.app, Stripe's clarity https://stripe.com,
   Vercel's Geist tokens https://vercel.com/geist/introduction). The Aiko home keeps
   Gemini's layout job and reskins to unbrowse orange-on-near-black + Google Sans.

src:unbrowse/frontend/src/components/aiko-home.tsx — the worked output of this step.

## The atom map

| atom | abstract (covenant) | design parallel (first principle) | source_id |
|---|---|---|---|
| **root** | the telos every node points at | "less, but better" — every element earns its place by serving the user's goal | https://www.vitsoe.com/us/about/good-design |
| **node** | the indivisible unit (who/what/why) | the **user story**: "As a [who], I want [what], so that [why]" | https://en.wikipedia.org/wiki/User_story |
| **tree** | self-similar generative composition | **Atomic Design**: tokens → atoms → molecules → organisms → pages | https://atomicdesign.bradfrost.com/chapter-2/ |
| **verb** | build / breath / eval | **Norman**: act (execution) / navigate (route) / perceive (evaluation); affordance → signifier → feedback | https://en.wikipedia.org/wiki/The_Design_of_Everyday_Things |
| **settle** | done by witness/clock/convergence | settle when testing **converges** — 5 users surface ~85% of defects | https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/ |
| **witness** | two independent corroborations | **heuristic evaluation** (expert) + **user test** (real), both must agree | https://www.nngroup.com/articles/ten-usability-heuristics/ |
| **cache** | memoize (exact) + recall-by-likeness (fuzzy) | **design tokens / systems** (exact reuse) + **taste** (it feels right) | https://m3.material.io/foundations/design-tokens/overview |
| **seal** | nothing ships carrying a violation | the **accessibility gate**: no surface ships failing WCAG / a heuristic | https://www.w3.org/WAI/WCAG22/quickref/ |
| **walk** | enumerate the unresolved set | the **Double Diamond**: Discover → Define → Develop → Deliver | https://www.designcouncil.org.uk/our-resources/the-double-diamond/ |
| **loop** | plan → build → test → judge, repeat | **Lean-UX / RITE** continuous discovery: build → measure → learn → repent | https://en.wikipedia.org/wiki/Lean_UX |

### root (why)
- **covenant:** the trust-anchor every node descends from and points at; never re-proved, only pointed to.
- **design parallel:** **Dieter Rams' "Weniger, aber besser" (less, but better).** The first principle of every design decision: an element exists only if it serves the user's goal; the default is to remove. You do not re-derive "is good design useful/understandable/honest/unobtrusive" each time — you point at it and judge against it. The Aiko home descends from this: one job (ask Aiko), one primary action (the prompt), all marketing chrome removed to `/classic`.
- **why (source_id):** https://www.vitsoe.com/us/about/good-design

### node (what)
- **covenant:** the indivisible unit carrying who/what/why + its witness + its verb.
- **design parallel:** the **user story** — "As a [role], I want [goal], so that [benefit]." The atom of design work; nothing gets built that isn't traceable to one. The Aiko home was built from seven explicit stories (first-timer grasp, mobile sources, returning-user memory, error recovery, screen-reader announce, keyboard-first, sign-in) — each one a node, each one verified.
- **why (source_id):** https://en.wikipedia.org/wiki/User_story

### tree (where)
- **covenant:** nodes compose into a self-similar tree; the same shape all the way down.
- **design parallel:** **Atomic Design** (Brad Frost): irreducible **design tokens** and **atoms** (a color var, a label, an input) compose into **molecules** (the prompt = input + send + mode pill), **organisms** (the composer + sources rail), **templates**, then **pages**. The same "small things compose into bigger things" repeats at every altitude — the generative tree. Tokens are the leaves: `--surface`, `--text-primary`, `--orange-500`.
- **where (source_id):** https://atomicdesign.bradfrost.com/chapter-2/

### verb (how)
- **covenant:** every operation is build (effect) / breath (route) / eval (query).
- **design parallel:** **Norman's gulfs + affordances/signifiers.** Every interface action is one of three verbs: **build** = act across the Gulf of Execution (submit the prompt); **eval** = perceive across the Gulf of Evaluation (read the answer + latency + sources); **breath** = navigate/route between states (open `/classic`, sign in). An **affordance** is what an element lets you do; a **signifier** advertises it (the send arrow, the "✦ Aiko mode" pill, the blinking cursor = feedback). Honest caveat: Norman names two gulfs; "breath/route" is a faithful third verb, not a Norman stage.
- **how (source_id):** https://en.wikipedia.org/wiki/The_Design_of_Everyday_Things

### settle (when)
- **covenant:** a node settles when witnesses sign, the clock arrives, or it converges by gradient — never faked green.
- **design parallel:** a design **settles when usability testing converges**, not when it "looks finished." Nielsen's discount finding — **five users surface ~85% of usability problems** — is the operational convergence test: when a fresh handful of users stop hitting new defects on a flow, that flow is settled. Premature "ship it, it looks done" is the design version of fabricated green.
- **when (source_id):** https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/

### witness (who)
- **covenant:** two independent witnesses minimum corroborate the claim.
- **design parallel:** **two independent evaluations must agree** before a design is trusted: an **expert heuristic evaluation** against Nielsen's 10 heuristics (visibility of system status, match to the real world, user control, error recovery, recognition over recall, aesthetic minimalism…) AND a **real user test**. Expert-only is theory; user-only is anecdote; the two corroborating is the witness. For the Aiko home: heuristic pass (status = latency readout; recovery = Retry; recognition = chips) + a live preview for real use.
- **who (source_id):** https://www.nngroup.com/articles/ten-usability-heuristics/

### cache (where-again)
- **covenant:** MEMOIZE under a structural key (exact) AND recall-by-likeness (fuzzy).
- **design parallel:** EXACT — **design tokens and the design system**: a solved decision (spacing, color, the button) is stored once and reused by name, never re-decided. FUZZY — **taste / recognition-primed recall**: a trained designer recognizes "this spacing is right" without re-measuring. Both lobes: the token system prevents drift; taste fills the gaps the system hasn't named yet. The Aiko home reuses `globals.css` tokens (exact) and the Gemini-studied layout (fuzzy recognition of a known-good shape).
- **where-again (source_id):** https://m3.material.io/foundations/design-tokens/overview

### seal (gate)
- **covenant:** no build ships carrying a violation; it self-verifies through the root before shipping.
- **design parallel:** the **accessibility + heuristic ship gate** — nothing ships failing **WCAG 2.2** (contrast, keyboard operability, focus order, names/roles) or carrying a known heuristic violation. This is mechanical, not vibes: the Aiko home is gated by `frontend/scripts/aiko-home-gate.sh` (aria-live announces answers, keyboard-first, error recovery, mobile reachability) which must exit 0 before the surface is considered shippable.
- **gate (source_id):** https://www.w3.org/WAI/WCAG22/quickref/

### walk (path)
- **covenant:** enumerate the unresolved nodes from root or leaf; surface the unresolved set.
- **design parallel:** the **Double Diamond** — Discover → Define → Develop → Deliver: diverge then converge on the *problem* (what should this screen even do?), then diverge then converge on the *solution* (which layout?). It is the enumerate-and-resolve walk applied to design: surface every option, then settle on one, twice. The Aiko home walked it: define ("a chat that runs real unbrowse search, fast") → develop (Gemini vs Perplexity vs ChatGPT layout) → converge (Gemini AI-Mode) → deliver (the preview).
- **path (source_id):** https://www.designcouncil.org.uk/our-resources/the-double-diamond/

### loop (when-again)
- **covenant:** every node settled by plan → build → test → judge; on failure, repent and return to plan.
- **design parallel:** **Lean-UX / RITE continuous discovery** — build the smallest real thing, measure it with real users, learn, and fix *immediately* (the Rapid Iterative Testing & Evaluation method fixes defects between sessions rather than batching them). Ship → observe → repent → ship again; the design is never "done," only currently-best. The Aiko home is the first turn of this loop: ship the preview, watch real search latency (3.85s observed), then return to plan to make it faster.
- **when-again (source_id):** https://en.wikipedia.org/wiki/Lean_UX

## How to use it (the walk, in order)

1. **Step 0 — study** a reference UI live (`/agent-browser`), name its patterns, extract primitives (above).
2. **root** — state the one telos of this surface; delete everything that doesn't serve it.
3. **node** — write the user stories (who/what/why). No story, no element.
4. **tree** — compose from tokens up; set the visual hierarchy.
5. **verb** — for each interaction, design the affordance → signifier → feedback triad.
6. **walk** — Double-Diamond the problem then the solution; keep the winner.
7. **witness** — heuristic-eval + put it in front of real users.
8. **settle** — stop when testing converges, not when it looks done.
9. **cache** — promote reusable decisions into tokens/components.
10. **seal** — run the accessibility/heuristic gate; a violation blocks the ship.
11. **loop** — ship, observe real behaviour, repent, return to plan.

Worked example end-to-end: the Aiko chat homepage —
src:unbrowse/frontend/src/components/aiko-home.tsx, gated by
src:unbrowse/frontend/scripts/aiko-home-gate.sh.
