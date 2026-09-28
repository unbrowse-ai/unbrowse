"""Unit tests (mocked HTTP) and, with UNBROWSE_LIVE=1 and UNBROWSE_API_KEY set, live calls to the hosted API."""

import io
import json
import os
import sys
import urllib.error
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import unbrowse_client  # noqa: E402
from unbrowse_client import UnbrowseError, call_tool, list_tools  # noqa: E402

dify_plugin = pytest.importorskip("dify_plugin")
from dify_plugin.errors.tool import ToolProviderCredentialValidationError  # noqa: E402

from provider.unbrowse import UnbrowseProvider  # noqa: E402
from tools.discover import DiscoverTool  # noqa: E402
from tools.run_task import RunTaskTool, build_arguments  # noqa: E402
from tools.scrape_page import ScrapePageTool  # noqa: E402

LIVE = os.environ.get("UNBROWSE_LIVE") == "1" and bool(os.environ.get("UNBROWSE_API_KEY"))
KEY = os.environ.get("UNBROWSE_API_KEY", "")


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def http(monkeypatch):
    calls = []
    replies = []

    def urlopen(request, timeout=None):
        calls.append({"headers": dict(request.header_items()), "body": json.loads(request.data), "timeout": timeout})
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return FakeResponse(json.dumps(reply).encode())

    monkeypatch.setattr(unbrowse_client.urllib.request, "urlopen", urlopen)
    return calls, replies


def text_result(payload):
    return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}


def messages(tool_cls, params, key="ub_live_test"):
    return list(tool_cls.from_credentials({"unbrowse_api_key": key}).invoke(params))


# --- manifest and YAML ---------------------------------------------------------------------------

def test_manifest_lists_provider_and_privacy():
    manifest = yaml.safe_load((ROOT / "manifest.yaml").read_text())
    assert manifest["author"] == "unbrowse" and manifest["name"] == "unbrowse"
    assert manifest["privacy"] == "PRIVACY.md" and (ROOT / "PRIVACY.md").is_file()
    assert (ROOT / "_assets" / manifest["icon"]).is_file()
    assert manifest["plugins"]["tools"] == ["provider/unbrowse.yaml"]


def test_provider_yaml_points_at_existing_tools():
    provider = yaml.safe_load((ROOT / "provider/unbrowse.yaml").read_text())
    assert provider["credentials_for_provider"]["unbrowse_api_key"]["type"] == "secret-input"
    names = []
    for rel in provider["tools"]:
        tool = yaml.safe_load((ROOT / rel).read_text())
        assert (ROOT / tool["extra"]["python"]["source"]).is_file()
        names.append(tool["identity"]["name"])
    assert names == ["scrape_page", "discover", "run_task"]


# --- client ----------------------------------------------------------------------------------------

def test_call_tool_sends_json_rpc_with_bearer(http):
    calls, replies = http
    replies.append(text_result({"url": "https://example.com", "markdown": "# Example"}))
    out = call_tool("ub_live_test", "unbrowse.scrape", {"url": "https://example.com"})
    assert out["markdown"] == "# Example"
    sent = calls[0]
    assert sent["headers"]["Authorization"] == "Bearer ub_live_test"
    assert sent["headers"]["Accept"] == "application/json"
    assert sent["body"]["method"] == "tools/call"
    assert sent["body"]["params"] == {"name": "unbrowse.scrape", "arguments": {"url": "https://example.com"}}


def test_rpc_error_is_raised_without_the_key(http):
    _, replies = http
    replies.append({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "boom"}})
    with pytest.raises(UnbrowseError) as err:
        call_tool("ub_live_secret", "unbrowse.scrape", {"url": "https://example.com"})
    assert "boom" in str(err.value) and "ub_live_secret" not in str(err.value)


def test_http_401_says_key_rejected(http):
    _, replies = http
    body = io.BytesIO(json.dumps({"error": {"code": -32001, "message": "Invalid API key"}}).encode())
    replies.append(urllib.error.HTTPError("https://unbrowse.ai/api/mcp", 401, "Unauthorized", {}, body))
    with pytest.raises(UnbrowseError, match="rejected the API key: Invalid API key"):
        list_tools("ub_live_bad")


def test_missing_key_fails_before_network(http):
    calls, _ = http
    with pytest.raises(UnbrowseError, match="Missing Unbrowse API key"):
        list_tools("  ")
    assert calls == []


# --- provider and tools ----------------------------------------------------------------------------

def test_provider_validates_with_tools_list(http):
    calls, replies = http
    replies.append({"jsonrpc": "2.0", "id": 1, "result": {"tools": [{"name": "unbrowse.scrape"}]}})
    UnbrowseProvider().validate_credentials({"unbrowse_api_key": "ub_live_test"})
    assert calls[0]["body"]["method"] == "tools/list"


def test_provider_rejects_bad_key(http):
    _, replies = http
    replies.append({"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": "Invalid API key"}})
    with pytest.raises(ToolProviderCredentialValidationError, match="Invalid API key"):
        UnbrowseProvider().validate_credentials({"unbrowse_api_key": "ub_live_bad"})


def test_scrape_page_yields_markdown_and_json(http):
    calls, replies = http
    page = {"url": "https://example.com", "metadata": {"title": "Example"}, "markdown": "# Example", "links": []}
    replies.append(text_result(page))
    out = messages(ScrapePageTool, {"url": "https://example.com", "render": "never", "only_main_content": True})
    assert out[0].message.text == "# Example"
    assert out[1].message.json_object == page
    assert calls[0]["body"]["params"]["arguments"] == {
        "url": "https://example.com", "formats": ["markdown", "links"], "onlyMainContent": True, "render": "never",
    }


def test_scrape_page_rejects_non_http_url(http):
    with pytest.raises(ValueError, match="http"):
        messages(ScrapePageTool, {"url": "file:///etc/passwd"})


def test_discover_passes_query(http):
    calls, replies = http
    replies.append(text_result({"private": [], "public": [{"id": "hn.top_stories"}]}))
    out = messages(DiscoverTool, {"query": "hacker news"})
    assert out[0].message.json_object["public"][0]["id"] == "hn.top_stories"
    assert calls[0]["body"]["params"] == {"name": "unbrowse.discover", "arguments": {"query": "hacker news"}}


def test_run_task_arguments():
    assert build_arguments({"task": "top stories"}) == {"task": "top stories"}
    assert build_arguments({"capability": "hn.top_stories", "input": '{"n": 5}'}) == {
        "capability": "hn.top_stories", "input": {"n": 5},
    }
    with pytest.raises(ValueError, match="task"):
        build_arguments({})
    with pytest.raises(ValueError, match="JSON object"):
        build_arguments({"task": "x", "input": "[1]"})
    with pytest.raises(ValueError, match="JSON object"):
        build_arguments({"task": "x", "input": "not json"})


def test_run_task_returns_status(http):
    _, replies = http
    replies.append(text_result({"status": "input_required", "missing": ["query"]}))
    out = messages(RunTaskTool, {"task": "search amazon"})
    assert out[0].message.json_object["status"] == "input_required"


# --- live --------------------------------------------------------------------------------------------

live = pytest.mark.skipif(not LIVE, reason="set UNBROWSE_LIVE=1 and UNBROWSE_API_KEY for live calls")


@live
def test_live_validate_credentials():
    UnbrowseProvider().validate_credentials({"unbrowse_api_key": KEY})
    with pytest.raises(ToolProviderCredentialValidationError):
        UnbrowseProvider().validate_credentials({"unbrowse_api_key": "ub_live_invalid"})


@live
def test_live_scrape_page():
    out = messages(ScrapePageTool, {"url": "https://example.com", "render": "never"}, key=KEY)
    assert "Example Domain" in out[0].message.text
    assert out[1].message.json_object["metadata"]["title"] == "Example Domain"


@live
def test_live_discover():
    out = messages(DiscoverTool, {"query": "hacker news top stories"}, key=KEY)
    assert isinstance(out[0].message.json_object, (dict, list))


@live
def test_live_run_task():
    out = messages(RunTaskTool, {"task": "get the top stories on hacker news"}, key=KEY)
    assert out[0].message.json_object["status"] in ("succeeded", "input_required", "no_capability")
