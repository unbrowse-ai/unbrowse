"""Stdlib client for the hosted Unbrowse remote MCP (JSON-RPC 2.0 over streamable HTTP, stateless).

Mirrors packages/sdk/src/mcp.ts. No third-party dependencies: urllib only.
The API key is sent as a bearer header and never appears in errors, logs or results.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from itertools import count
from typing import Any, Dict, List, Optional

__all__ = [
    "DEFAULT_MCP_URL", "MCP_PROTOCOL_VERSION", "McpError", "UnbrowseMcp", "parse_rpc_body", "result_text",
]

DEFAULT_MCP_URL = "https://unbrowse.ai/mcp"
# Sent as Mcp-Protocol-Version. The hosted server refuses 2025-06-18 on its streaming path.
MCP_PROTOCOL_VERSION = "2025-11-25"
VERSION = "0.1.0"


class McpError(Exception):
    """A failed MCP call. ``code`` is the server's ``error.data.code`` (e.g. ``browser_capacity``)
    when it sent one, else ``rpc_<n>`` / ``http_error`` / ``network_error`` / ``mcp_empty``."""

    def __init__(self, message: str, status: int = 0, code: str = "mcp_error", data: Any = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.data = data

    def to_dict(self) -> Dict[str, Any]:
        return {"message": self.message, "code": self.code, "status": self.status}


def parse_rpc_body(text: str) -> Dict[str, Any]:
    """The JSON-RPC message in a response body: plain JSON, or the last ``data:`` event of an SSE stream."""
    trimmed = (text or "").strip()
    if trimmed.startswith("{"):
        return json.loads(trimmed)
    events: List[str] = []
    for block in trimmed.replace("\r\n", "\n").split("\n\n"):
        lines = [line[5:].lstrip() for line in block.split("\n") if line.startswith("data:")]
        data = "\n".join(lines)
        if data:
            events.append(data)
    if not events:
        raise McpError("Empty MCP response", 502, "mcp_empty")
    return json.loads(events[-1])


def result_text(result: Dict[str, Any]) -> str:
    """Plain text of a tool result: its text parts, else its structured content as JSON."""
    parts = [c.get("text") for c in (result.get("content") or [])
             if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str)]
    text = "\n".join(parts)
    if text:
        return text
    structured = result.get("structuredContent")
    return "" if structured is None else json.dumps(structured, ensure_ascii=False)


class UnbrowseMcp:
    """One hosted MCP endpoint. Thread-safe: every call is an independent HTTP POST."""

    def __init__(
        self, api_key: Optional[str] = None, url: Optional[str] = None, end_user: Optional[str] = None,
        timeout: float = 180.0, client: str = "hermes",
    ):
        self.url = (url or os.environ.get("UNBROWSE_MCP_URL") or DEFAULT_MCP_URL).rstrip("/")
        self._api_key = api_key if api_key is not None else (os.environ.get("UNBROWSE_API_KEY") or None)
        self._end_user = end_user if end_user is not None else (os.environ.get("UNBROWSE_END_USER") or None)
        self.timeout = timeout
        self._client = client
        self._ids = count(1)

    def __repr__(self) -> str:  # never render the key
        return f"UnbrowseMcp(url={self.url!r}, authenticated={bool(self._api_key)})"

    def _headers(self) -> Dict[str, str]:
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            "user-agent": f"unbrowse-{self._client}/{VERSION}",
        }
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        if self._end_user:
            headers["x-unbrowse-end-user"] = self._end_user
        return headers

    def rpc(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """One JSON-RPC call. Errors raise :class:`McpError` carrying the server's ``data.code``."""
        payload: Dict[str, Any] = {"jsonrpc": "2.0", "id": next(self._ids), "method": method}
        if params is not None:
            payload["params"] = params
        req = urllib.request.Request(self.url, data=json.dumps(payload).encode("utf-8"),
                                     headers=self._headers(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                text = res.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            raise _http_error(exc) from None
        except urllib.error.URLError as exc:
            raise McpError(f"Could not reach Unbrowse MCP at {self.url}: {exc.reason}", 0, "network_error") from None
        except TimeoutError:
            raise McpError(f"Unbrowse MCP timed out after {self.timeout:.0f}s", 0, "timeout") from None
        except OSError as exc:
            raise McpError(f"Unbrowse MCP request failed: {exc}", 0, "network_error") from None
        try:
            msg = parse_rpc_body(text)
        except ValueError:
            raise McpError("Unbrowse MCP returned a body that is not JSON-RPC", 502, "mcp_bad_body") from None
        err = msg.get("error")
        if err:
            data = err.get("data") if isinstance(err.get("data"), dict) else {}
            code = data.get("code") or f"rpc_{err.get('code')}"
            raise McpError(str(err.get("message") or "MCP error"), 200, str(code), err)
        return msg.get("result")

    def list_tools(self) -> List[Dict[str, Any]]:
        """Every tool this key can call: the core tools plus the workspace's learned and indexed ones."""
        tools: List[Dict[str, Any]] = []
        cursor: Optional[str] = None
        seen = set()
        while True:
            page = self.rpc("tools/list", {"cursor": cursor} if cursor else None) or {}
            tools.extend(page.get("tools") or [])
            cursor = page.get("nextCursor")
            if not cursor or cursor in seen:
                return tools
            seen.add(cursor)

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """``tools/call`` → ``{content: [...], structuredContent?, isError?}``."""
        return self.rpc("tools/call", {"name": name, "arguments": arguments or {}}) or {}


def _http_error(exc: urllib.error.HTTPError) -> McpError:
    try:
        text = exc.read().decode("utf-8", "replace")
    except Exception:
        text = ""
    body: Dict[str, Any] = {}
    try:
        parsed = json.loads(text)
        body = parsed if isinstance(parsed, dict) else {}
    except ValueError:
        pass
    # A JSON-RPC error body on a non-2xx status still carries data.code.
    if isinstance(body.get("error"), dict) and ("jsonrpc" in body or "data" in body["error"]):
        err = body["error"]
        data = err.get("data") if isinstance(err.get("data"), dict) else {}
        return McpError(str(err.get("message") or f"HTTP {exc.code}"), exc.code,
                        str(data.get("code") or err.get("code") or "http_error"), err)
    err = body.get("error")
    if isinstance(err, dict):
        return McpError(str(err.get("message") or f"HTTP {exc.code}"), exc.code, str(err.get("code") or "http_error"), body)
    message = body.get("error_description") or (err if isinstance(err, str) else None) or exc.reason or f"HTTP {exc.code}"
    code = err if isinstance(err, str) else ("unauthorized" if exc.code == 401 else "http_error")
    return McpError(str(message), exc.code, str(code), body or None)
