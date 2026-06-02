#!/usr/bin/env python3
"""score_extraction — deterministic ROUGE-L of unbrowse's extraction vs a golden.

The committed witness for the exa webcode "contents" extraction bench. Pairs with
gen_golden.py (which produces the golden legally — see its header). Given a
golden_markdown jsonl ({id, expected_markdown}), it runs unbrowse's extraction
(`fetch --main`, the readable main-content path) for each id's URL and scores the
det_rouge_l the benchmark uses (shared/.../graders/contents.py rouge_l).

    golden    = gen_golden.py output (raw-file for github, LLM-faithful otherwise)
    extracted = unbrowse fetch --main <url>   (the thing under test)
    score     = rouge_l(golden, extracted)     per-url + avg

Honest scope: this measures EXTRACTION FIDELITY on whatever golden you pass. The
github-blob subset is a rigorous exact golden (raw file); the LLM golden is
equivalent-not-identical to exa's. As of d99 unbrowse beats Exa's published 0.828
on clean/code pages (github=1.0) but the broad blog-CMS avg is ~0.70 due to
prose-like chrome over-extraction — the standing gap a real readability port must
close (heuristic boilerplate removal was proven insufficient, d98-99).

Usage:
    UNBROWSE_BIN=... python3 score_extraction.py <golden.jsonl> [--raw]
    --raw : score plain `fetch` (no --main) instead of the readable path.
"""
import json
import os
import re
import statistics
import subprocess
import sys
from pathlib import Path

UNBROWSE = os.environ.get("UNBROWSE_BIN", "/Users/lekt9/.bun/bin/unbrowse")
HERE = Path(__file__).parent
CORPUS = HERE / "vendor/benchmarks/webcode-benchmark/data/contents/code_contents.jsonl"
EXA_PUBLISHED = 0.828

_TRACE = re.compile(
    r"^(\[\d{2}:\d{2}:\d{2}(\.\d+)?\]|\[unbrowse\]|\[trace\]|\[debug\]|\[info\]|\[auth\]"
    r"|info:|warn:|warning:|error:|debug:|\[kuri|\[marketplace\]|\[exa\]|\[perf\]|\[lifecycle\]|\[kuri-proxy\])"
)


def clean(s: str) -> str:
    return "\n".join(ln for ln in s.splitlines() if not _TRACE.match(ln.strip()))


def rouge_l(golden: str, extracted: str) -> float:
    g, e = golden.split(), extracted.split()
    if not g or not e:
        return 0.0
    MAX = 10_000
    g, e = g[:MAX], e[:MAX]
    m, n = len(g), len(e)
    prev = [0] * (n + 1)
    for i in range(1, m + 1):
        curr = [0] * (n + 1)
        gi = g[i - 1]
        for j in range(1, n + 1):
            curr[j] = prev[j - 1] + 1 if gi == e[j - 1] else max(prev[j], curr[j - 1])
        prev = curr
    lcs = prev[n]
    p, r = lcs / n, lcs / m
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    golden_path = Path(args[0])
    extract_flags = [] if "--raw" in sys.argv else ["--main"]
    urls = {}
    for line in CORPUS.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            urls[row["id"]] = row["url"]
    golden = {}
    for line in golden_path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            golden[row["id"]] = row["expected_markdown"]

    scores = []
    for qid, gold in golden.items():
        url = urls.get(qid)
        if not url:
            continue
        gold_w = len(gold.split())
        # Retry on a THIN render, not on a low score. Some pages serve variable
        # content (bot-protection / response race) — the golden itself was caught
        # on a full render, so we fetch until the extraction's render is comparably
        # substantial (>=30% of the golden, floor 200w), keeping the FULLEST render.
        # This isolates EXTRACTION fidelity from fetch's render non-determinism;
        # it does not cherry-pick rouge_l (we score whatever the fullest render
        # extracts). Capped at 3 tries.
        target = max(200, int(gold_w * 0.3))
        ext = ""
        for _try in range(3):
            try:
                r = subprocess.run([UNBROWSE, "fetch", url, *extract_flags],
                                   capture_output=True, text=True, timeout=120)
                cand = clean(r.stdout).strip()
            except Exception:  # noqa: BLE001
                cand = ""
            if len(cand.split()) > len(ext.split()):
                ext = cand
            if len(ext.split()) >= target:
                break
        s = rouge_l(gold, ext)
        scores.append(s)
        print(f"  {qid}: rouge_l={s:.4f}  golden={gold_w}w extracted={len(ext.split())}w  {url[:50]}")
    if scores:
        avg = statistics.mean(scores)
        beat = sum(1 for s in scores if s >= EXA_PUBLISHED)
        print(f"\n[score] n={len(scores)}  avg_rouge_l={avg:.4f}  "
              f">={EXA_PUBLISHED}:{beat}/{len(scores)}  (exa published full-250 = {EXA_PUBLISHED})")
        # --gate: witness mode. Exit 0 ONLY when unbrowse's extraction avg clears
        # Exa's published 0.828 on the (self-generated, legal) golden — the
        # backlog gate's re-runnable proof, no fabricated green.
        if "--gate" in sys.argv:
            if avg >= EXA_PUBLISHED:
                print(f"[gate] PASS avg {avg:.4f} >= {EXA_PUBLISHED}")
                return 0
            print(f"[gate] FAIL avg {avg:.4f} < {EXA_PUBLISHED}")
            return 1
    elif "--gate" in sys.argv:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
