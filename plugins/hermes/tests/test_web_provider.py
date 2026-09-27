import json

from conftest import load_plugin_package

pkg = load_plugin_package()
wp = __import__(pkg.__name__ + ".web_provider", fromlist=["x"])
client_mod = __import__(pkg.__name__ + ".client", fromlist=["x"])


def test_scrape_to_document_structured():
    doc = wp.scrape_to_document("https://example.com", {
        "content": [{"type": "text", "text": "{}"}],
        "structuredContent": {"finalUrl": "https://example.com/", "via": "http",
                              "metadata": {"title": "Example Domain", "statusCode": 200},
                              "markdown": "# Example Domain"}})
    assert doc["url"] == "https://example.com" and doc["title"] == "Example Domain"
    assert doc["content"] == doc["raw_content"] == "# Example Domain"
    assert doc["metadata"]["finalUrl"] == "https://example.com/" and doc["metadata"]["sourceURL"] == "https://example.com"
    assert "error" not in doc


def test_scrape_to_document_text_only_and_error():
    doc = wp.scrape_to_document("https://a.b", {"content": [{"type": "text", "text": "plain words"}]})
    assert doc["content"] == "plain words"
    doc = wp.scrape_to_document("https://a.b", {"content": [{"type": "text", "text": '{"error": "blocked by site"}'}],
                                                "isError": True})
    assert doc["error"] == "blocked by site" and doc["content"] == ""


def test_extract_urls_parallel_order_and_failures(fake_mcp):
    def responder(body, headers):
        url = body["params"]["arguments"]["url"]
        if "bad" in url:
            return 200, "application/json", json.dumps({"jsonrpc": "2.0", "id": body["id"],
                                                        "error": {"code": -1, "message": "nope", "data": {"code": "scrape_failed"}}})
        payload = {"metadata": {"title": url}, "markdown": f"body of {url}"}
        return 200, "application/json", fake_mcp.rpc_result(body, {"content": [], "structuredContent": payload})
    fake_mcp.responder = responder
    factory = lambda: client_mod.UnbrowseMcp(api_key="k", url=fake_mcp.url, timeout=10)  # noqa: E731
    urls = ["https://a.com", "https://bad.com", "https://c.com"]
    docs = wp.extract_urls(factory, urls, "markdown")
    assert [d["url"] for d in docs] == urls
    assert docs[0]["content"] == "body of https://a.com" and docs[2]["title"] == "https://c.com"
    assert "scrape_failed" in docs[1]["error"]
    assert {r["body"]["params"]["arguments"]["formats"][0] for r in fake_mcp.requests} == {"markdown"}


def test_build_provider_outside_or_inside_hermes():
    provider = wp.build_provider(lambda: None, lambda: True)
    try:
        import agent.web_search_provider  # noqa: F401
    except Exception:
        assert provider is None
        return
    assert provider.name == "unbrowse" and provider.supports_extract() and not provider.supports_search()
    assert provider.is_available() is True
    assert wp.build_provider(lambda: None, lambda: 1 / 0).is_available() is False
    assert provider.get_setup_schema()["env_vars"][0]["key"] == "UNBROWSE_API_KEY"
