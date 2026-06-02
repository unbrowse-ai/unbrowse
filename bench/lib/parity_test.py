#!/usr/bin/env python3
"""Parity gate: same strings embedded by Python (MLX/torch) and TS (transformers.js).

Runs both backends on the SAME strings, dumps vectors to /tmp/parity_py.json and
/tmp/parity_ts.json, then reports per-string Python<->TS cosine. The vectors are
already L2-normalized on both sides, so cosine ~= dot product.

PARITY GATE: cosine >= 0.98 per string. If the TS ONNX export and the Python
backend use different quantization (e.g. MLX 4-bit vs ONNX fp32), the cosine is
reported honestly even if it falls below the gate — no green is claimed that
wasn't measured. Pin EMBED_QWEN_BACKEND=st for the fp32-vs-fp32 comparison.

Usage:
    EMBED_QWEN_BACKEND=st ./.venv/bin/python parity_test.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY_OUT = "/tmp/parity_py.json"
TS_OUT = "/tmp/parity_ts.json"
GATE = 0.98

STRINGS = [
    "The quick brown fox jumps over the lazy dog.",
    "Photosynthesis converts sunlight into chemical energy in plants.",
    "The Eiffel Tower is located in Paris, France.",
    "Embeddings map text into a dense vector space for similarity search.",
    "Mount Everest is the highest mountain above sea level.",
]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def run_python() -> list[list[float]]:
    import embed_qwen  # local

    print(f"[parity] python backend: {embed_qwen.backend_name()}", file=sys.stderr)
    return embed_qwen.embed(STRINGS)


def run_ts() -> list[list[float]]:
    # Use the embedder's --out FILE transport, NOT --json stdout. onnxruntime-node
    # has a known macOS-arm64 teardown bug: it SIGABRTs ("mutex lock failed",
    # rc=-6/134) in its native finalizer on process exit, AFTER inference. With
    # --json the crash races the stdout flush and the harness sees a non-zero rc
    # for a vector that was computed fine; with --out, embed_qwen.ts writes the
    # vectors to disk BEFORE that finalizer ever runs (verified: file complete,
    # rc=134). So we trust the FILE — a valid, correctly-shaped vector file means
    # the embed succeeded, regardless of a cosmetic teardown crash on exit.
    out_path = os.path.join(tempfile.gettempdir(), "parity_ts_vecs.json")
    cmd = ["node", "--experimental-strip-types", os.path.join(HERE, "embed_qwen.ts"),
           "--out", out_path, *STRINGS]
    env = {k: v for k, v in os.environ.items() if not k.startswith("EMBED_QWEN_BACKEND")}
    env["OMP_NUM_THREADS"] = "1"
    env["ORT_NUM_THREADS"] = "1"
    last = None
    for _ in range(2):
        if os.path.exists(out_path):
            os.remove(out_path)
        res = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, env=env)
        if os.path.exists(out_path):
            try:
                vecs = json.loads(open(out_path).read())
            except Exception:
                vecs = None
            if isinstance(vecs, list) and len(vecs) == len(STRINGS) and all(
                isinstance(v, list) and v for v in vecs
            ):
                return vecs
        last = res
    if last is not None:
        sys.stderr.write((last.stderr or "")[-2000:])
    raise RuntimeError(f"TS embed produced no vector file (last rc={last.returncode if last else '?'})")
def main() -> int:
    # Run TS FIRST — before importing torch/sentence-transformers in this process —
    # so onnxruntime-node does not collide with a resident torch model (rc=-6 mutex).
    ts = run_ts()
    with open(TS_OUT, "w") as f:
        json.dump(ts, f)
    print(f"[parity] wrote {TS_OUT} ({len(ts)} vecs, dim={len(ts[0])})", file=sys.stderr)

    py = run_python()
    with open(PY_OUT, "w") as f:
        json.dump(py, f)
    print(f"[parity] wrote {PY_OUT} ({len(py)} vecs, dim={len(py[0])})", file=sys.stderr)

    assert len(py) == len(ts) == len(STRINGS)
    assert len(py[0]) == len(ts[0]), f"dim mismatch py={len(py[0])} ts={len(ts[0])}"

    print(f"\nParity (Python<->TS cosine, gate >= {GATE}):")
    print(f"  dims: py={len(py[0])} ts={len(ts[0])}")
    all_pass = True
    cosines = []
    for s, a, b in zip(STRINGS, py, ts):
        c = cosine(a, b)
        cosines.append(c)
        ok = "PASS" if c >= GATE else "FAIL"
        if c < GATE:
            all_pass = False
        snip = s if len(s) <= 48 else s[:45] + "..."
        print(f'  [{ok}] cos={c:.4f}  "{snip}"')

    mn = min(cosines)
    avg = sum(cosines) / len(cosines)
    print(f"\n  min={mn:.4f}  avg={avg:.4f}")
    print(f"  GATE {'PASS' if all_pass else 'FAIL'} (>= {GATE} per string)")
    return 0 if all_pass else 1
if __name__ == "__main__":
    sys.path.insert(0, HERE)
    raise SystemExit(main())
