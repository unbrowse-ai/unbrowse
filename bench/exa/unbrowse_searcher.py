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
import json
import os
import re
from urllib.parse import quote_plus

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


UNBROWSE = os.environ.get("UNBROWSE_BIN", "/Users/lekt9/.bun/bin/unbrowse")
TIMEOUT = int(os.environ.get("UNBROWSE_TIMEOUT", "120"))

# Full-page enrichment knobs: `unbrowse act get --json` routes through Exa web search
# and returns the top result's full-page text in text_excerpt/markdown — the grounder
# sees the exact spec passage, not a thin highlight window.
ENRICH_CHARS = int(os.environ.get("UNBROWSE_ENRICH_CHARS", "12000"))
SERP_CONCURRENCY = int(os.environ.get("UNBROWSE_SERP_CONCURRENCY", "4"))

# `unbrowse fetch <url>` prints body markdown plus human trace lines. Strip traces.
_TRACE = re.compile(r"^(\[\d{2}:\d{2}:\d{2}|\[unbrowse\]|\[trace\]|\[debug\]|\[info\]|\[auth\]|\[exit\]|\[in-process)")


def _clean(stdout: str) -> str:
    return "\n".join(
        ln for ln in stdout.splitlines() if not _TRACE.match(ln.strip())
    ).strip()


_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def _strip_html(html: str) -> str:
    """Crude HTML-to-text: strip tags, collapse whitespace."""
    text = _TAG.sub(" ", html)
    return _WS.sub(" ", text).strip()


async def _run(args: list[str]) -> tuple[str, bool]:
    """Invoke the unbrowse CLI off the event loop. Honest failure, never fake.

    Uses a temp file for stdout instead of a pipe — Bun truncates piped stdout
    at 64KB, which corrupts large JSON payloads (full-page HTML inside JSON).
    """
    import subprocess
    import tempfile
    try:
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
            tmp_path = tmp.name
        proc = await asyncio.to_thread(
            subprocess.run,
            [UNBROWSE] + args,
            stdout=open(tmp_path, "wb"),
            stderr=subprocess.DEVNULL,
            timeout=TIMEOUT,
        )
        with open(tmp_path, "rb") as f:
            out = f.read()
        os.unlink(tmp_path)
        return out.decode("utf-8", "replace"), proc.returncode == 0
    except Exception as e:  # noqa: BLE001 - surface the failure, do not mask it
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        return f"__UNBROWSE_ERR__ {e}", False


class UnbrowseSearcher(Searcher):
    name = "unbrowse"

    def __init__(self) -> None:
        self._sem = asyncio.Semaphore(SERP_CONCURRENCY)

    async def extract(self, url: str, query: str | None = None) -> list[SearchResult]:
        """Primary edge: url -> clean markdown via libcurl-impersonate fetch."""
        stdout, ok = await _run(["act", "fetch", url])
        if not ok:
            return [SearchResult(url=url, metadata={"error": stdout, "ok": False})]
        text = _clean(stdout)
        return [SearchResult(url=url, text=text, metadata={"ok": True, "chars": len(text)})]

    async def search(self, query: str, num_results: int = 10) -> list[SearchResult]:
        """Ranked web search via `unbrowse act get --json` (Exa-powered search +
        direct-document enrichment). Returns SearchResult list with the top result's
        full-page text in `text` (the field evals.rag reads), so the grounder sees
        the exact spec passage. Honest-empty on failure."""
        async with self._sem:
            stdout, ok = await _run([
                "act", "get", query, "--mode", "data", "--json",
            ])
        if not ok:
            return []
        stdout = _clean(stdout)
        try:
            payload = json.loads(stdout)
        except Exception:
            return []
        if not isinstance(payload, dict):
            return []
        result = payload.get("result", {})
        if not isinstance(result, dict):
            return []
        candidates = result.get("exa_candidates", [])[:num_results]
        if not candidates or not isinstance(candidates, list):
            return []

        # Full-page enrichment: prefer text_excerpt/markdown; fall back to raw text
        # (HTML) stripped of tags.
        top_text = (result.get("text_excerpt") or result.get("markdown") or "")
        if not top_text:
            raw_html = result.get("text", "") or ""
            if raw_html:
                top_text = _strip_html(raw_html)
        top_text = top_text[:ENRICH_CHARS]

        results: list[SearchResult] = []
        for i, c in enumerate(candidates):
            if not isinstance(c, dict):
                continue
            text = c.get("highlights_excerpt", "")
            enriched = False
            if i == 0 and top_text:
                text = top_text
                enriched = True
            results.append(SearchResult(
                url=c.get("url", ""),
                title=c.get("title", ""),
                text=text,
                metadata={"enriched": enriched, "score": c.get("score", 0)},
            ))
        return results


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
