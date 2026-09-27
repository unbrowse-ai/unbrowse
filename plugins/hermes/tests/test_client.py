import json

import pytest

from conftest import load_plugin_package

client_mod = __import__(load_plugin_package().__name__ + ".client", fromlist=["x"])
UnbrowseMcp, McpError = client_mod.UnbrowseMcp, client_mod.McpError


def make(fake, **kw):
    kw.setdefault("api_key", "ub_test_secret")
    return UnbrowseMcp(url=fake.url, timeout=10, **kw)


def test_json_response_and_headers(fake_mcp):
    result = make(fake_mcp, end_user="user-7").call_tool("unbrowse.scrape", {"url": "https://example.com"})
    assert result["structuredContent"]["metadata"]["title"] == "Example Domain"
    req = fake_mcp.requests[-1]
    assert req["body"]["method"] == "tools/call"
    assert req["body"]["params"] == {"name": "unbrowse.scrape", "arguments": {"url": "https://example.com"}}
    assert req["body"]["jsonrpc"] == "2.0"
    h = req["headers"]
    assert h["authorization"] == "Bearer ub_test_secret"
    assert h["x-unbrowse-end-user"] == "user-7"
    assert h["mcp-protocol-version"] == "2025-11-25"
    assert h["accept"] == "application/json, text/event-stream"
    assert h["content-type"] == "application/json"


def test_no_key_sends_no_auth_and_no_end_user(fake_mcp, monkeypatch):
    monkeypatch.delenv("UNBROWSE_API_KEY", raising=False)
    monkeypatch.delenv("UNBROWSE_END_USER", raising=False)
    UnbrowseMcp(url=fake_mcp.url, timeout=10).list_tools()
    assert "authorization" not in fake_mcp.requests[-1]["headers"]
    assert "x-unbrowse-end-user" not in fake_mcp.requests[-1]["headers"]


def test_env_defaults(monkeypatch, fake_mcp):
    monkeypatch.setenv("UNBROWSE_API_KEY", "ub_env_key")
    monkeypatch.setenv("UNBROWSE_MCP_URL", fake_mcp.url + "/")
    c = UnbrowseMcp(timeout=10)
    assert c.url == fake_mcp.url
    c.list_tools()
    assert fake_mcp.requests[-1]["headers"]["authorization"] == "Bearer ub_env_key"


def test_default_url(monkeypatch):
    monkeypatch.delenv("UNBROWSE_MCP_URL", raising=False)
    assert UnbrowseMcp(api_key="x").url == "https://unbrowse.ai/mcp"


def test_sse_takes_last_data_event(fake_mcp):
    def sse(body, headers):
        first = json.dumps({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}})
        last = fake_mcp.rpc_result(body, {"content": [{"type": "text", "text": "done"}]})
        return 200, "text/event-stream", f"event: message\ndata: {first}\n\nevent: message\r\ndata: {last}\n\n"
    fake_mcp.responder = sse
    result = make(fake_mcp).call_tool("unbrowse.discover", {"query": "q"})
    assert result["content"][0]["text"] == "done"


def test_sse_multiline_data(fake_mcp):
    def sse(body, headers):
        msg = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": {"tools": [{"name": "a"}]}}, indent=1)
        data = "\n".join("data: " + line for line in msg.split("\n"))
        return 200, "text/event-stream", data + "\n\n"
    fake_mcp.responder = sse
    assert make(fake_mcp).list_tools() == [{"name": "a"}]


def test_empty_sse_is_mcp_empty(fake_mcp):
    fake_mcp.responder = lambda b, h: (200, "text/event-stream", ": keepalive\n\n")
    with pytest.raises(McpError) as err:
        make(fake_mcp).list_tools()
    assert err.value.code == "mcp_empty"


def test_rpc_error_carries_data_code(fake_mcp):
    fake_mcp.responder = lambda b, h: (200, "application/json", json.dumps({
        "jsonrpc": "2.0", "id": b["id"],
        "error": {"code": -32000, "message": "All browsers busy", "data": {"code": "browser_capacity"}}}))
    with pytest.raises(McpError) as err:
        make(fake_mcp).call_tool("unbrowse.browse.open", {"url": "https://x.com"})
    assert (err.value.code, err.value.message) == ("browser_capacity", "All browsers busy")


def test_rpc_error_without_data_code(fake_mcp):
    fake_mcp.responder = lambda b, h: (200, "application/json", json.dumps({
        "jsonrpc": "2.0", "id": b["id"], "error": {"code": -32601, "message": "Method not found"}}))
    with pytest.raises(McpError) as err:
        make(fake_mcp).rpc("nope")
    assert err.value.code == "rpc_-32601"


def test_http_401_json_error_and_no_key_leak(fake_mcp):
    fake_mcp.responder = lambda b, h: (401, "application/json", json.dumps({
        "error": "invalid_token", "error_description": "Sign in to Unbrowse"}))
    with pytest.raises(McpError) as err:
        make(fake_mcp).list_tools()
    assert (err.value.status, err.value.code, err.value.message) == (401, "invalid_token", "Sign in to Unbrowse")
    assert "ub_test_secret" not in repr(err.value) + str(err.value.to_dict())
    assert "ub_test_secret" not in repr(make(fake_mcp))


def test_http_error_jsonrpc_body(fake_mcp):
    fake_mcp.responder = lambda b, h: (400, "application/json", json.dumps({
        "jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Unsupported protocol version",
                                                "data": {"code": "bad_protocol_version"}}}))
    with pytest.raises(McpError) as err:
        make(fake_mcp).list_tools()
    assert (err.value.status, err.value.code) == (400, "bad_protocol_version")


def test_http_error_plain_text(fake_mcp):
    fake_mcp.responder = lambda b, h: (502, "text/plain", "bad gateway")
    with pytest.raises(McpError) as err:
        make(fake_mcp).list_tools()
    assert (err.value.status, err.value.code) == (502, "http_error")


def test_non_jsonrpc_body(fake_mcp):
    fake_mcp.responder = lambda b, h: (200, "application/json", "{not json")
    with pytest.raises(McpError) as err:
        make(fake_mcp).list_tools()
    assert err.value.code == "mcp_bad_body"


def test_network_error():
    with pytest.raises(McpError) as err:
        UnbrowseMcp(api_key="k", url="http://127.0.0.1:9/mcp", timeout=5).list_tools()
    assert err.value.code in ("network_error", "timeout")


def test_list_tools_follows_cursor(fake_mcp):
    pages = {None: ([{"name": "unbrowse.a"}], "c1"), "c1": ([{"name": "unbrowse.b"}], "c2"),
             "c2": ([{"name": "unbrowse.c"}], None)}

    def paged(body, headers):
        cursor = (body.get("params") or {}).get("cursor")
        tools, nxt = pages[cursor]
        result = {"tools": tools, **({"nextCursor": nxt} if nxt else {})}
        return 200, "application/json", fake_mcp.rpc_result(body, result)
    fake_mcp.responder = paged
    names = [t["name"] for t in make(fake_mcp).list_tools()]
    assert names == ["unbrowse.a", "unbrowse.b", "unbrowse.c"]
    assert "params" not in fake_mcp.requests[0]["body"]
    assert [r["body"]["params"]["cursor"] for r in fake_mcp.requests[1:]] == ["c1", "c2"]
    ids = [r["body"]["id"] for r in fake_mcp.requests]
    assert len(set(ids)) == 3


def test_list_tools_stops_on_repeated_cursor(fake_mcp):
    fake_mcp.responder = lambda b, h: (200, "application/json",
                                       fake_mcp.rpc_result(b, {"tools": [{"name": "x"}], "nextCursor": "same"}))
    assert len(make(fake_mcp).list_tools()) == 2


def test_result_text():
    rt = client_mod.result_text
    assert rt({"content": [{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}]}) == "a\nb"
    assert rt({"content": [], "structuredContent": {"k": 1}}) == '{"k": 1}'
    assert rt({}) == ""
