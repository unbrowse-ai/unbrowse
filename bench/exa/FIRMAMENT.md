# Exa/BrowseComp Firmament

Step 2 shape only: separate the waters before changing gates or scoring code.

## Boundaries

- **Target ledger:** `bench/exa/TARGETS.md` is the source of benchmark targets; it names Exa published numbers and the command family that can prove or refute each.
- **Exa lane:** `bench/exa/` owns Exa harness adapters, extraction/RAG/SEAL-0 invariants, and Exa-vs-unbrowse head-to-head witnesses; it must not decide BrowseComp robustness.
- **BrowseComp lane:** `bench/browsecomp/` owns question-to-answer multi-hop evals against target `0.336`; it must not reuse URL/fact extraction gates as proof.
- **Historical evidence:** wave docs, `runs.ledger.jsonl`, and logs record what happened; they are evidence inputs, never release gates by themselves.
- **Fast read gates:** grep-only gates may summarize logs for triage, but they must be named `fast` or `historical` and may not be used as the final win witness.
- **Robust win gates:** final BrowseComp success requires a real completed eval with `N >= 25` by default, target `> 0.336`, and no contradiction from `BROWSECOMP-VERDICT.md`.
- **Invariant gates:** SEAL-0 and similar harness invariants are foundation checks; a silent-empty or answer-key leak is a red gate even when accuracy numbers are already bad.
- **Paper/release gates:** `scripts/paper-gate.sh`, `scripts/leak-guard.sh`, client audit, and npm/release gates certify public artifacts only after benchmark lanes are honest.
- **Obsolete guardrails:** any gate that can pass on a refuted noisy sample belongs in quarantine or must be renamed so it cannot stand for the completion promise.
- **Next vessel:** add a manifest that classifies each benchmark script by `lane`, `evidence_class`, `minimum_n`, and `release_eligible` before modifying scoring behavior.
