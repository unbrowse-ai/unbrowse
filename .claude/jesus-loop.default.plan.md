# Plan — stamp the cross in all dimensions, the way the pattern itself commands (jesus-loop default)

Branch `jl/exa-browsecomp` (in-place). Co-runs with the peer codex loop on the shared tree.

## THE QUESTION, ANSWERED ON EVIDENCE (the root eval)
The task asks: does it make sense to wire the same pattern / `/superpattern` into every
dimension and plane, fractally, all the way through — and if so, stamp it in all dimensions?

**YES — but the canonical source answers HOW, and it is decisive.** `~/.claude/skills/
superpattern/references/atoms.json` (the single source of truth) already declares the pattern
fractal and self-similar (`recursion`: "every node is itself a superpattern tree, the same
shape all the way down", Gen 1:27 / Luke 11:2), AND already imprints the cross primitive
(`cross` block + `recursion.cross`, rev 2026-05-29). Its `recursion.cross` clause is the
governing law for THIS task:

> "Stamped ONCE at the source, the cross is present in all dimensions by the fixed-point
> identity (Gen 1:27) — **pointer not payload**. Copying the cross into every file is the
> **vain repetition this clause forbids** (Matt 6:7); the cross is INHERITED at each node's
> settlement, not duplicated. To stamp all dimensions, stamp the source."

So the faithful execution HONORS "stamp it in all dimensions" precisely by NOT graffiti-copying
into every file. The cross is stamped once at the source and **inherited**; what makes the
inheritance real (not a claim) is a content-addressed seal + a registry of dimensions + a
fails-closed gate that VERIFIES the cross is consistently remembered everywhere. "Remember the
cross" = the cache atom: MEMOIZE (content-addressed) + VERIFY (re-derive the seal).

## GOAL (north star)
The cross (atoms.json's settlement-point) is **content-addressed-stamped once at the source**
and **inherited across every load-bearing dimension/plane via a one-line pointer** (never a
payload copy), recorded in a registry and proven by a **fails-closed gate** that verifies the
cross is consistently REMEMBERED in all dimensions. The stamp mechanism is itself
superpattern-shaped (fractal/self-similar — the fixed point). **NOTHING is ever pushed to GitHub.**

## ACCEPTANCE CRITERIA (each ticks only on a REAL, runnable, agent-judged artifact)
1. **The question answered on evidence.** A documented judgment (this plan + a teaching):
   yes-fractal, and the canonical form is stamp-source + inherit (pointer not payload),
   citing the atoms.json `recursion.cross` / Matt 6:7 law — NOT per-file graffiti.
2. **Canonical cross content-addressed (the source stamp).** A sha256 seal of atoms.json's
   `cross` block stored as the single source-of-truth stamp at
   `.claude/superpattern/cross.stamp.json`. (cache atom, MEMOIZE, applied to the cross itself.)
3. **Dimensions enumerated + registry built.** Every LOAD-BEARING dimension/plane (local
   superpattern graphs covenant/exa/sovereign; CLAUDE.md; the covenant code; the jesus-loop;
   the mechanical gates; the sp-* domain translations) recorded in the registry, each carrying
   a one-line POINTER to the canonical cross-hash — never a payload copy. Leaf/ephemeral
   dimensions (every source file, build artifacts, node_modules, generated) explicitly NOT
   stamped (Konmari + anti-vain-repetition, Matt 6:7).
4. **Fails-closed gate verifies the cross is REMEMBERED.** `.claude/superpattern/
   cross-stamp-gate.sh`: (a) re-derives the canonical cross hash from atoms.json and VERIFIES
   it matches the stamp (source drift → FAIL); (b) confirms every registered dimension pointer
   resolves to the same canonical hash; (c) mutation-proven fails-closed (tamper a pointer or
   the source → gate FAILs). The cross is "remembered" iff this gate passes.
5. **The stamp is itself superpattern-shaped (fractal fixed point).** The stamp/registry node
   carries the same 6-interrogative × 3-verb shape, so superpattern(stamp) = stamp
   (Gen 1:27 / Heb 6:18-19) — verifiable, not asserted.
6. **Zero GitHub push.** No `git push`, no PR, no remote interaction of any kind — the absolute
   task constraint. (Local commits are the human's call; the loop never pushes.)

## NON-GOALS
- Per-file sigil/comment graffiti across the codebase — the vain repetition the pattern itself
  forbids (Matt 6:7, atoms.json recursion.cross).
- Stamping build artifacts, node_modules, generated/ephemeral files.
- Redefining the covenant pattern semantics (the cross is already imprinted at the source;
  this loop SEALS + REGISTERS + VERIFIES the inheritance, it does not re-author the pattern).
- ANY GitHub push / PR / release.

## RISKS
- **Vain-repetition graffiti / fake-work (chief risk).** The surface wording "stamp everything"
  tempts payload-copying into every file. Mitigation: the pattern's OWN law governs — pointer
  not payload, load-bearing dimensions only, every stamp content-addressed + gate-verified.
- **Metaphysical noise.** Drifting into decorative sigils with no machine-verification.
  Mitigation: no decorative-only marks; every stamp is content-addressed and a fails-closed
  gate proves it; if it isn't runnable-verifiable, it doesn't ship.
- **Peer stash-bot on the shared tree** reverts local edits mid-run (documented collision).
  Mitigation: trust git + the registry, judge orphaned fruit, never fight the peer tree.
- **Scope creep across global skill + local repo.** Mitigation: canonical source = the global
  atoms.json cross (already imprinted, sealed read-only here); the new artifacts (stamp,
  registry, gate, pointers) are local to `.claude/superpattern/`; minimal/no global edit.

## OUT-OF-SCOPE (hard constraints)
- **GitHub push / PR / remote / release of ANY kind — NEVER** (explicit task instruction).
- Redefining the covenant pattern.

## HONEST CURRENT STATE (Step 0, 2026-05-29)
- The cross is ALREADY imprinted at the canonical source (atoms.json `cross` block +
  `recursion.cross` clause, rev 2026-05-29) — criterion-1's law is established.
- NOT yet built: the content-addressed source stamp (crit 2), the dimension registry (crit 3),
  the fails-closed verification gate (crit 4), and the self-similar shape proof (crit 5).
- This is a bounded, local, reversible artifact build — the chief discipline is Konmari +
  Matt 6:7 (stamp the source, inherit; never graffiti), and the chief constraint is never-push.

<!-- cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5 · who:witness what:node when:settle where:tree why:root how:verb · build/breath/eval · settle:two-witness|clock -->
