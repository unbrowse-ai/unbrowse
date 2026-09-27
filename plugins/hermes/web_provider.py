"""Unbrowse as a Hermes web extract backend (``web.extract_backend: unbrowse``): web_extract → unbrowse.scrape.

Search stays with another backend: Unbrowse has no general web search endpoint.
"""

from __future__ import annotations

import concurrent.futures
import json
from typing import Any, Callable, Dict, List

from .client import McpError, UnbrowseMcp

PROVIDER_NAME = "unbrowse"
_FORMATS = {"markdown": "markdown", "html": "html", "text": "text"}


def scrape_to_document(url: str, result: Dict[str, Any], fmt: str = "markdown") -> Dict[str, Any]:
    """Map an ``unbrowse.scrape`` result onto Hermes' extract document shape."""
    data = result.get("structuredContent")
    if not isinstance(data, dict):
        text = "".join(c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict))
        try:
            data = json.loads(text)
        except ValueError:
            data = {"markdown": text}
    if result.get("isError"):
        message = data.get("error") if isinstance(data.get("error"), str) else None
        return _failed(url, message or json.dumps(data)[:500])
    meta = dict(data.get("metadata") or {})
    body = data.get(fmt) or data.get("markdown") or data.get("text") or data.get("html") or ""
    for key in ("finalUrl", "via"):
        if data.get(key):
            meta.setdefault(key, data[key])
    meta.setdefault("sourceURL", url)
    return {"url": url, "title": meta.get("title") or "", "content": body, "raw_content": body, "metadata": meta}


def _failed(url: str, error: str) -> Dict[str, Any]:
    return {"url": url, "title": "", "content": "", "raw_content": "", "error": error}


def extract_urls(client_factory: Callable[[], UnbrowseMcp], urls: List[str], fmt: str | None = None,
                 max_workers: int = 4) -> List[Dict[str, Any]]:
    """Scrape each URL (in parallel, order preserved); per-URL failures carry ``error``."""
    wanted = _FORMATS.get((fmt or "markdown").lower(), "markdown")

    def one(url: str) -> Dict[str, Any]:
        try:
            result = client_factory().call_tool("unbrowse.scrape", {"url": url, "formats": [wanted]})
            return scrape_to_document(url, result, wanted)
        except McpError as exc:
            return _failed(url, f"Unbrowse: {exc.message} ({exc.code})")
        except Exception as exc:  # noqa: BLE001 — per-URL failure, never raise
            return _failed(url, f"Unbrowse: {type(exc).__name__}: {exc}")

    if len(urls) <= 1:
        return [one(u) for u in urls]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers, len(urls))) as pool:
        return list(pool.map(one, urls))


def build_provider(client_factory: Callable[[], UnbrowseMcp], available: Callable[[], bool]):
    """A ``WebSearchProvider`` instance, or ``None`` when this Hermes has no web provider ABC."""
    try:
        from agent.web_search_provider import WebSearchProvider
    except Exception:  # noqa: BLE001 — older/stripped Hermes: skip the backend, tools still work
        return None

    class UnbrowseWebProvider(WebSearchProvider):
        @property
        def name(self) -> str:
            return PROVIDER_NAME

        @property
        def display_name(self) -> str:
            return "Unbrowse"

        def is_available(self) -> bool:
            try:
                return bool(available())
            except Exception:  # noqa: BLE001
                return False

        def supports_search(self) -> bool:
            return False

        def supports_extract(self) -> bool:
            return True

        def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
            return extract_urls(client_factory, list(urls), kwargs.get("format"))

        def get_setup_schema(self) -> Dict[str, Any]:
            return {
                "name": "Unbrowse",
                "badge": "paid",
                "tag": "Page extraction through Unbrowse's hosted API (HTTP first, cloud browser when needed)",
                "env_vars": [{"key": "UNBROWSE_API_KEY", "prompt": "Unbrowse API key",
                              "url": "https://unbrowse.ai"}],
            }

    return UnbrowseWebProvider()
