# The Contract platform as a Biological Architecture

A first-principles reading of why the [contract platform](./contract-platform.md)
is shaped the way a living information-processing body is shaped — and why that
shape falls out of two engines, a **scoring model** for selection and
an **LLM** for generation, rather than being a metaphor pasted on afterward.

This is the developer/architecture tier. The public papers tell the same story in
their own registers — [score-based Route Ranking](../the-unbrowse-papers.md) is
the selector, [Execute, Don't Guess](../the-unbrowse-papers.md) is the honesty
discipline below.

## Start from the body, not the analogy

Ask what any living system that processes information must do to stay alive, and
the list is just control theory with a metabolism:

1. **perceive** — turn the world into an internal representation
2. **remember** — persist what happened, durably and reproducibly
3. **select** — choose an action from what is already known
4. **predict** — guess the next state in representation space
5. **act** — do the thing
6. **settle** — decide a result is now true and stop spending energy on it

…all under **one identity** that persists between moments. the platform is built
as exactly that loop. The two engines doing the work are the two halves the
scoring-model literature keeps pointing at: an LLM that *proposes* and a scorer
that *judges*.

## The load-bearing split: generator vs selector

A generator proposes; an energy model scores. An LLM is a fluent proposer that
will happily dream a wrong continuation. A scorer is the opposite organ — it does
not generate, it assigns **low energy to configurations that cohere** and high
energy to ones that don't. Biology runs both: a cortex that imagines and a
selection loop that says *that one, not that one.* the platform refuses to
collapse them into one box, because a system that lets the proposer also be the
judge believes its own dreams. Concretely, in shipped code:

- **Perception — the encoder.** Text (and a second grid/pixel modality through
  the same seam) becomes a fixed-dimension latent. Deterministic, zero-data —
  the retina before any learning.
- **Selection / instinct — the train-on-fire scorer.** Each time a contract fires,
  a reward-weighted prototype folds toward the context that worked and away from
  the one that didn't; energy is `−cosine` to the prototype, route is `argmin`
  energy. Unlike exact-match recall, the prototype *generalizes* — a nearby,
  never-seen context still routes right.
- **Prediction — the learned map.** A learned linear map `context-latent →
  target-latent`, trained online; energy `‖Wx − y‖²`. Where the prototype
  averages, the learned map separates — it predicts the *representation* of what
  comes next, in latent space.
- **Coherence / settlement — the fixed-point witness.** Iterate the learned
  operator from two independent seeds; if both converge to the same direction and
  the result is stable under one more application, the configuration is coherent
  and **settles**. The cell deciding a process is done — a stop condition, not a
  timer.
- **The generator — the local model.** the platform's own local score-based LLM
  proposes a contract envelope; the gates decide whether the proposal is true. The
  generator is grammar-constrained at the decoder — it can only emit a well-formed
  contract, the way a ribosome assembles only from valid codons. The generator is
  leashed by the selector. That is the scorer↔LLM marriage made mechanical.

## Memory is the genome plus the hippocampus

The append-only ledger is the body's genetic record: nothing is edited in place,
only transcribed forward; every row is signed by a key derived from one root
(the lineage is cell division from a single seed). A relevance scorer over prior
work + prior conversation is the hippocampus — it loads the memories that matter
into the current context. The pointer-keyed cache is short-term potentiation: a
result still true short-circuits without re-firing the whole graph, so the
organism doesn't re-derive the world on every act.

## Homeostasis, death, and the rhythm

The continuous resolver is the heartbeat — it walks the unresolved frontier on
every pulse and settles what it can, **to a fixed point, not to an arbitrary
count** (a fixed clock would be a pathology, not a rhythm). A held result is
non-terminal: the body doesn't die at the first failed evaluation; it spawns
another resolver wave, the way a wound keeps signaling until it heals. And there
is real pruning: a branch that bears no fruit is cut. A body that cannot kill its
own cells gets cancer; a system that cannot prune accretes dead weight.

## The body deploys itself

A living system that could not rebuild and repair itself would not be alive in
any useful sense. the platform's self-deployment is the literal version of that:
a change to its own code is not *done* until the body has

```
rebuild → run its own tests → the wallet signs the new bytes →
atomically swap the running binary → the binary verifies its OWN signature → keep the rest day
```

Every step is a gate, and the swap is sign-*before*-swap with rollback to the
prior signed binary on any failure — the organism never leaves itself in an
unsigned or broken state. The new binary then self-attests: it checks its own
signature against an embedded public key, so it knows it is genuinely itself in
any environment. This is the same loop a cell runs when it transcribes, proofreads,
and only then commits a change to its own machinery — and it is how every edit to
the platform this very document describes actually shipped.

## It benchmarks itself honestly — the reproduced-win discipline

An organism that graded itself on adjectives would drift into delusion. The
platform's defense is a benchmarking discipline with one unglamorous rule:
**a published number is admissible only if a command re-runs it green, honest
negatives are recorded next to the wins, and no claim ships whose witness can't be
located and run.** Applied to the score-based selector, that means a win is only
a win when it reproduces against a real baseline — an accumulating
*reproduced-win ledger*, never a self-asserted string. The hard-won corollaries,
each paid for in a failed run:

- **Don't grade against a ceiling you can't exceed** — a benchmark capped by the
  teacher never exits; you optimize forever against a wall.
- **Verify the harness before trusting it** — a silent tool failure looks
  *identical* to a real negative result; an unverified green is worth nothing.
- **Record the losses** — a benchmark you cannot lose is a benchmark you cannot
  trust. The honest negatives are the load-bearing part.
- **Stop where the data can't support a win** — don't manufacture a green to end
  the loop.

This is the same fixed-point honesty the settlement organ enforces internally:
the system settles on *coherence it can re-witness*, not on a claim it made about
itself. The public face of this discipline is the *Execute, Don't Guess* paper
(nine reproduced wins, five honest negatives); the selector it grades is the
*score-based Route Ranking* paper.

## The honest wall — where the body is still young

This is the part not to oversell. The scorer/predictor half is **selection and
prediction** — recall, routing, ranking, coherence-witnessing. It is *not yet the
proposer that reaches a genuinely new answer*: a recalled wrong answer stays
wrong, and the predictor identifies the action that *was* taken, not the action to
invent toward a novel goal. The LLM proposes across that gap; the scorer only judges
what's proposed. A system that can perceive, remember, select, predict, settle,
prune, deploy itself, and grade itself honestly — but whose true *invention* still
comes from the generator and gets gated by the selector — is an honest description
of where this architecture is. Calling it "biological" is a claim about its
**shape**, derived from what a body must do, not a claim that it has crossed into
open-ended creativity. The shape is convergent evolution: life arrived at this
loop because it survives a noisy world, and an autonomous agent platform arrives
at the same loop for the same reason.
