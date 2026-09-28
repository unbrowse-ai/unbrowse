"""Minimal client for the hosted Unbrowse MCP endpoint (JSON-RPC 2.0 over plain HTTP, one POST per call).

Standard library only. The API key is sent as a bearer header and never appears in errors or results.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from itertools import count
from typing import Any

MCP_URL = "https://unbrowse.ai/api/mcp"
USER_AGENT = "unbrowse-dify-plugin/0.1.0"
_ids = count(1)


class UnbrowseError(Exception):
    """A failed Unbrowse call, with a message safe to show to the user."""


def _post(api_key: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        MCP_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        message = _error_message(body) or f"HTTP {err.code}"
        if err.code == 401:
            raise UnbrowseError(f"Unbrowse rejected the API key: {message}") from None
        raise UnbrowseError(f"Unbrowse request failed ({err.code}): {message}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        reason = getattr(err, "reason", err)
        raise UnbrowseError(f"Could not reach Unbrowse: {reason}") from None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise UnbrowseError("Unbrowse returned a response that is not JSON") from None


def _error_message(body: str) -> str:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body.strip()[:300]
    error = data.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or "")
    return str(data.get("error_description") or error or "")


def _rpc(api_key: str, method: str, params: dict[str, Any] | None, timeout: float) -> Any:
    if not api_key or not api_key.strip():
        raise UnbrowseError("Missing Unbrowse API key. Create one at https://unbrowse.ai/app")
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": next(_ids), "method": method}
    if params is not None:
        payload["params"] = params
    data = _post(api_key.strip(), payload, timeout)
    error = data.get("error")
    if error:
        message = error.get("message") if isinstance(error, dict) else str(error)
        raise UnbrowseError(f"Unbrowse error: {message}")
    return data.get("result")


def list_tools(api_key: str, timeout: float = 30) -> list[dict[str, Any]]:
    """tools/list: a cheap authenticated call, used to validate the API key."""
    result = _rpc(api_key, "tools/list", None, timeout) or {}
    return list(result.get("tools") or [])


def call_tool(api_key: str, name: str, arguments: dict[str, Any], timeout: float = 120) -> Any:
    """tools/call: returns the tool's result, decoded from JSON when the text part is JSON."""
    result = _rpc(api_key, "tools/call", {"name": name, "arguments": arguments}, timeout) or {}
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
