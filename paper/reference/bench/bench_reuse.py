"""bench_reuse.py — prove the mechanism the whitepaper's speedup rests on.

The published field result (arXiv:2604.00694) is cached route execution at 950ms
vs 3,404ms browser rediscovery (3.6x mean / 5.4x median) across 94 live domains.
We cannot reproduce a live-web browser study in a sandbox, and we do not pretend
to. What we CAN prove here, runnably and deterministically, is the underlying
mechanism: reusing a content-addressed result is dramatically cheaper than
re-deriving it. That is the structural reason the field speedup exists.

Method: a 'rediscovery' models the expensive path an agent pays on a cold route ---
re-parsing/extracting a representative payload (real CPU work, repeated to mimic the
DOM-parse + extraction cost). A 'cached reuse' is the content-addressed lookup the
shared graph turns that into: one sha256 key, one read. We measure real wall-clock
over N trials and report mean + median speedup. This is a mechanism demonstration,
NOT the 94-domain field study; the field number is cited, this number is measured.
"""
import hashlib
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ledger.cache import ContentCache, content_hash

# A representative payload: ~64 KB, the order of an extracted SSR/JSON blob.
PAYLOAD = (b'{"products":[' + b'{"id":123,"name":"widget","price":4299,"sku":"WX-1"},' * 1200 + b']}')


def rediscover(blob: bytes) -> bytes:
    """The cold path: re-derive the result. Models browser-extraction CPU cost ---
    parse the structure repeatedly, as a real agent re-running DOM/JSON extraction
    on every cold visit. Real work, not a sleep."""
    acc = 0
    for _ in range(40):  # repeated passes ~ the parse/extract/validate a browser redoes
        for i in range(0, len(blob), 64):
            acc ^= hash(blob[i:i + 64])
    # the "result" is the canonical extracted value
    return hashlib.sha256(blob).digest() + acc.to_bytes(8, "little", signed=True)


def main(n=60):
    cache = ContentCache(os.path.join(os.path.dirname(__file__), ".bench-cache"))
    # warm the cache once with the rediscovered result
    key = cache.put(rediscover(PAYLOAD))

    cold, warm = [], []
    for _ in range(n):
        t0 = time.perf_counter(); rediscover(PAYLOAD);        cold.append(time.perf_counter() - t0)
        t0 = time.perf_counter(); cache.get(key); cache.verify(key); warm.append(time.perf_counter() - t0)

    cold_ms = [x * 1000 for x in cold]
    warm_ms = [x * 1000 for x in warm]
    ratios = [c / w for c, w in zip(cold, warm) if w > 0]
    report = {
        "n": n,
        "rediscover_mean_ms": round(statistics.mean(cold_ms), 3),
        "rediscover_median_ms": round(statistics.median(cold_ms), 3),
        "cached_reuse_mean_ms": round(statistics.mean(warm_ms), 4),
        "cached_reuse_median_ms": round(statistics.median(warm_ms), 4),
        "speedup_mean": round(statistics.mean(ratios), 1),
        "speedup_median": round(statistics.median(ratios), 1),
        "note": "mechanism demonstration (recompute vs content-addressed reuse); "
                "the 94-domain live-web field result is arXiv:2604.00694, not this.",
    }
    print(json.dumps(report, indent=2))
    # honest gate: reuse MUST be materially faster, else the mechanism claim is false.
    return 0 if report["speedup_mean"] > 2.0 else 1


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 60))
