"""Unit tests (mocked HTTP) and, with UNBROWSE_LIVE=1 and UNBROWSE_API_KEY set, live calls to the hosted API."""

from __future__ import annotations

import io
import json
import os
import urllib.error

import llama_index.tools.unbrowse._client as client_mod
import pytest
from llama_index.core.tools.tool_spec.base import BaseToolSpec
from llama_index.tools.unbrowse import UnbrowseError, UnbrowseToolSpec

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


PAGE = {
    "url": "https://example.com",
    "finalUrl": "https://example.com/",
    "metadata": {"title": "Example Domain"},
    "markdown": "# Example Domain\n\nThis domain is for use in examples.",
}


def test_class():
    assert BaseToolSpec.__name__ in [b.__name__ for b in UnbrowseToolSpec.__mro__]


def test_tool_list_names_and_schemas():
    tools = UnbrowseToolSpec(api_key=KEY).to_tool_list()
    assert [t.metadata.name for t in tools] == ["unbrowse_scrape", "unbrowse_discover", "unbrowse_run"]
    run_schema = tools[2].metadata.get_parameters_dict()
    assert set(run_schema["properties"]) == {"task", "capability", "input"}
    assert tools[0].metadata.get_parameters_dict()["required"] == ["url"]


def test_scrape(http):
    calls, replies = http
    replies.append(text_result(PAGE))
    out = UnbrowseToolSpec(api_key=KEY).unbrowse_scrape("https://example.com")
    assert out.startswith("Title: Example Domain\nURL: https://example.com/\n\n# Example Domain")
    call = calls[0]
    assert call["url"] == "https://unbrowse.ai/api/mcp"
    assert call["headers"]["authorization"] == f"Bearer {KEY}"
    assert call["headers"]["user-agent"].startswith("llama-index-tools-unbrowse/")
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


def test_scrape_via_function_tool(http):
    _, replies = http
    replies.append(text_result(PAGE))
    tool = UnbrowseToolSpec(api_key=KEY, max_chars=5).to_tool_list()[0]
    out = tool.call(url="https://example.com")
    assert "[truncated]" in out.content
    assert not out.is_error


def test_discover(http):
    calls, replies = http
    found = {"capabilities": [{"id": "cap_hn_front"}]}
    replies.append(text_result(found))
    assert json.loads(UnbrowseToolSpec(api_key=KEY).unbrowse_discover("hacker news")) == found
    assert calls[0]["body"]["params"] == {"name": "unbrowse.discover", "arguments": {"query": "hacker news"}}


def test_run(http):
    calls, replies = http
    replies.append(text_result({"status": "input_required", "missing": ["date"]}))
    out = UnbrowseToolSpec(api_key=KEY).unbrowse_run(capability="cap_x", input={"q": "laptops"})
    assert json.loads(out)["status"] == "input_required"
    assert calls[0]["body"]["params"]["arguments"] == {"capability": "cap_x", "input": {"q": "laptops"}}
    assert calls[0]["timeout"] == 240


def test_run_needs_task_or_capability(http):
    calls, _ = http
    out = UnbrowseToolSpec(api_key=KEY).unbrowse_run()
    assert out.startswith("Error:")
    assert calls == []


def test_errors_are_returned_or_raised(http):
    _, replies = http
    body = json.dumps({"error": {"message": "invalid api key"}}).encode()
    replies.append(urllib.error.HTTPError("u", 401, "x", {}, io.BytesIO(body)))
    out = UnbrowseToolSpec(api_key=KEY).unbrowse_scrape("https://example.com")
    assert "rejected the API key" in out and KEY not in out
    replies.append({"jsonrpc": "2.0", "id": 1, "error": {"message": "credits exhausted"}})
    with pytest.raises(UnbrowseError, match="credits exhausted"):
        UnbrowseToolSpec(api_key=KEY, raise_errors=True).unbrowse_discover("x")


def test_non_http_url_rejected_without_network(http):
    calls, _ = http
    assert "http:// or https://" in UnbrowseToolSpec(api_key=KEY).unbrowse_scrape("ftp://x")
    assert calls == []


def test_key_from_env(monkeypatch, http):
    calls, replies = http
    monkeypatch.setenv("UNBROWSE_API_KEY", "ub_env_key")
    replies.append(text_result(PAGE))
    UnbrowseToolSpec().unbrowse_scrape("https://example.com")
    assert calls[0]["headers"]["authorization"] == "Bearer ub_env_key"


def test_missing_key(monkeypatch):
    monkeypatch.delenv("UNBROWSE_API_KEY", raising=False)
    with pytest.raises(UnbrowseError, match="Missing Unbrowse API key"):
        UnbrowseToolSpec()


@pytest.mark.skipif(not LIVE, reason="set UNBROWSE_LIVE=1 and UNBROWSE_API_KEY")
def test_live():
    spec = UnbrowseToolSpec(raise_errors=True)
    assert "Example Domain" in spec.unbrowse_scrape("https://example.com")
    assert spec.unbrowse_discover("hacker news front page")
