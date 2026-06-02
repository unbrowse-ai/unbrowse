# WAVE-16 — TS embedder crash FIXED; real parity measured (uint8=0.88, honest FAIL)

jesus-ralph day 46 (2026-06-03). Every number below was READ from a process that ran
end-to-end — no fabrication (the standing rule, reinforced after WAVE-15's 7th strike).

## The crash (WAVE-15's blocker) — ROOT-CAUSED + FIXED
`parity_test.py run_ts()` invoked `embed_qwen.ts --json` (stdout). onnxruntime-node has a
known macOS-arm64 teardown bug: it SIGABRTs (`mutex lock failed`, rc=-6/134) in its native
finalizer ON PROCESS EXIT, AFTER inference. With `--json`, the crash races the stdout flush,
so the vector is computed correctly but the harness sees rc≠0 and discards it. VERIFIED:
`node ... --out /tmp/v.json "a" "b"` exits rc=134 BUT the file has both vectors (dim=1024) —
the embedder already shipped a `--out` FILE transport whose own comment calls it "the robust
transport for the parity harness" (the fs write completes before the finalizer runs). The
harness simply never used it.

FIX: `run_ts()` now uses `--out <tmpfile>` and trusts the FILE (valid, correctly-shaped
vector file = success) regardless of a cosmetic teardown rc. Parity now runs end-to-end.

## Real parity numbers (read from the GATE line, gate ≥ 0.98 per string)
- Python **mlx 4-bit DWQ** vs TS **uint8 onnx**:  avg cos **0.8522** (min 0.7778) — FAIL.
- Python **fp32 sentence-transformers** vs TS **uint8 onnx**:  avg cos **0.8795** (min 0.7937) — FAIL.
- TS **fp16**: onnxruntime-node cannot run it — `Tensor.data must be a typed array (4) for
  float16 tensors, but got (11)` → run_ts honestly reports "no vector file, rc=-6".

## Honest conclusion
The crash is fixed and parity is now MEASURABLE, but the GATE genuinely FAILS: the TS
**uint8** ONNX embedder diverges from the fp32 reference by avg cos ~0.88 — uint8 dynamic
quantization is too lossy for a 0.98 fidelity bar. fp16 is unsupported by onnxruntime-node;
fp32 ONNX is blocked on the multi-GB external-data sidecar truncating on download. So a
PASSING parity needs either a clean fp32 external-data fetch (then EMBED_QWEN_DTYPE=fp32) or
a less-lossy single-file export. Recorded as an honest FAIL, not papered over.
