#!/usr/bin/env python3
"""unbrowse_browsecomp_searcher.py — unbrowse as a REAL perplexityai/search_evals
search engine (NEW interface, verified 2026-05-29 against the cloned repo).

The exa-labs ABC the prior WAVE-02/03 adapter targeted is NOT this repo's shape.
perplexityai/search_evals defines (search_engines/types.py):

    class SearchResult(BaseModel):  url: str; title: str; snippet: str
    class AsyncSearchEngine(ABC):
        async def __call__(self, query: str, num_results: int) -> list[SearchResult]

The agent (DeepResearchAgent / SingleStepSearchAgent) is the LLM; it calls the
search engine as the `search_web` tool and writes the final answer itself. So the
search engine ONLY needs to return ranked {url, title, snippet} results — exactly
what a SERP returns.

HOW search() ACTUALLY GETS RANKED URLs (this is the real edge, not degenerate):
  `unbrowse fetch https://html.duckduckgo.com/html/?q=<query>` routes through
  unbrowse's libcurl-impersonate (Chrome 131 JA4) fetch and returns the DDG HTML
  SERP converted to clean markdown. DDG returns results IN RANK ORDER as:

      ## [TITLE](//duckduckgo.com/l/?uddg=<urlencoded real url>&rut=...)
       [domain](redirect)
      [SNIPPET TEXT](redirect)

  We parse each `## [..](..uddg=..)` heading in document order (= rank order),
  url-decode the real target URL out of the `uddg=` param, and pull the snippet
  paragraph that follows. No bot-wall observed (the impersonated fetch passes).

This is a genuine ranked-URL SERP via unbrowse — NOT the intent->endpoint
`resolve` path (which is not a SERP ranker and would be a fabricated win).

Drop into search_evals/search_engines/unbrowse.py and register in
SEARCH_ENGINES as "unbrowse".
"""
from __future__ import annotations

import asyncio
import os
import re
from urllib.parse import parse_qs, unquote, urlparse

try:
    # Drop-in mode: real perplexityai/search_evals base classes.
    from search_evals.search_engines.types import AsyncSearchEngine, SearchResult  # type: ignore
except Exception:  # pragma: no cover - standalone import-time fallback for self-test
    from abc import ABC, abstractmethod

    from pydantic import BaseModel

    class SearchResult(BaseModel):  # type: ignore[no-redef]
        url: str
        title: str
        snippet: str

    class AsyncSearchEngine(ABC):  # type: ignore[no-redef]
        @abstractmethod
        async def __call__(self, query: str, num_results: int) -> list[SearchResult]: ...


UNBROWSE = os.environ.get("UNBROWSE_BIN", "/opt/homebrew/bin/unbrowse")
TIMEOUT = int(os.environ.get("UNBROWSE_TIMEOUT", "120"))

# Strip unbrowse's human trace lines so only SERP markdown remains.
_TRACE = re.compile(r"^(\[\d{2}:\d{2}:\d{2}\]|\[unbrowse\]|\[trace\]|\[debug\]|\[info\]|\[auth\])")

# A DDG result heading:  ## [Title](//duckduckgo.com/l/?uddg=ENCODED&rut=...)
_HEADING = re.compile(r"^##\s+\[(?P<title>.+?)\]\((?P<href>[^)]+)\)\s*$")
# A markdown link line whose target is the DDG redirect — used to find the snippet.
_LINK_LINE = re.compile(r"^\[(?P<text>.+?)\]\((?P<href>//duckduckgo\.com/l/[^)]+)\)\s*$")


def _clean(stdout: str) -> str:
    return "\n".join(ln for ln in stdout.splitlines() if not _TRACE.match(ln.strip()))


def _decode_ddg(href: str) -> str:
    """Pull the real target URL out of a DDG /l/?uddg=... redirect link."""
    if "uddg=" not in href:
        return ""
    # href is protocol-relative (//duckduckgo.com/l/?...). Normalise for parsing.
    parsed = urlparse(href if href.startswith("http") else "https:" + href)
    qs = parse_qs(parsed.query)
    uddg = qs.get("uddg", [""])[0]
    return unquote(uddg) if uddg else ""


def parse_ddg_markdown(md: str, num_results: int) -> list["SearchResult"]:
    """Parse DDG-HTML-as-markdown into ranked SearchResults. Document order = rank."""
    lines = md.splitlines()
    results: list[SearchResult] = []
    i = 0
    n = len(lines)
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
        # Scan forward a few lines for the snippet: the FIRST link line after the
        # heading whose anchor text is prose (not the bare domain / image).
        snippet = ""
        j = i + 1
        scanned = 0
        while j < n and scanned < 8:
            stripped = lines[j].strip()
            if _HEADING.match(stripped):
                break  # next result; no snippet found
            lm = _LINK_LINE.match(stripped)
            if lm:
                text = lm.group("text").replace("**", "").strip()
                # Skip the bare-domain line (e.g. "en.wikipedia.org/wiki/X") and
                # empty/image anchors; take the first real prose snippet.
                if text and not text.startswith("!") and " " in text and len(text) > 25:
                    snippet = text
                    break
            j += 1
            scanned += 1
        results.append(SearchResult(url=url, title=title or url, snippet=snippet or title))
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
    except Exception as e:  # noqa: BLE001 - surface the failure, never mask it
        return f"__UNBROWSE_ERR__ {e}", False


class UnbrowseSearchEngine(AsyncSearchEngine):
    """unbrowse-driven SERP. search() = libcurl-impersonate fetch of the DDG HTML
    endpoint, parsed into ranked {url,title,snippet}."""

    def __init__(self, api_key: str | None = None) -> None:
        # api_key arg accepted for registry symmetry; unbrowse needs no key here.
        self._sem = asyncio.Semaphore(int(os.environ.get("UNBROWSE_SERP_CONCURRENCY", "4")))

    async def _enrich(self, results: list[SearchResult]) -> list[SearchResult]:
        """WAVE-09 lever (two-witness): replace thin DDG snippets with full page
        markdown for the top-k ranked results, so the deep-research agent can grind
        multi-hop chains instead of bailing. OPT-IN (UNBROWSE_ENRICH_TOP_K>0, default
        OFF so concurrent runs are unaffected); bounded by the SERP semaphore; honest
        fallback keeps the original snippet on fetch failure."""
        top_k = int(os.environ.get("UNBROWSE_ENRICH_TOP_K", "0"))
        if top_k <= 0:
            return results
        cap = int(os.environ.get("UNBROWSE_ENRICH_CHARS", "8000"))

        async def _one(r: SearchResult) -> SearchResult:
            if not r.url:
                return r
            async with self._sem:
                body, fok = await _run(["fetch", r.url])
            if fok:
                full = _clean(body).strip()[:cap]
                if full:
                    r.snippet = full
            return r

        head = await asyncio.gather(*[_one(r) for r in results[:top_k]])
        return list(head) + results[top_k:]

    async def __call__(self, query: str, num_results: int) -> list[SearchResult]:
        from urllib.parse import quote_plus
        serp_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
        async with self._sem:
            stdout, ok = await _run(["fetch", serp_url])
        if not ok:
            # Honest empty result on failure — the agent will see no results.
            return []
        md = _clean(stdout)
        results = parse_ddg_markdown(md, num_results)
        return await self._enrich(results)


def build_unbrowse_search_engine(**kwargs) -> "UnbrowseSearchEngine":
    return UnbrowseSearchEngine()


if __name__ == "__main__":
    # Self-test: parse a live SERP and print ranked results.
    import json

    async def _main() -> None:
        eng = UnbrowseSearchEngine()
        res = await eng("who is the ceo of anthropic", num_results=5)
        print(json.dumps([r.model_dump() for r in res], indent=2))

    asyncio.run(_main())
