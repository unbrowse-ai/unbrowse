#!/usr/bin/env python3
"""build_corpus.py — build the Reddit anti-bot retrieval benchmark.

Reddit's edge blocks naive HTTP (urllib → 403) and residential-proxy .json — the
2023 API lockdown. That block IS the benchmark: the moat, made measurable.

Ground truth comes from reddit's OWN official listing data (/r/<sub>/top.json),
retrieved through unbrowse's libcurl-impersonate channel (the only client that
gets past the block). Each row's AUTHOR and a distinctive TITLE token are taken
straight from reddit's data — objective facts, not a model guess. The scored run
(run_reddit.py) asks unbrowse's general HTML→markdown path for those same facts,
and records the naive urllib 403 baseline: a head-to-head on real anti-bot Reddit.

usage: python3 build_corpus.py   ->  writes corpus.jsonl
"""
import json, os, re, subprocess, sys, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
UNBROWSE = str(REPO / "bench" / "browsecomp" / ".unbrowse-src")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
SUBS = ["IAmA", "science", "programming"]
PER_SUB = 3

def naive_status(url):
    try:
        req = urllib.request.Request(url.rstrip("/") + "/.json", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return -1

def unbrowse_fetch_json(url):
    r = subprocess.run([UNBROWSE, "fetch", url], capture_output=True, text=True, timeout=140, cwd=REPO,
                       env={**os.environ, "UNBROWSE_SKIP_REHYDRATE": "1", "UNBROWSE_NO_TELEMETRY": "1"})
    raw = r.stdout
    i = min([x for x in (raw.find("["), raw.find("{")) if x >= 0], default=-1)
    if i < 0:
        raise ValueError("no JSON in unbrowse output")
    return json.JSONDecoder().raw_decode(raw[i:])[0]

def distinctive_token(title):
    stop = {"about", "anything", "their", "there", "would", "which", "where"}
    toks = [t for t in re.findall(r"[A-Za-z]{5,}", title or "") if t.lower() not in stop]
    toks = sorted(set(toks), key=len, reverse=True)
    return toks[0] if toks else (title or "").strip()[:12]

def main():
    rows, seen = [], set()
    for sub in SUBS:
        try:
            obj = unbrowse_fetch_json(f"https://www.reddit.com/r/{sub}/top.json?t=all&limit=15")
            children = obj["data"]["children"]
        except Exception as e:
            print(f"[build] listing FAIL r/{sub}: {e}", file=sys.stderr); continue
        n = 0
        for c in children:
            if n >= PER_SUB: break
            d = c.get("data", {})
            author, title = d.get("author"), d.get("title") or ""
            pid, perm = d.get("id"), d.get("permalink")
            if not author or author == "[deleted]" or not title or not perm or pid in seen:
                continue
            seen.add(pid)
            url = "https://www.reddit.com" + perm
            row = {
                "id": pid, "url": url, "subreddit": d.get("subreddit") or sub,
                "answer_author": author, "answer_title_token": distinctive_token(title),
                "title": title, "naive_http_status": naive_status(url),
            }
            rows.append(row); n += 1
            print(f"[build] r/{row['subreddit']} author={author} token={row['answer_title_token']} (naive {row['naive_http_status']})", file=sys.stderr)
    out = HERE / "corpus.jsonl"
    out.write_text("\n".join(json.dumps(r) for r in rows) + ("\n" if rows else ""))
    print(f"[build] wrote {len(rows)} rows -> {out}")
    sys.exit(0 if len(rows) >= 3 else 1)

if __name__ == "__main__":
    main()
