#!/usr/bin/env python3
"""score_reddit.py — aggregate + gate the Reddit anti-bot retrieval benchmark.

Reports the head-to-head:
  - naive HTTP success rate  (urllib .json; expected ~0% — reddit 403s scrapers)
  - unbrowse retrieval rate   (real content came back through anti-bot)
  - title-token recovery      (the specific post's content survived to extraction)
  - author recovery           (the OP handle survived to extraction)

Gates: unbrowse retrieval rate must beat the naive baseline (the moat is real).

usage: python3 score_reddit.py [results.jsonl]
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "results.jsonl"
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    n = len(rows)
    if not n:
        print("score: no results"); sys.exit(1)
    naive_ok = sum(1 for r in rows if r.get("naive_http_status") == 200)
    ub_ok = sum(1 for r in rows if r.get("unbrowse_retrieved"))
    tok = sum(1 for r in rows if r.get("title_token_found"))
    auth = sum(1 for r in rows if r.get("author_found"))
    pct = lambda x: f"{100*x/n:5.1f}%  ({x}/{n})"
    print("=== Reddit anti-bot retrieval benchmark ===")
    print(f"  corpus: {n} posts across {len(set(r['subreddit'] for r in rows))} subreddits, ground-truth from reddit's own listing")
    print(f"  naive HTTP (urllib .json):  {pct(naive_ok)}   <- a normal scraper")
    print(f"  unbrowse retrieved content: {pct(ub_ok)}")
    print(f"  title-token recovered:      {pct(tok)}")
    print(f"  author handle recovered:    {pct(auth)}")
    print()
    # gate: unbrowse must beat naive on retrieval (the whole point)
    if ub_ok > naive_ok and tok >= max(3, n // 2):
        print(f"REDDIT-GATE PASS — unbrowse {ub_ok}/{n} vs naive {naive_ok}/{n}; title recovered {tok}/{n}")
        sys.exit(0)
    print(f"REDDIT-GATE not-yet — unbrowse {ub_ok}/{n} vs naive {naive_ok}/{n}; title {tok}/{n}")
    sys.exit(1)

if __name__ == "__main__":
    main()
