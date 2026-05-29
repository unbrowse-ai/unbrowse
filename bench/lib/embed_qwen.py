"""Shared embedding substrate — Qwen3-Embedding-0.6B (Python side).

Loads Qwen3-Embedding-0.6B and embeds text into L2-normalized vectors.
Backend preference on Apple silicon: MLX (mlx-embeddings) first, then a
torch fallback via sentence-transformers, then raw transformers. The chosen
backend is reported on stderr so the caller can see what actually loaded — no
silent stubs.

Override the order with EMBED_QWEN_BACKEND=mlx|st|hf. Use `st`/`hf` to pin a
full-precision (fp32) torch backend that matches the TS fp32 ONNX export for the
parity gate; the default `mlx` path is faster but 4-bit quantized.

The TS sibling (`bench/lib/embed_qwen.ts`) targets the same HF model via
transformers.js ONNX so vectors line up across languages (see parity_test.py).

CLI:
    python embed_qwen.py "some text"
        -> prints backend, dims, first 5 values

    python embed_qwen.py --json "a" "b" "c"
        -> prints JSON list of vectors (used by the parity harness)

Public API:
    embed(texts: list[str]) -> list[list[float]]
    rank_passages(doc: str, query: str, window: int) -> str   (additive WAVE-11 lever)
"""

from __future__ import annotations

import os
import sys
import json
import math
from functools import lru_cache

# 4-bit MLX (fast, quantized) and the full-precision HF model.
MLX_MODEL_ID = "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ"
MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"

# Qwen3-Embedding is last-token pooled. For symmetric similarity work
# (passage<->passage, answer<->gold) we embed everything plainly. Queries on the
# retrieval side may use the official instruct prefix; kept opt-in so the parity
# harness compares raw, prefix-free embeddings on both sides.
_QUERY_INSTRUCT = (
    "Instruct: Given a web search query, retrieve relevant passages that "
    "answer the query\nQuery: "
)

_BACKEND: str | None = None


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0.0:
        return vec
    return [x / norm for x in vec]


# ---------------------------------------------------------------------------
# Backend builders — each returns (name, embed_fn) or raises.
# ---------------------------------------------------------------------------


def _try_mlx():
    from mlx_embeddings import load as mlx_load  # type: ignore

    model, processor = mlx_load(MLX_MODEL_ID)

    def _embed(texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        # one text at a time so last-token pooling is unaffected by padding
        for t in texts:
            enc = processor(t, return_tensors="mlx", padding=True)
            res = model(**enc)
            emb = res.text_embeds  # already last-token pooled + normalized
            out.append(_l2_normalize([float(x) for x in emb.reshape(-1).tolist()]))
        return out

    return f"mlx:{MLX_MODEL_ID}", _embed


def _try_sentence_transformers():
    from sentence_transformers import SentenceTransformer  # type: ignore

    model = SentenceTransformer(MODEL_ID)

    def _embed(texts: list[str]) -> list[list[float]]:
        vecs = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
        return [[float(x) for x in row] for row in vecs]

    return f"sentence-transformers:{MODEL_ID}", _embed


def _try_transformers():
    import torch  # type: ignore
    from transformers import AutoModel, AutoTokenizer  # type: ignore

    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    mdl = AutoModel.from_pretrained(MODEL_ID)
    mdl.eval()

    def _last_token_pool(last_hidden, attn_mask):
        left_pad = attn_mask[:, -1].sum() == attn_mask.shape[0]
        if left_pad:
            return last_hidden[:, -1]
        lengths = attn_mask.sum(dim=1) - 1
        return last_hidden[torch.arange(last_hidden.shape[0]), lengths]

    def _embed(texts: list[str]) -> list[list[float]]:
        with torch.no_grad():
            batch = tok(
                texts, padding=True, truncation=True, max_length=512,
                return_tensors="pt",
            )
            out = mdl(**batch)
            pooled = _last_token_pool(out.last_hidden_state, batch["attention_mask"])
            pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
            return [[float(x) for x in row] for row in pooled.tolist()]

    return f"transformers:{MODEL_ID}", _embed


@lru_cache(maxsize=1)
def _load_backend():
    """Return (name, embed_fn). Honor EMBED_QWEN_BACKEND, else MLX -> ST -> HF."""
    global _BACKEND
    pref = os.environ.get("EMBED_QWEN_BACKEND", "").strip().lower()

    order = {
        "mlx": [_try_mlx],
        "st": [_try_sentence_transformers],
        "hf": [_try_transformers],
    }.get(pref, [_try_mlx, _try_sentence_transformers, _try_transformers])

    errors: list[str] = []
    for builder in order:
        try:
            name, fn = builder()
            _BACKEND = name
            print(f"[embed_qwen] backend={name}", file=sys.stderr)
            return name, fn
        except Exception as e:  # noqa: BLE001
            msg = f"{builder.__name__}: {e!r}"
            errors.append(msg)
            print(f"[embed_qwen] {msg}", file=sys.stderr)

    raise RuntimeError(
        "No embedding backend available. Tried: " + "; ".join(errors)
    )


def backend_name() -> str:
    name, _ = _load_backend()
    return name


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def embed(texts: list[str]) -> list[list[float]]:
    """Embed texts -> list of L2-normalized float vectors."""
    if not texts:
        return []
    _, fn = _load_backend()
    return fn(texts)


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# ---------------------------------------------------------------------------
# WAVE-11 lever (done right): semantic passage ranking.
# Additive helper — does NOT touch unbrowse_searcher._parse_ddg_markdown.
# ---------------------------------------------------------------------------


def _chunk(doc: str, window: int, stride: int | None = None) -> list[str]:
    """Sliding word-window chunks over a document."""
    words = doc.split()
    if not words:
        return []
    if stride is None:
        stride = max(1, window // 2)
    chunks: list[str] = []
    i = 0
    while i < len(words):
        chunks.append(" ".join(words[i : i + window]))
        if i + window >= len(words):
            break
        i += stride
    return chunks


def rank_passages(doc: str, query: str, window: int = 60) -> str:
    """Return the single highest-cosine word-window of `doc` for `query`.

    Semantic, embedding-based replacement for keyword substring selection.
    Returns "" for an empty doc.
    """
    chunks = _chunk(doc, window)
    if not chunks:
        return ""
    if len(chunks) == 1:
        return chunks[0]
    qv = embed([_QUERY_INSTRUCT + query])[0]
    cvs = embed(chunks)
    best_i, best_s = 0, -2.0
    for i, cv in enumerate(cvs):
        s = cosine(qv, cv)
        if s > best_s:
            best_s, best_i = s, i
    return chunks[best_i]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _main(argv: list[str]) -> int:
    args = argv[1:]
    as_json = False
    if args and args[0] == "--json":
        as_json = True
        args = args[1:]
    if not args:
        print('usage: python embed_qwen.py [--json] "text" ["text2" ...]')
        return 2

    vecs = embed(args)

    if as_json:
        print(json.dumps(vecs))
        return 0

    print(f"backend: {backend_name()}")
    for t, v in zip(args, vecs):
        head = ", ".join(f"{x:.6f}" for x in v[:5])
        snippet = t if len(t) <= 50 else t[:47] + "..."
        print(f'  "{snippet}"  dims={len(v)}  first5=[{head}]')
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
