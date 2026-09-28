"""Unit tests (mocked HTTP) and, with UNBROWSE_LIVE=1 and UNBROWSE_API_KEY set, live calls to the hosted API."""

from __future__ import annotations

import io
import json
import os
import urllib.error

import langchain_unbrowse._client as client_mod
import pytest
from langchain_core.tools import ToolException
from langchain_unbrowse import (
    UnbrowseClient,
    UnbrowseDiscoverTool,
    UnbrowseError,
    UnbrowseRunTool,
    UnbrowseScrapeTool,
    UnbrowseToolkit,
)

LIVE = os.environ.get("UNBROWSE_LIVE") == "1" and bool(os.environ.get("UNBROWSE_API_KEY"))
KEY = "ub_test_key"


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def http(monkeypatch):
    calls: list[dict] = []
    replies: list = []

    def urlopen(request, timeout=None):
        calls.append(
            {
                "url": request.full_url,
                "headers": {k.lower(): v for k, v in request.header_items()},
                "body": json.loads(request.data),
                "timeout": timeout,
            }
        )
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return FakeResponse(json.dumps(reply).encode())

    monkeypatch.setattr(client_mod.urllib.request, "urlopen", urlopen)
    return calls, replies


def text_result(payload):
    return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}


def http_error(code, body):
    return urllib.error.HTTPError("https://unbrowse.ai/api/mcp", code, "err", {}, io.BytesIO(json.dumps(body).encode()))


PAGE = {
    "url": "https://example.com",
    "finalUrl": "https://example.com/",
    "metadata": {"title": "Example Domain"},
    "markdown": "# Example Domain\n\nThis domain is for use in examples.",
    "links": ["https://iana.org/domains/example"],
}


def test_scrape_sends_jsonrpc_and_returns_markdown(http):
    calls, replies = http
    replies.append(text_result(PAGE))
    out = UnbrowseScrapeTool(api_key=KEY).invoke({"url": "https://example.com"})
    assert out.startswith("Title: Example Domain\nURL: https://example.com/\n\n# Example Domain")
    call = calls[0]
    assert call["url"] == "https://unbrowse.ai/api/mcp"
    assert call["headers"]["authorization"] == f"Bearer {KEY}"
    assert call["headers"]["accept"] == "application/json"
    assert call["headers"]["user-agent"].startswith("langchain-unbrowse/")
    assert call["body"]["jsonrpc"] == "2.0"
    assert call["body"]["method"] == "tools/call"
    assert call["body"]["params"] == {
        "name": "unbrowse.scrape",
        "arguments": {
            "url": "https://example.com",
            "formats": ["markdown", "links"],
            "onlyMainContent": True,
            "render": "auto",
        },
    }


def test_scrape_truncates(http):
    _, replies = http
    replies.append(text_result({**PAGE, "markdown": "x" * 50}))
    out = UnbrowseScrapeTool(api_key=KEY, max_chars=10).invoke({"url": "https://example.com"})
    assert out.endswith("x" * 10 + "\n\n[truncated]")


def test_scrape_rejects_non_http_url_without_network(http):
    calls, _ = http
    out = UnbrowseScrapeTool(api_key=KEY).invoke({"url": "file:///etc/passwd"})
    assert "http:// or https://" in out
    assert calls == []


def test_discover_returns_json(http):
    calls, replies = http
    found = {"capabilities": [{"id": "cap_hn_front", "inputs": []}]}
    replies.append(text_result(found))
    out = UnbrowseDiscoverTool(api_key=KEY).invoke({"query": "hacker news front page"})
    assert json.loads(out) == found
    assert calls[0]["body"]["params"] == {"name": "unbrowse.discover", "arguments": {"query": "hacker news front page"}}


def test_run_by_capability_with_input(http):
    calls, replies = http
    replies.append(text_result({"status": "succeeded", "result": {"items": [1, 2]}}))
    out = UnbrowseRunTool(api_key=KEY).invoke({"capability": "cap_x", "input": {"q": "laptops"}})
    assert json.loads(out)["status"] == "succeeded"
    assert calls[0]["body"]["params"]["arguments"] == {"capability": "cap_x", "input": {"q": "laptops"}}
    assert calls[0]["timeout"] == 240


def test_run_input_required_is_not_an_error(http):
    _, replies = http
    replies.append(text_result({"status": "input_required", "missing": ["date"]}))
    out = json.loads(UnbrowseRunTool(api_key=KEY).invoke({"task": "book a court"}))
    assert out == {"status": "input_required", "missing": ["date"]}


def test_run_needs_task_or_capability(http):
    calls, _ = http
    out = UnbrowseRunTool(api_key=KEY).invoke({})
    assert "task" in out and "capability" in out
    assert calls == []


def test_jsonrpc_error_becomes_tool_message(http):
    _, replies = http
    replies.append({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "credits exhausted"}})
    out = UnbrowseDiscoverTool(api_key=KEY).invoke({"query": "x"})
    assert out == "Unbrowse error: credits exhausted"


def test_is_error_result(http):
    _, replies = http
    replies.append(
        {"jsonrpc": "2.0", "id": 1, "result": {"isError": True, "content": [{"type": "text", "text": "blocked"}]}}
    )
    assert UnbrowseDiscoverTool(api_key=KEY).invoke({"query": "x"}) == "Unbrowse error: blocked"


def test_401_does_not_leak_key(http):
    _, replies = http
    replies.append(http_error(401, {"error": {"message": "invalid api key"}}))
    out = UnbrowseScrapeTool(api_key=KEY).invoke({"url": "https://example.com"})
    assert "rejected the API key" in out
    assert KEY not in out


def test_errors_raise_when_handling_disabled(http):
    _, replies = http
    replies.append(http_error(500, {"error": {"message": "boom"}}))
    tool = UnbrowseScrapeTool(api_key=KEY, handle_tool_error=False)
    with pytest.raises(ToolException, match="500"):
        tool.invoke({"url": "https://example.com"})


def test_missing_key(monkeypatch, http):
    monkeypatch.delenv("UNBROWSE_API_KEY", raising=False)
    out = UnbrowseScrapeTool().invoke({"url": "https://example.com"})
    assert "Missing Unbrowse API key" in out
    with pytest.raises(UnbrowseError):
        UnbrowseClient()


def test_key_from_env_and_custom_url(monkeypatch, http):
    calls, replies = http
    monkeypatch.setenv("UNBROWSE_API_KEY", "ub_env_key")
    replies.append(text_result(PAGE))
    UnbrowseScrapeTool(url="https://staging.example/api/mcp").invoke({"url": "https://example.com"})
    assert calls[0]["headers"]["authorization"] == "Bearer ub_env_key"
    assert calls[0]["url"] == "https://staging.example/api/mcp"


def test_key_is_not_serialized():
    tool = UnbrowseScrapeTool(api_key=KEY)
    assert KEY not in repr(tool)
    dumped = tool.model_dump(exclude={"args_schema"})
    assert "api_key" not in dumped
    assert KEY not in str(dumped)


def test_toolkit():
    tools = UnbrowseToolkit(api_key=KEY).get_tools()
    assert [t.name for t in tools] == ["unbrowse_scrape", "unbrowse_discover", "unbrowse_run"]
    assert all(t.api_key.get_secret_value() == KEY for t in tools)


def test_tool_call_schema_for_models():
    schema = UnbrowseRunTool(api_key=KEY).tool_call_schema.model_json_schema()
    assert set(schema["properties"]) == {"task", "capability", "input"}


@pytest.mark.skipif(not LIVE, reason="set UNBROWSE_LIVE=1 and UNBROWSE_API_KEY")
def test_live_scrape_and_discover():
    out = UnbrowseScrapeTool(handle_tool_error=False).invoke({"url": "https://example.com"})
    assert "Example Domain" in out
    found = UnbrowseDiscoverTool(handle_tool_error=False).invoke({"query": "hacker news front page"})
    assert found
