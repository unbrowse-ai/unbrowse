#!/usr/bin/env python3
"""unbrowse_searcher.py — unbrowse as a REAL github:exa-labs/benchmarks Searcher.

The real exa-labs ABC (shared/shared/searchers/base.py) is async and returns
`SearchResult` dataclasses:

    class Searcher(ABC):
        name: str
        async def search(self, query, num_results=10) -> list[SearchResult]
        async def extract(self, url, query=None) -> list[SearchResult]

    @dataclass SearchResult: url, title, text, highlights, metadata

evals.rag ONLY calls search() and synthesizes from SearchResult.text. WAVE-07/08
diagnosis: search() returned a thin 1-2 sentence highlight missing the exact spec
passage. WAVE-09 lever (this file): search() now (1) runs a real ranked DDG SERP
via `unbrowse fetch` (libcurl-impersonate), then (2) FULL-PAGE ENRICHES the top-k
results — fetches each source page and puts the whole markdown body into `text` so
the grounder sees the exact passage. Honest-empty on SERP failure; the thin DDG
snippet is kept as fallback if a per-page fetch fails.

Drop into `shared/shared/searchers/unbrowse.py`, register in SEARCHER_BUILDERS, run:
    python -m evals.rag --searchers unbrowse --limit 10   # vs groundedness 79.4
"""
from __future__ import annotations

import asyncio
import os
import re
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

try:
    # Drop-in mode: real exa-labs base classes.
    from .base import Searcher, SearchResult  # type: ignore
except Exception:  # pragma: no cover - standalone/import-time fallback
    from abc import ABC
    from dataclasses import dataclass, field

    @dataclass
    class SearchResult:  # mirrors shared/shared/searchers/base.py
        url: str = ""
        title: str = ""
        text: str = ""
        highlights: list = field(default_factory=list)
        metadata: dict = field(default_factory=dict)

    class Searcher(ABC):
        name = "base"

        async def search(self, query: str, num_results: int = 10):
            raise NotImplementedError

        async def extract(self, url: str, query: str | None = None):
            raise NotImplementedError


UNBROWSE = os.environ.get("UNBROWSE_BIN", "/opt/homebrew/bin/unbrowse")
TIMEOUT = int(os.environ.get("UNBROWSE_TIMEOUT", "120"))

# Full-page enrichment knobs (WAVE-09 lever): for the top-k ranked SERP results we
# fetch the source page and put the FULL markdown body into SearchResult.text — the
# field evals.rag reads — so the grounder sees the exact spec passage, not a thin
# DDG highlight window. Concurrency is bounded by the engine semaphore.
ENRICH_TOP_K = int(os.environ.get("UNBROWSE_ENRICH_TOP_K", "3"))
ENRICH_CHARS = int(os.environ.get("UNBROWSE_ENRICH_CHARS", "8000"))
SERP_CONCURRENCY = int(os.environ.get("UNBROWSE_SERP_CONCURRENCY", "4"))

# `unbrowse fetch <url>` prints body markdown plus human trace lines. Strip traces.
_TRACE = re.compile(r"^(\[\d{2}:\d{2}:\d{2}|\[unbrowse\]|\[trace\]|\[debug\]|\[info\]|\[auth\]|\[exit\]|\[in-process)")

# A DDG result heading:  ## [Title](//duckduckgo.com/l/?uddg=ENCODED&rut=...)
_HEADING = re.compile(r"^##\s+\[(?P<title>.+?)\]\((?P<href>[^)]+)\)\s*$")
_LINK_LINE = re.compile(r"^\[(?P<text>.+?)\]\((?P<href>//duckduckgo\.com/l/[^)]+)\)\s*$")


def _clean(stdout: str) -> str:
    return "\n".join(
        ln for ln in stdout.splitlines() if not _TRACE.match(ln.strip())
    ).strip()


def _decode_ddg(href: str) -> str:
    """Pull the real target URL out of a DDG /l/?uddg=... redirect link."""
    if "uddg=" not in href:
        return ""
    parsed = urlparse(href if href.startswith("http") else "https:" + href)
    uddg = parse_qs(parsed.query).get("uddg", [""])[0]
    return unquote(uddg) if uddg else ""


def _passage(text: str, query: str) -> str:
    """WAVE-11 lever: return the PASSAGE_WINDOW-char window of `text` most relevant
    to the query, to raise citation precision (the WAVE-10 ceiling: grounded 60% but
    cite-precision 24% because the raw 8k head cites too much). Opt-in via
    UNBROWSE_PASSAGE_WINDOW>0; falls back to the head when no query term is found, so
    it never empties a result. Scores fixed-size windows by distinct query-term hits."""
    win = PASSAGE_WINDOW
    if win <= 0 or not text or not query:
        return text
    terms = [t for t in re.findall(r"[A-Za-z0-9]{3,}", query.lower())]
    if not terms:
        return text
    low = text.lower()
    step = max(win // 2, 1)
    best_start, best_score = 0, -1
    for start in range(0, max(len(text) - win, 0) + 1, step):
        chunk = low[start:start + win]
        score = sum(1 for t in set(terms) if t in chunk)
        if score > best_score:
            best_score, best_start = score, start
    if best_score <= 0:
        return text  # no term found — honest fallback to the head
    return text[best_start:best_start + win]
    lines = md.splitlines()
    results: list[SearchResult] = []
    i, n = 0, len(lines)
    while i < n and len(results) < num_results:
        m = _HEADING.match(lines[i].strip())
        if not m:
            i += 1
            continue
        url = _decode_ddg(m.group("href"))
        title = m.group("title").replace("**", "").strip()
        if not url:
            i += 1
            continue
        snippet = ""
        j, scanned = i + 1, 0
        while j < n and scanned < 8:
            stripped = lines[j].strip()
            if _HEADING.match(stripped):
                break
            lm = _LINK_LINE.match(stripped)
            if lm:
                text = lm.group("text").replace("**", "").strip()
                if text and not text.startswith("!") and " " in text and len(text) > 25:
                    snippet = text
                    break
            j += 1
            scanned += 1
        results.append(SearchResult(
            url=url, title=title or url, text=snippet or title,
            metadata={"enriched": False, "snippet": snippet or title},
        ))
        i = j if j > i else i + 1
    return results


async def _run(args: list[str]) -> tuple[str, bool]:
    """Invoke the unbrowse CLI off the event loop. Honest failure, never fake."""
    try:
        proc = await asyncio.create_subprocess_exec(
            UNBROWSE, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT)
        return out.decode("utf-8", "replace"), proc.returncode == 0
    except Exception as e:  # noqa: BLE001 - surface the failure, do not mask it
        return f"__UNBROWSE_ERR__ {e}", False


class UnbrowseSearcher(Searcher):
    name = "unbrowse"

    def __init__(self) -> None:
        self._sem = asyncio.Semaphore(SERP_CONCURRENCY)

    async def extract(self, url: str, query: str | None = None) -> list[SearchResult]:
        """Primary edge: url -> clean markdown via libcurl-impersonate fetch."""
        stdout, ok = await _run(["fetch", url])
        if not ok:
            return [SearchResult(url=url, metadata={"error": stdout, "ok": False})]
        text = _clean(stdout)
        return [SearchResult(url=url, text=text, metadata={"ok": True, "chars": len(text)})]

    async def search(self, query: str, num_results: int = 10) -> list[SearchResult]:
        """Ranked DDG SERP (libcurl-impersonate fetch of the DDG HTML endpoint),
        then FULL-PAGE ENRICHMENT: for the top-k results we fetch the source URL and
        put the whole page markdown into `text` (the field evals.rag reads), so the
        grounder sees the exact spec passage, not a thin DDG highlight. Honest-empty
        on SERP failure; thin DDG snippet kept as fallback if a per-page fetch fails."""
        serp_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
        async with self._sem:
            stdout, ok = await _run(["fetch", serp_url])
        if not ok:
            return []
        ranked = _parse_ddg_markdown(_clean(stdout), num_results)
        if not ranked:
            return []

        top_k = min(ENRICH_TOP_K, len(ranked))

        async def _enrich(r: SearchResult) -> SearchResult:
            if not r.url:
                return r
            async with self._sem:
                body, fok = await _run(["fetch", r.url])
            if not fok:
                return r  # keep the thin DDG snippet as honest fallback
            full = _clean(body)[:ENRICH_CHARS]
            if full:
                r.text = full
                r.metadata = {**(r.metadata or {}), "enriched": True, "chars": len(full)}
            return r

        enriched = await asyncio.gather(*[_enrich(r) for r in ranked[:top_k]])
        return list(enriched) + ranked[top_k:]


def build_unbrowse_searcher() -> "UnbrowseSearcher":
    return UnbrowseSearcher()


if __name__ == "__main__":
    import json

    async def _main() -> None:
        s = UnbrowseSearcher()
        res = await s.search("who is the ceo of anthropic", num_results=5)
        print(json.dumps(
            [{"url": r.url, "title": r.title, "text_len": len(r.text),
              "enriched": (r.metadata or {}).get("enriched")} for r in res],
            indent=2,
        ))

    asyncio.run(_main())
