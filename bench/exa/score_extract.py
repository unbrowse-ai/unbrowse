#!/usr/bin/env python3
"""score_extract.py -- the WALK + SEAL atoms for the extraction track.

The smallest HONEST harness that pits unbrowse's extract() against Exa's
published WebCode Contents numbers (TARGETS.md tier-1 ranks 1/5/6). It does NOT
fake a win: it measures real coverage of a golden set of must-appear facts in
the extracted markdown, per URL, and reports per-URL + aggregate completeness.

This is the substrate (it emits evidence); the AGENT judges whether the score
truly beats Exa -- never a status-code stand-in (CLAUDE.md Judge step;
feedback_harness_makes_visible_agent_judges).

corpus format (bench/exa/corpus.extract.jsonl), one JSON per line:
    {"url": "...", "must": ["fact substring", "another", ...]}

metric: completeness = mean over URLs of (must-facts found / must-facts total),
recorded against Exa WebCode Contents completeness 82.8 (the number to beat).

usage: python3 score_extract.py corpus.extract.jsonl
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from searcher_unbrowse import UnbrowseSearcher  # noqa: E402

EXA_COMPLETENESS = 82.8  # WebCode Contents, github:exa-labs/benchmarks


def norm(s):
    return " ".join(s.lower().split())


def score_url(md, must):
    hay = norm(md)
    hits = [m for m in must if norm(m) in hay]
    return len(hits), [m for m in must if norm(m) not in hay]


def main(corpus):
    s = UnbrowseSearcher()
    rows = []
    with open(corpus) as f:
        cases = [json.loads(l) for l in f if l.strip()]
    total_frac = 0.0
    for c in cases:
        md = s.extract(c["url"])
        found, missing = score_url(md, c["must"])
        frac = found / len(c["must"]) if c["must"] else 0.0
        total_frac += frac
        rows.append({"url": c["url"], "chars": len(md),
                     "found": found, "total": len(c["must"]),
                     "completeness": round(100 * frac, 1),
                     "missing": missing})
    agg = round(100 * total_frac / len(cases), 1) if cases else 0.0
    report = {"metric": "WebCode-Contents completeness (golden-fact coverage)",
              "exa_to_beat": EXA_COMPLETENESS,
              "unbrowse": agg,
              "beats_exa": agg > EXA_COMPLETENESS,
              "n": len(cases),
              "per_url": rows}
    print(json.dumps(report, indent=2))
    # honest exit: non-zero if we did NOT beat Exa, so CI can gate.
    return 0 if report["beats_exa"] else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python3 score_extract.py corpus.extract.jsonl")
    sys.exit(main(sys.argv[1]))
