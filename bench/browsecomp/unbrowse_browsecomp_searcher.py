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

# Strip unbrowse's + kuri's human log lines so only the JSON/markdown payload
# remains. Kuri emits bare `info:`/`warn:`/`error:` lines (not bracketed), which
# otherwise pollute the resolve JSON and break parsing.
_TRACE = re.compile(
    r"^(\[\d{2}:\d{2}:\d{2}(\.\d+)?\]|\[unbrowse\]|\[trace\]|\[debug\]|\[info\]|\[auth\]"
    r"|info:|warn:|warning:|error:|debug:|\[kuri)"
)

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


def _best_chunk(text: str, query: str, cap: int) -> str:
    """Chunk a fetched page and keep the window most relevant to the query. Splits
    on blank lines into paragraphs, scores each by query-term overlap, and returns
    the highest-scoring contiguous run up to `cap` chars (lead content when the
    query gives no signal). 'Per link or chunk, whatever makes sense' — return the
    chunk the agent actually needs, not the whole DOM."""
    text = text.strip()
    if len(text) <= cap:
        return text[:cap]
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paras:
        return text[:cap]
    terms = {t for t in re.findall(r"[a-z0-9]+", query.lower()) if len(t) > 2}
    if not terms:
        return text[:cap]  # no query signal -> lead content
    def _score(p: str) -> int:
        pl = p.lower()
        return sum(pl.count(t) for t in terms)
    best_i = max(range(len(paras)), key=lambda i: _score(paras[i]))
    out, total, i = [], 0, best_i
    while i < len(paras) and total < cap:
        out.append(paras[i]); total += len(paras[i]) + 2; i += 1
    return "\n\n".join(out)[:cap]


class UnbrowseSearchEngine(AsyncSearchEngine):
    """unbrowse-driven search. PRIMARY: route the intent through Exa
    (`unbrowse search` -> exa-web-search -> ranked per-link candidates), then run
    each link through our per-link fetch+chunk (libcurl-impersonate). DDG SERP is
    the last-resort fallback. Returns ranked {url,title,snippet=chunk}."""

    def __init__(self, api_key: str | None = None) -> None:
        # api_key arg accepted for registry symmetry; unbrowse needs no key here.
        self._sem = asyncio.Semaphore(int(os.environ.get("UNBROWSE_SERP_CONCURRENCY", "4")))

    async def _enrich(self, results: list[SearchResult], query: str = "") -> list[SearchResult]:
        """Route Exa's per-link candidates THROUGH our search: for the top-k ranked
        links, `unbrowse fetch` the page (libcurl-impersonate, JA4-faithful) and
        replace the thin snippet with the query-relevant CHUNK of the full content,
        so the deep-research agent grinds multi-hop chains on real per-link data
        instead of bailing on a one-line SERP snippet. Default ON (top-k=5); set
        UNBROWSE_ENRICH_TOP_K=0 to disable. Bounded by the SERP semaphore; honest
        fallback keeps the original snippet on fetch failure."""
        top_k = int(os.environ.get("UNBROWSE_ENRICH_TOP_K", "5"))
        if top_k <= 0:
            return results
        cap = int(os.environ.get("UNBROWSE_ENRICH_CHARS", "8000"))

        async def _one(r: SearchResult) -> SearchResult:
            if not r.url:
                return r
            async with self._sem:
                body, fok = await _run(["fetch", r.url])
            if fok:
                full = _clean(body).strip()
                # Chunk the fetched page to the window most relevant to the query
                # (per link or chunk, whatever makes sense), not the whole DOM.
                chunk = _best_chunk(full, query, cap) if full else ""
                # Reject soft-failure bodies (CLI exits 0 but content is a junk
                # sentinel/error page): only replace if the chunk is richer than
                # the original snippet. Keeps the thin snippet on failure.
                if chunk and chunk.lower() != "null" and len(chunk) > len(r.snippet):
                    r.snippet = chunk
            return r  # MUST return r — gather of None-returning coros yields a list
                      # of Nones, and the eval framework then crashes on r.title
                      # ('NoneType' object has no attribute 'title'), starving the
                      # agent of every result (the real cause of the 0.0 runs).

        head = await asyncio.gather(*[_one(r) for r in results[:top_k]])
        return list(head) + results[top_k:]

    async def _resolve_search(self, query: str, num_results: int) -> list["SearchResult"]:
        """PRIMARY path: `unbrowse search` — the unified-discovery command whose
        FREE best-effort web enrichment routes the intent to the synthetic
        exa-web-search skill and returns ranked neural-search candidates
        (result.exa_candidates: {url,title,score,highlights_excerpt}) plus a
        synthesized answer (result.exa_answer / data / source_url). This is "solve
        via unbrowse" by walking the endpoint trees, not scraping the human SERP.

        NB (d113): the earlier 0.0 browsecomp runs called `resolve`, which does
        API-DISCOVERY (marketplace skill match) and returns 0 viable candidates for
        generic web-research intents — starving the agent. `search` is the command
        that actually performs the free Exa web search (verified live: "...first
        clamshell handheld" → wikipedia/Game_Boy_Advance_SP + 5 candidates, no
        payment), so the agent now gets real ranked sources every query."""
        import json as _json
        # `search` deterministically fires the free Exa web-enrichment path; retry
        # once for transient marketplace timeouts that can precede the exa result.
        cands: list = []
        last_result: dict = {}
        _dec = _json.JSONDecoder()
        # WARM path: when WARM_SEARCH_URL is set, POST the intent to the persistent
        # in-process server (built once, no per-call cold-boot) — the unblock that
        # lets a strong agent run the full eval without the binary wedging.
        warm = os.environ.get("WARM_SEARCH_URL", "").rstrip("/")
        for _attempt in range(2):
            if warm:
                try:
                    import urllib.request as _u
                    req = _u.Request(f"{warm}/v1/intent/resolve",
                                     data=_json.dumps({"intent": query}).encode(),
                                     headers={"content-type": "application/json"})
                    loop = asyncio.get_event_loop()
                    body = await loop.run_in_executor(None, lambda: _u.urlopen(req, timeout=90).read().decode())
                    d = _json.loads(body)
                except Exception:
                    continue
            else:
                async with self._sem:
                    out, ok = await _run(["search", "--intent", query, "--pretty"])
                if not ok:
                    continue
                clean = _clean(out)
                start = clean.find("{")
                if start < 0:
                    continue
                try:
                    d, _end = _dec.raw_decode(clean[start:])
                except Exception:
                    continue
            last_result = d.get("result") or last_result
            cands = (last_result).get("exa_candidates") or []
            if cands:
                break
        results: list[SearchResult] = []
        for c in cands[:num_results]:
            url = c.get("url") or ""
            if not url:
                continue
            title = (c.get("title") or url).strip()
            snippet = (c.get("highlights_excerpt") or c.get("snippet") or title).strip()
            results.append(SearchResult(url=url, title=title, snippet=snippet))
        # exa_answer fallback: resolve often returns a SYNTHESIZED answer + its
        # source (exa_answer / data / source_url) instead of a ranked candidate
        # list — a high-quality direct hit (e.g. the Wikipedia page for the
        # entity, "Sam Altman ... CEO of OpenAI since 2019"). The adapter used to
        # discard it (only read exa_candidates) and drop to the DDG SERP scrape,
        # starving the agent of the best result. Surface it as a SearchResult.
        if not results and last_result.get("source_url"):
            url = (last_result.get("source_url") or "").strip()
            title = (last_result.get("source_title") or url).strip()
            data = last_result.get("data")
            if isinstance(data, list):
                snippet = " ".join(str(x) for x in data if x).strip()
            elif isinstance(data, str):
                snippet = data.strip()
            else:
                snippet = ""
            if url:
                results.append(SearchResult(url=url, title=title, snippet=(snippet or title)[:4000]))
        return results

    async def __call__(self, query: str, num_results: int) -> list[SearchResult]:
        # 1) route-graph path: resolve → first-party search API (exa-web-search),
        #    then run each ranked link through our per-link fetch+chunk.
        results = await self._resolve_search(query, num_results)
        if results:
            return await self._enrich(results, query)
        # 2) last-resort fallback: DDG SERP scrape (the human surface).
        from urllib.parse import quote_plus
        serp_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
        async with self._sem:
            stdout, ok = await _run(["fetch", serp_url])
        if not ok:
            return []
        md = _clean(stdout)
        results = parse_ddg_markdown(md, num_results)
        return await self._enrich(results, query)


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
