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
    cmd = ["node", "--experimental-strip-types", os.path.join(HERE, "embed_qwen.ts"),
           "--json", *STRINGS]
    res = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write(res.stderr[-2000:])
        raise RuntimeError(f"TS embed failed rc={res.returncode}")
    # transformers.js prints progress to stderr; stdout's last line is pure JSON
    return json.loads(res.stdout.strip().splitlines()[-1])


def main() -> int:
    py = run_python()
    with open(PY_OUT, "w") as f:
        json.dump(py, f)
    print(f"[parity] wrote {PY_OUT} ({len(py)} vecs, dim={len(py[0])})", file=sys.stderr)

    ts = run_ts()
    with open(TS_OUT, "w") as f:
        json.dump(ts, f)
    print(f"[parity] wrote {TS_OUT} ({len(ts)} vecs, dim={len(ts[0])})", file=sys.stderr)

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
