# Energy Ranking

Resolution is not a lookup. It is an energy-ordered selection over candidate routes, with the freedom to say "I don't know."

When an agent states an intent, unbrowse rarely has exactly one route that fits. It has a set of candidate route-contracts — each a real, executable request behind some site — and it has to decide which, if any, actually answers the intent. That decision is a ranking, and the ranking is framed as energy.

## Resolution as energy-ordered selection

Every candidate route is scored against the intent, and the scores are read as an energy: `energy = -score`. A better match settles to a *lower* energy; the best route is the lowest-energy one. This is the energy-based-model convention, and it buys two things. First, ordering is automatic — sort by energy and the best-matched routes rise to the top, returned as a shortlist rather than a single guess. Second, the gap between candidates becomes meaningful: an attention over the candidates is a softmax over their energies, so the shortlist carries not just an order but a sense of how confident that order is.

Ties are broken deterministically. The same intent against the same graph resolves the same way every time — the ordering is reproducible, not a coin flip on equal scores.

## Two independent witnesses

A single similarity number is easy to fool. A route can *look* right by surface text and be wrong, or be structurally perfect and miss the words. So the score is not one signal — it is a quorum of two.

The energy fuses **two uncorrelated witnesses**: one **lexical** (does the candidate's own text match what was asked?) and one **structural** (does the candidate's shape and coverage fit the intent?). These are independent lines of evidence; they fail in different ways. A selection is trusted only when *both witnesses concur* — when one says "match" and the other agrees. Either witness alone can be confidently wrong; the two together are far harder to fool. This is the two-witness rule: a claim stands on two independent witnesses, never on one.

## Evidence-routed, not fixed-weight

The two witnesses are not blended on a fixed recipe. A constant split — "always weigh lexical and structural equally" — wastes the stronger signal on every query that doesn't fit the constant.

Instead the blend is **evidence-routed**: it leans on whichever witness actually has evidence for *this* query. When the lexical witness carries little real evidence, the structural witness carries the decision; when the words match strongly, the structural witness matters less. The same swing in one signal moves the answer a lot on a query where that signal is load-bearing, and barely at all on a query where it isn't. The blend adapts to the query rather than the query bending to the blend.

## Settlement and honest abstention

A ranked list always has a top entry. That is its weakness: the top of a *bad* list looks identical to the top of a good one. A pure ranker is an orderer — it says "this is the least-bad candidate" — but least-bad is not good enough to act on.

Unbrowse adds a settlement step on top of the ordering. The lowest-energy candidate is *settled* — handed back to act on — only if it clears the two-witness quorum **and** clears a coverage bar: the witnesses must concur, and the match must be real, not merely the best of a non-covering set. If no candidate clears that bar, the engine does not return a least-bad non-match. It **escalates** — falls back to live browsing to discover the route from scratch — and reports that it did.

"I don't know, let me go look" is a valid answer, and an important one. A flat ranked list cannot express it; every list has a number-one row. Energy ranking can, because settlement is a separate, explicit gate from ordering. Abstention is honest: an empty quorum is a real outcome, not a hidden failure dressed as a confident top result.

## A resolve is a ranked truth-claim

Structurally, a resolve is a declared truth-claim — "this route answers this intent" — ranked by energy and admitted only on a two-witness quorum. This mirrors the contract model that runs through the rest of the system: a claim is not trusted because it was asserted, but because independent witnesses corroborate it and it clears the bar to settle. Resolution and the contract substrate share one shape — energy orders the candidates, the quorum decides whether any of them earns belief.

## What this is *not*

This page describes the *shape* of the intelligence, not its internals. The specific signals, their weights, the blend's exact formula, the coverage thresholds, and how routes are discovered in the first place are deliberately out of scope here — they are the maintained route graph and capture engine that make the asset valuable (see [The Route Graph as a Productive Asset](./route-graph-as-asset.md)). What matters publicly is the contract: energy orders candidates, two independent witnesses must agree, the blend follows the evidence, and when nothing earns the quorum the engine abstains and escalates rather than guessing.

## Related

- [Shadow APIs](./shadow-apis.md) — what the candidate routes *are*.
- [The Route Graph as a Productive Asset](./route-graph-as-asset.md) — why the candidate set is kept fresh.
