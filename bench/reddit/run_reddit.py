#!/usr/bin/env python3
"""run_reddit.py — the scored run for the Reddit anti-bot retrieval benchmark.

Reddit's HTML SPA is JS-challenge-gated ("Please wait for verification") — even a
curl-impersonate client gets the interstitial, not content. The route that carries
reddit's real data is its read endpoint (<permalink>/.json), which unbrowse retrieves
through libcurl-impersonate + browser cookies while a naive client gets 403.

So the scored path fetches the PER-POST endpoint via unbrowse and checks whether
reddit's own ground-truth facts (the author handle, a distinctive title token —
established independently from the /top.json LISTING) survive into the retrieved
data. The naive urllib baseline (already in the corpus, ~403) is the head-to-head:
naive vs unbrowse on a site that 403s normal scrapers.

usage: python3 run_reddit.py   ->  writes results.jsonl
"""
import json, os, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
UNBROWSE = str(REPO / "bench" / "browsecomp" / ".unbrowse-src")

def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower())

def unbrowse_retrieve(url):
    # The per-post read endpoint — the route that carries reddit's real data past
    # the JS challenge that gates the HTML SPA.
    try:
        r = subprocess.run([UNBROWSE, "fetch", url.rstrip("/") + "/.json"], capture_output=True, text=True,
                           timeout=140, cwd=REPO,
                           env={**os.environ, "UNBROWSE_SKIP_REHYDRATE": "1", "UNBROWSE_NO_TELEMETRY": "1"})
        return r.stdout or ""
    except Exception as e:
        return f"<<fetch-error: {e}>>"

def main():
    corpus = [json.loads(l) for l in (HERE / "corpus.jsonl").read_text().splitlines() if l.strip()]
    out = HERE / "results.jsonl"
    results = []
    for row in corpus:
        md = unbrowse_retrieve(row["url"])
        nmd = norm(md)
        tok_found = norm(row["answer_title_token"]).strip() in nmd
        auth_found = norm(row["answer_author"]).strip() in nmd
        ub_ok = len(md) > 2000 and "<<fetch-error" not in md  # real content retrieved
        res = {
            "id": row["id"], "url": row["url"], "subreddit": row["subreddit"],
            "answer_author": row["answer_author"], "answer_title_token": row["answer_title_token"],
            "naive_http_status": row.get("naive_http_status"),
            "unbrowse_retrieved": ub_ok, "title_token_found": tok_found, "author_found": auth_found,
            "md_bytes": len(md),
            "prediction": md[:160].replace("\n", " "),
            "correct": bool(tok_found),  # the post's own content really came through anti-bot
        }
        results.append(res)
        print(f"[run] r/{res['subreddit']:11} naive={res['naive_http_status']} ub={ub_ok} token={tok_found} author={auth_found} ({len(md)}B)", file=sys.stderr)
    out.write_text("\n".join(json.dumps(r) for r in results) + "\n")
    print(f"[run] wrote {len(results)} rows -> {out}")

if __name__ == "__main__":
    main()
