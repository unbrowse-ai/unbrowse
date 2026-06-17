#!/usr/bin/env python3
"""micro_rouge — deterministic ROUGE-L extraction micro-benchmark.

The full exa webcode-benchmark needs a golden_markdown.jsonl that exa-labs does
NOT distribute. But for the GitHub-blob URLs in the corpus the authoritative
golden is unambiguous: the RAW file content. This runs the SAME deterministic
det_rouge_l metric the benchmark uses (shared/.../graders/contents.py:76) over
that raw-able subset:

    golden    = curl raw.githubusercontent.com/... (independent of unbrowse)
    extracted = unbrowse fetch <blob page>          (the thing under test)
    score     = rouge_l(golden, extracted)

No LLM, no funds. A real number for unbrowse's code-page extraction fidelity,
and the reusable scorer for the full 250-URL run once a golden / Exa key lands.
"""
import json
import re
import os
import subprocess
import sys
from pathlib import Path

UNBROWSE = os.environ.get("UNBROWSE_BIN", "/Users/lekt9/.bun/bin/unbrowse")
HERE = Path(__file__).parent
CORPUS = HERE / "vendor/benchmarks/webcode-benchmark/data/contents/code_contents.jsonl"

# Strip unbrowse + kuri human log lines so only the page payload remains.
_TRACE = re.compile(
    r"^(\[\d{2}:\d{2}:\d{2}(\.\d+)?\]|\[unbrowse\]|\[trace\]|\[debug\]|\[info\]|\[auth\]"
    r"|info:|warn:|warning:|error:|debug:|\[kuri|\[marketplace\]|\[exa\]|\[perf\]|\[lifecycle\]|\[kuri-proxy\])"
)


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


def clean(s: str) -> str:
    return "\n".join(ln for ln in s.splitlines() if not _TRACE.match(ln.strip()))


def run(cmd: list[str], timeout: int = 90) -> tuple[str, bool]:
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return res.stdout, res.returncode == 0
    except Exception as ex:  # noqa: BLE001
        return f"__ERR__ {ex}", False


def raw_url(blob: str) -> str:
    return blob.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/")


def main() -> int:
    rows = [json.loads(l) for l in open(CORPUS) if l.strip()]
    gh = [r for r in rows if "github.com" in r["url"] and "/blob/" in r["url"]]
    print(f"[micro] {len(gh)} github-blob URLs (deterministic ROUGE-L, raw-file golden)\n")
    scores = []
    for r in gh:
        blob = r["url"]
        golden, gok = run(["curl", "-sL", raw_url(blob)])
        if not gok or golden.startswith("__ERR__") or not golden.strip():
            print(f"  [skip] {r['id']}: golden fetch failed")
            continue
        ext_raw, eok = run([UNBROWSE, "act", "fetch", blob])
        extracted = clean(ext_raw) if eok else ""
        score = rouge_l(golden, extracted)
        scores.append(score)
        print(f"  {r['id']}: rouge_l={score:.4f}  golden={len(golden.split())}w extracted={len(extracted.split())}w  {blob.split('/')[-1]}")
    if not scores:
        print("\n[micro] no scores — all golden fetches failed")
        return 1
    avg = sum(scores) / len(scores)
    print(f"\n[micro] n={len(scores)}  avg_rouge_l={avg:.4f}  (exa published full-250 ROUGE-L = 0.828)")
    print("[micro] NOTE: this is the 7-URL raw-able subset, not the full 250 (golden undistributed); a real signal, not the full-benchmark settle.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
