# The Ten Commandments of this codebase

The superpattern Decalogue (`sp-commandments`: deontic obligation/prohibition,
Design-by-Contract invariants, content-addressed memo, N-version witness, the
no-violation-ships seal) translated into ten enforceable code laws. The runnable
witness is `scripts/commandments-gate.sh` (exit 0 = the codebase obeys them).

| # | commandment | law primitive | enforced by |
|---|---|---|---|
| 1 | **One root.** Every shared truth (a constant, a format, a primitive) is defined once; no module re-proves the axiom. | the first word — the lawgiver's identity is the axiom all rest on | one-definition check (e.g. `GENESIS` defined once) |
| 2 | **One node, one duty.** Each function/module is a single settle-able unit; no clause both compels and permits. | deontic node = one obligation/permission/prohibition | code review + cohesive exports |
| 3 | **No graven images.** No stubs, dummy data, or fake success — the real thing or honest failure. | no false image before the real | no-stub grep (TODO/FIXME/"not implemented"/stub-throw) |
| 4 | **No false witness.** Tests assert real behaviour, never a status string; no fabricated green. | the 9th word; N-version corroboration | tests run real code; agent-judged, not heuristic |
| 5 | **Honor the contract.** Preconditions, postconditions, invariants; fail closed, never silently. | Design-by-Contract invariant; the seal | guards in code (e.g. errors propagate, never cached) |
| 6 | **Thou shalt not steal.** No copy-paste duplication; reuse the one primitive. | DRY / the 8th word | duplication check (one definition per core primitive) |
| 7 | **Remember the cache.** Memoize content-addressed + verify by re-deriving; deterministic, no drift. | the law written on the heart — content-addressed memo | resolution-ledger / content-address primitives |
| 8 | **Thou shalt not covet (no leak).** No secret or internal crosses the public boundary. | the 10th word; access-control policy | `leak-guard.sh` + `public-scrub-gate.sh` |
| 9 | **Two witnesses.** Every claim is settled by a runnable test; one assertion is not proof. | Deut 19:15 quorum; N-version | `zk-gate.sh` node coverage (every primitive tested) |
| 10 | **The seal ships clean.** No build ships carrying a violation; the gate is green. | not one jot passes the law (Matt 5:18); the seal | `zk-gate.sh` + `paper-gate.sh` exit 0 |

Witness: `bash scripts/commandments-gate.sh` — exit 0 iff all ten hold.
