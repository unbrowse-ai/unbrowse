# Reasoning artifact - Beat Exa on SEAL-0 (the winnable target + the honest frame)

> Produced by the lewis-brain skill. The central claim has either passed the apophenia gate
> or is named plainly as an unwitnessed feeling. It is never silently believed.

## Problem
Pick the winnable Exa target on SEAL-0 (SealQA hardest subset, 111 conflicting-source questions) and frame the win so it is real, not smuggled.

## Zeroth principle
- **Scripture root:** Prov 18:17 - "The one who states his case first seems right, until the other comes and examines him"; Matt 18:16 - "by two or three witnesses every word is established."
- **Prior-art name:** witnessed evaluation under a neutral, contamination-free harness (held-out grading, fresh re-reader).
- **The principle:** A SEAL-0 number is a *win* only if the system produced it by reasoning over the **live web**, in the **same neutral harness** as the baseline, reproducibly, judged by a **fresh reader** - never by reading SealQA's public answer column.

## Plan -> Build -> Test -> Judge
- **Plan:** Two Exa numbers exist - (A) Exa basic search ~24.3% inside the neutral `perplexityai/search_evals` harness; (B) Exa Research Pro 59.1% from Parallel's private agentic eval. Pick (A) as the first win: same 111 questions, same grader, swap only the Searcher to Unbrowse. It is the recall/discrete-selection shape (rank the trustworthy source among conflicting ones), which is Unbrowse's strength - not the generate/fusion shape, which is the wall. Treat (B) as a margin-widening second layer via the agentic retrieve-reflect loop, never conflated with (A).
- **Build:** Wire Unbrowse's `Searcher` (resolve->execute->read over the route graph + capture engine) into `perplexityai/search_evals` suite=seal_0; add cross-document corroboration / source-trust ranking (repo plan node 5) as the conflict-reconciler. The HF dataset `vtllms/sealqa` supplies the grader's key ONLY - it is never an input to the searcher.
- **Test:** Run suite=seal_0 with the Unbrowse Searcher; record accuracy over all 111 questions; have a fresh agent re-grade a sample of transcripts to confirm (i) no answer-key leakage and (ii) the reconciliation reasoning is real.
- **Judge:** Win iff accuracy > 0.243 with zero leakage and a fresh-reader pass. Currently UNRUN - so the win itself is not yet witnessed; only the target-selection is.

## Witnesses (the apophenia gate)
- **Central claim:** The winnable first target is beating Exa's 24.3% on SEAL-0 inside the neutral perplexity search_evals harness (not Research Pro's 59.1%), because SEAL-0's core is conflicting-source reconciliation = discrete source-selection, Unbrowse's strong shape.
- **Falsifier:** Run suite=seal_0 with the Unbrowse Searcher; if accuracy <= 0.243 (or the lift comes from answer-key leakage a fresh reader catches), the claim is false.
- **Witness 1:** Recalled note z-20260603-50 (loadbearing) - a score smuggled through an opaque interface from a public answer key "measures nothing, however high it reads"; the public HF dataset makes this the live trap.
- **Witness 2:** Recalled note z-20260605-55 (loadbearing) - progress must gate on an accumulating win-ledger that re-runs its own witness and fails loud on non-reproducible results; independent of W1 (one is about leakage, the other about reproducibility).
- **Anchor:** `bench/exa/TARGETS.md` rank 10 pins SEAL-0 target `> 0.243` via `perplexityai/search_evals`; arxiv:2506.01062 defines SEAL-0 (111 Qs, near-zero chat-model baseline); HF `vtllms/sealqa` is the grading key.
- **Decomposition:** Split the two Exa numbers by harness/product: (A) neutral-harness basic-search 24.3% is apples-to-apples and reproducible; (B) private-harness Research-Pro 59.1% is a different product on a different, non-public scorer. The winnable claim holds for (A); it explicitly does NOT claim (B) yet.
- **Gate result:** see below.

## Verdict
loadbearing - the target *selection and frame* is witnessed by two independent loadbearing notes plus the repo's pinned target. The *win itself* ("Unbrowse beats Exa on SEAL-0") remains `unwitnessed-feeling` until suite=seal_0 runs and a fresh reader confirms no leakage. Missing witness: the actual harness run. That, and only that, settles it.
