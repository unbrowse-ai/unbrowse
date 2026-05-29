#!/usr/bin/env python3
"""searcher_unbrowse.py -- unbrowse as an exa-labs/benchmarks `Searcher`.

The exa-labs harness (github:exa-labs/benchmarks, MIT) scores any object exposing:

    search(query: str)  -> list[{"url","title","snippet"}]   # SERP ranking
    extract(url: str)   -> str (markdown)                     # page -> markdown

This adapter wraps the REAL unbrowse CLI surface (verified `unbrowse --help`,
v7.0.2):

    extract(url)  -> `unbrowse fetch <url>`         # PRIMARY url->markdown, live-verified
    search(query) -> `unbrowse resolve --intent ..`# intent -> endpoint shortlist

STRATEGY (cited bench/exa/TARGETS.md): unbrowse's real edge is multi-layer
EXTRACTION (network + SSR JSON + JS heap + DOM via libcurl-impersonate). So
`extract()` -- feeding WebCode Contents (beat 82.8/89.3) and Highlights (beat
94.8/93.2) -- is where we win first, and it is verified working. `search()`
(SERP ranking for People/Company suites) is wired but HONESTLY flagged: unbrowse
resolves intents->APIs, it is not yet a ranked-URL SERP engine. Do not report a
SERP win until search() is a real ranker -- that would be fabricated green.
"""
import json
import os
import re
import subprocess

UNBROWSE = os.environ.get("UNBROWSE_BIN", "/opt/homebrew/bin/unbrowse")
TIMEOUT = int(os.environ.get("UNBROWSE_TIMEOUT", "120"))


def _run(args):
    """Invoke the unbrowse CLI, return (stdout, ok). Honest failure, never fake."""
    try:
        p = subprocess.run([UNBROWSE, *args],
                           capture_output=True, text=True, timeout=TIMEOUT)
        return p.stdout, (p.returncode == 0)
    except Exception as e:
        return f"__UNBROWSE_ERR__ {e}", False


def _first_json(text):
    """Pull the first JSON object/array out of mixed stdout."""
    for opener, closer in (("{", "}"), ("[", "]")):
        i = text.find(opener)
        if i < 0:
            continue
        depth = 0
        for j in range(i, len(text)):
            if text[j] == opener:
                depth += 1
            elif text[j] == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[i:j + 1])
                    except Exception:
                        break
    return None


class UnbrowseSearcher:
    name = "unbrowse"

    def extract(self, url: str) -> str:
        """Page -> markdown via `unbrowse fetch` (multi-layer extraction).

        unbrowse's home turf: SSR/JSON/heap-recovered content the raw DOM misses.
        LIVE-VERIFIED on example.com (RC=0, markdown + links). Honest empty on
        failure so the grader scores it a miss rather than a fabricated pass.
        """
        out, ok = _run(["fetch", url])
        return out if (ok and out.strip()) else ""

    def search(self, query: str):
        """Intent -> endpoint shortlist via `unbrowse resolve`.

        ARCHITECTURAL GAP (flagged, not faked): resolve returns API endpoints for
        an intent, not a ranked SERP of content URLs. We surface its shortlist so
        the harness runs end-to-end, but a real ranking backend is the
        load-bearing work for People/Company suites (TARGETS.md tiers 3-4).
        """
        out, ok = _run(["resolve", "--intent", query, "--no-execute", "--json"])
        if not ok:
            return []
        data = _first_json(out)
        if not isinstance(data, (dict, list)):
            return []
        items = data if isinstance(data, list) else (
            data.get("endpoints") or data.get("results")
            or data.get("candidates") or data.get("shortlist") or [])
        results = []
        for it in items[:10]:
            if not isinstance(it, dict):
                continue
            url = it.get("url") or it.get("endpoint") or it.get("href") or ""
            if url:
                results.append({"url": url,
                                "title": it.get("title", "") or it.get("name", ""),
                                "snippet": it.get("summary", "") or it.get("description", "")})
        return results


if __name__ == "__main__":
    import sys
    s = UnbrowseSearcher()
    if len(sys.argv) > 2 and sys.argv[1] == "extract":
        md = s.extract(sys.argv[2])
        print(f"[extract {sys.argv[2]}] {len(md)} chars")
        print(md[:1500])
    elif len(sys.argv) > 2 and sys.argv[1] == "search":
        print(json.dumps(s.search(sys.argv[2]), indent=2))
    else:
        print("usage: searcher_unbrowse.py [extract URL | search QUERY]")
