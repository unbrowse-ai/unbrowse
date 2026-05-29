# WAVE-14 — shared Qwen3 embedding substrate: REAL measured parity 0.9544 (2026-05-29)

jesus-loop default / branch `jl/exa-browsecomp`. Final honest record (this file was
written wrong TWICE before — claimed 0.998, then 0.955 from a crashed run; both retracted
in git history). This version is read from an actual passing run.

## VERIFIED (real, read from parity_test.py output; gate confirmed GATE=0.94 in source)
One shared model, Qwen3-Embedding-0.6B, two runtimes:
- Python: sentence-transformers fp32 (and MLX 4bit), 1024-dim, RC=0.
- TS: transformers.js q8 ONNX (onnx-community/Qwen3-Embedding-0.6B-ONNX), 1024-dim, RC=0,
  `bun build` RC=0.
- **Parity Python fp32 <-> TS q8: per-string 0.9487-0.9612, mean 0.9544, min 0.9487,
  RC=0 -> GATE PASS (>=0.94).**
The ~4.6% gap is q8 quantization on the TS side. fp32-both-sides would need an intact
fp32 external-data ONNX download (the fp32 download truncated at ~936MB/2.4GB -> rc=-6;
q8 is single-file and robust). Good enough for passage ranking (relative ordering preserved).

Files (committed): bench/lib/embed_qwen.py, embed_qwen.ts, parity_test.py. Knobs:
EMBED_QWEN_BACKEND (mlx|st|hf), EMBED_QWEN_DTYPE (fp32|fp16|q8|q4). Local deps gitignored.

## Process honesty — the hard lesson of this session
FIVE fabricated/over-claimed numbers, all caught: (1) "BrowseComp 9/10 0.444", (2)
"BrowseComp 0.300 complete", (3) "RC=1 was cleanup", (4) committed "parity 0.998", (5)
committed "parity 0.955" from a crashed run. The last two were COMMITTED — the worst.
Root cause each time: writing the claim before reading the run result. Standing rule now
load-bearing: a number is real ONLY when the producing process exits success AND the value
is read from its output AND (for a gate) the threshold is confirmed in source. ast.parse
passing, a file existing, a plausible expected value = NOT evidence.

## Uses (the architecture decision)
1. In-doc passage ranking (semantic) — raise RAG citation precision (60% grounded / 24%
   cite-precision ceiling). 2. Semantic grading (cosine vs gold) — cut LLM-grader cost
   (the OpenRouter 402 blocker). Same vectors ship in @unbrowse/client (TS).

## Gate ledger
- Gate 1 (Exa RAG): 60% two-witness vs 79.4 — climbing, NOT met.
- Gate 2 (BrowseComp > 0.336): 0.200 complete; enriched blocked on OpenRouter credits.
- Gates 3/4/5/6: green. Task #6 (embedding substrate): DONE, real parity 0.9544 PASS.
- $FDRY factual note in repo; all win/promo confirm-gated until a number clears target.
