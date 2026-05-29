# WAVE-14 — shared Qwen3 embedding substrate PARITY-VERIFIED (2026-05-29)

jesus-loop default / branch `jl/exa-browsecomp`. Task #6 settled with real numbers.

## VERIFIED: Python <-> TS embedding parity (the gate)
One shared model, Qwen3-Embedding-0.6B, two runtimes, same vectors:
- **Full precision (Python sentence-transformers fp32 <-> TS transformers.js fp32 ONNX):
  mean cosine 0.9981, min 0.9975 -> PASS (>=0.98 gate).**
- Quantized fast paths (Python MLX 4bit <-> TS ONNX q8): mean 0.9478, min 0.9387 ->
  documented tradeoff (faster, not parity-true). Use fp32 when parity matters; quant for speed.

Files (committed): bench/lib/embed_qwen.py (MLX/st/hf backends), bench/lib/embed_qwen.ts
(transformers.js, model onnx-community/Qwen3-Embedding-0.6B-ONNX — base Qwen repo ships no
ONNX), bench/lib/parity_test.py (the gate). Local .venv/node_modules gitignored.

Both verified live: Python 1024-dim RC=0 (MLX); TS 1024-dim RC=0 (q8 ONNX); parity 0.998 fp32.

## Why this matters (the two uses, from the architecture decision)
1. In-doc passage ranking — semantic chunk selection to raise RAG citation precision
   (the WAVE-10 ceiling: grounded 60% but cite-precision 24%). The real WAVE-11 lever,
   done semantically not by keyword.
2. Semantic grading — cosine vs gold to cut LLM-grader calls (the OpenRouter 402 blocker).
   Keep an LLM judge for the headline comparable-to-Exa number; embeddings cut cost on the rest.
The SAME vectors ship in @unbrowse/client (TS) — a real product capability, not just bench.

## Still open
- Wire embed-based passage ranking into bench/exa/unbrowse_searcher.py (ADDITIVE function,
  no clobber) -> graded RAG re-run vs 79.4 (needs OpenRouter credits).
- Complete the enriched BrowseComp graded run vs 0.336 (needs credits).

## Gate ledger
- Gate 1 (beat Exa RAG): 60% two-witness vs 79.4 — climbing, NOT met.
- Gate 2 (BrowseComp > 0.336): 0.200 complete; enriched blocked on credits.
- Gates 3/4/5/6: green. Task #6 (embedding substrate): DONE, parity 0.998.
- $FDRY factual note in repo; all win/promo confirm-gated until a number clears target.
