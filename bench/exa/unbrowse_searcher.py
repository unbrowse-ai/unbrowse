#!/usr/bin/env python3
"""unbrowse_searcher.py — unbrowse as a REAL github:exa-labs/benchmarks Searcher.

WAVE-02 correction (2026-05-29): the prior `searcher_unbrowse.py` targeted a TOY
interface (`extract(url) -> str`, sync). The REAL exa-labs ABC, verified by
reading the cloned repo at shared/shared/searchers/base.py, is async and returns
`SearchResult` dataclasses:

    class Searcher(ABC):
        name: str
        async def search(self, query, num_results=10) -> list[SearchResult]
        async def extract(self, url, query=None) -> list[SearchResult]

    @dataclass SearchResult: url, title, text, highlights, metadata

Drop this file into `shared/shared/searchers/unbrowse.py`, register it in the
benchmark's SEARCHER_BUILDERS, and run e.g.:

    python -m evals.rag        --searchers unbrowse --limit 20   # beat groundedness 79.4
    python -m evals.highlights --searchers unbrowse --limit 20   # beat 94.8 / 93.2

REPRODUCIBLE TARGETS ONLY (see bench/exa/WAVE-02.md): RAG and Highlights ship
expected answers in data/. WebCode *Contents* is NOT reproducible — its golden
markdown is licensing-excluded — so do NOT chase the published 82.8 there.

unbrowse's real edge is multi-layer EXTRACTION (network + SSR JSON + JS heap +
DOM via libcurl-impersonate), which feeds Highlights (extract) and the contents
half of RAG. `search()` is wired but HONESTLY flagged: unbrowse resolves
intents -> APIs, it is not yet a ranked-URL SERP engine, so a People/Company-style
SERP win must NOT be reported until search() is a real ranker (fabricated green).
"""
from __future__ import annotations

import asyncio
import os
import re

try:
    # Drop-in mode: real exa-labs base classes.
    from .base import Searcher, SearchResult  # type: ignore
except Exception:  # pragma: no cover - standalone/import-time fallback
    from abc import ABC
    from dataclasses import dataclass, field
    from typing import Any

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

# `unbrowse fetch <url>` SIMPLE mode prints body-only markdown, but the binary
# also emits human trace lines. Strip them so extraction text is clean.
_TRACE = re.compile(r"^(\[\d{2}:\d{2}:\d{2}|\[unbrowse\]|\[trace\]|\[debug\]|\[info\])")


def _clean(stdout: str) -> str:
    return "\n".join(
        ln for ln in stdout.splitlines() if not _TRACE.match(ln.strip())
    ).strip()


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

    async def extract(self, url: str, query: str | None = None) -> list[SearchResult]:
        """Primary edge: url -> clean markdown via libcurl-impersonate fetch."""
        stdout, ok = await _run(["fetch", url])
        if not ok:
            return [SearchResult(url=url, metadata={"error": stdout, "ok": False})]
        text = _clean(stdout)
        return [SearchResult(url=url, text=text, metadata={"ok": True, "chars": len(text)})]

    async def search(self, query: str, num_results: int = 10) -> list[SearchResult]:
        """HONEST: intent->endpoint resolution, NOT a ranked SERP. Flagged in metadata
        so the harness/agent never mistakes this for a SERP-ranking win."""
        stdout, ok = await _run(["resolve", "--intent", query, "--no-execute"])
        text = _clean(stdout)
        return [SearchResult(
            url="",
            title=f"unbrowse resolve: {query}",
            text=text if ok else "",
            metadata={"ok": ok, "is_serp_ranker": False, "raw": stdout[:2000]},
        )]


def build_unbrowse_searcher() -> "UnbrowseSearcher":
    return UnbrowseSearcher()
