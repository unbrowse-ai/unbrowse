"""Minimal client for the hosted Unbrowse MCP endpoint (JSON-RPC 2.0 over plain HTTP, one POST per call).

Standard library only. The API key is sent as a bearer header and never appears in errors or results.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from itertools import count
from typing import Any

DEFAULT_URL = "https://unbrowse.ai/api/mcp"
KEY_HELP = "Set UNBROWSE_API_KEY or pass api_key. Create a key at https://unbrowse.ai/app (free tier)."
_ids = count(1)


class UnbrowseError(Exception):
    """A failed Unbrowse call, with a message safe to show to a user or a model."""


class UnbrowseClient:
    """Calls Unbrowse tools (`unbrowse.scrape`, `unbrowse.discover`, `unbrowse.run`, ...) over HTTP."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        url: str | None = None,
        user_agent: str = "unbrowse-python",
    ) -> None:
        key = (api_key or os.environ.get("UNBROWSE_API_KEY") or "").strip()
        if not key:
            raise UnbrowseError(f"Missing Unbrowse API key. {KEY_HELP}")
        self._api_key = key
        self.url = url or os.environ.get("UNBROWSE_MCP_URL") or DEFAULT_URL
        self.user_agent = user_agent

    def __repr__(self) -> str:
        return f"UnbrowseClient(url={self.url!r})"

    def _post(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": self.user_agent,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            message = _error_message(body) or f"HTTP {err.code}"
            if err.code == 401:
                raise UnbrowseError(f"Unbrowse rejected the API key: {message}. {KEY_HELP}") from None
            raise UnbrowseError(f"Unbrowse request failed ({err.code}): {message}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            reason = getattr(err, "reason", err)
            raise UnbrowseError(f"Could not reach Unbrowse: {reason}") from None
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise UnbrowseError("Unbrowse returned a response that is not JSON") from None
        if not isinstance(data, dict):
            raise UnbrowseError("Unbrowse returned an unexpected response")
        return data

    def rpc(self, method: str, params: dict[str, Any] | None = None, timeout: float = 60) -> Any:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": next(_ids), "method": method}
        if params is not None:
            payload["params"] = params
        data = self._post(payload, timeout)
        error = data.get("error")
        if error:
            message = error.get("message") if isinstance(error, dict) else str(error)
            raise UnbrowseError(f"Unbrowse error: {message}")
        return data.get("result")

    def call_tool(self, name: str, arguments: dict[str, Any], timeout: float = 120) -> Any:
        """tools/call: the tool's result, decoded from JSON when the text part is JSON."""
        result = self.rpc("tools/call", {"name": name, "arguments": arguments}, timeout) or {}
        texts = [
            part.get("text")
            for part in result.get("content") or []
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
        ]
        text = "\n".join(texts)
        if result.get("isError"):
            raise UnbrowseError(f"Unbrowse error: {text or 'tool call failed'}")
        if not texts:
            structured = result.get("structuredContent")
            if structured is not None:
                return structured
            raise UnbrowseError("Unbrowse returned an empty result")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def scrape(
        self,
        url: str,
        *,
        only_main_content: bool | None = None,
        render: str | None = None,
        timeout: float = 120,
    ) -> dict[str, Any]:
        url = (url or "").strip()
        if not url.startswith(("http://", "https://")):
            raise UnbrowseError("url must be an http:// or https:// address")
        arguments: dict[str, Any] = {"url": url, "formats": ["markdown", "links"]}
        if only_main_content is not None:
            arguments["onlyMainContent"] = bool(only_main_content)
        if render is not None:
            if render not in ("auto", "always", "never"):
                raise UnbrowseError("render must be auto, always or never")
            arguments["render"] = render
        page = self.call_tool("unbrowse.scrape", arguments, timeout=timeout)
        return page if isinstance(page, dict) else {"url": url, "markdown": str(page)}

    def discover(self, query: str, *, timeout: float = 60) -> Any:
        query = (query or "").strip()
        if not query:
            raise UnbrowseError("query is required")
        return self.call_tool("unbrowse.discover", {"query": query}, timeout=timeout)

    def run(
        self,
        task: str | None = None,
        *,
        capability: str | None = None,
        input: dict[str, Any] | None = None,
        timeout: float = 240,
    ) -> dict[str, Any]:
        task = (task or "").strip()
        capability = (capability or "").strip()
        if not task and not capability:
            raise UnbrowseError("Give a task (plain language) or a capability id from discover")
        arguments: dict[str, Any] = {}
        if task:
            arguments["task"] = task
        if capability:
            arguments["capability"] = capability
        if input:
            if not isinstance(input, dict):
                raise UnbrowseError("input must be an object keyed by the capability's input names")
            arguments["input"] = input
        run = self.call_tool("unbrowse.run", arguments, timeout=timeout)
        return run if isinstance(run, dict) else {"status": "succeeded", "result": run}


def _error_message(body: str) -> str:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body.strip()[:300]
    if not isinstance(data, dict):
        return str(data)[:300]
    error = data.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or "")
    return str(data.get("error_description") or error or "")
