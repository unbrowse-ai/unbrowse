"""LIVE: the installed plugin inside real Hermes against the hosted Unbrowse MCP.

Opt-in: UNBROWSE_LIVE=1 and UNBROWSE_API_KEY (optionally UNBROWSE_MCP_URL). The key is passed to the
child through the environment only and is never printed. On ``browser_capacity`` a call waits 30s and
retries up to 3 times.
"""

from __future__ import annotations

import json
import os

import pytest

from test_hermes_host import ENABLED, PY, install, probe

pytestmark = pytest.mark.skipif(
    PY is None or os.environ.get("UNBROWSE_LIVE") != "1" or not os.environ.get("UNBROWSE_API_KEY"),
    reason="live test: set UNBROWSE_LIVE=1 and UNBROWSE_API_KEY (and a Hermes interpreter)")


def live_env() -> dict:
    env = {"UNBROWSE_API_KEY": os.environ["UNBROWSE_API_KEY"]}
    if os.environ.get("UNBROWSE_MCP_URL"):
        env["UNBROWSE_MCP_URL"] = os.environ["UNBROWSE_MCP_URL"]
    return env


def test_live_scrape_discover_and_guard(tmp_path):
    home = tmp_path / "home"
    install(home, ENABLED + "web:\n  extract_backend: unbrowse\n")
    report = probe(home, [
        {"tool": "unbrowse_scrape", "args": {"url": "https://example.com"}, "retry_capacity": 3},
        {"tool": "unbrowse_discover", "args": {"query": "hacker news top stories"}, "retry_capacity": 3},
        {"tool": "browser_navigate", "args": {"url": "https://example.com"}},
        {"tool": "web_extract", "args": {"urls": ["https://example.com"]}},
        # HTTP-only scrape: isolates the plugin path from the hosted cloud browser's egress.
        {"tool": "unbrowse_scrape", "args": {"url": "https://example.com", "render": "never"}, "retry_capacity": 3},
    ], **live_env())
    key = os.environ["UNBROWSE_API_KEY"]
    assert key not in json.dumps(report)
    assert report["plugin"]["enabled"] and report["plugin"]["tools"] == 30 and report["check_fn"] is True

    scrape, discover, nav, extract, http_scrape = report["results"]
    scraped = json.loads(http_scrape["result"])
    assert "error" not in scraped, scraped
    assert "Example Domain" in scraped["text"]
    default = json.loads(scrape["result"])
    if "error" in default:
        # The default (render: auto) path can fail inside the hosted cloud browser (e.g. proxy
        # ERR_TUNNEL_CONNECTION_FAILED). That is a server fault, surfaced verbatim, not a plugin fault.
        assert default["code"] and default["error"], default
        print("WARNING hosted render:auto scrape failed:", default["code"], default["error"].splitlines()[0])
    else:
        assert "Example Domain" in default["text"]

    found = json.loads(discover["result"])
    assert "error" not in found, found
    assert found["text"].strip()
    assert any(w in found["text"].lower() for w in ("hacker", "ycombinator", "hn", "stories"))

    assert "Unbrowse replaces the built-in browser" in nav["result"]
    page = json.loads(extract["result"])["results"][0]
    if "error" in default:
        assert page.get("error") or "Example Domain" in page.get("content", ""), page
    else:
        assert "Example Domain" in (page.get("title", "") + page.get("content", ""))
    print(json.dumps({"scrape_s": scrape["seconds"], "discover_s": discover["seconds"],
                      "scrape_attempts": scrape["attempts"], "discover_attempts": discover["attempts"],
                      "discover_chars": len(found["text"])}))
