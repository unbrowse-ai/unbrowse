"""Tool specs, handlers and register(ctx) against a fake Hermes PluginContext."""

import json
import re
from pathlib import Path

import pytest

from conftest import PLUGIN_DIR, load_plugin_package

pkg = load_plugin_package()
tools_mod = __import__(pkg.__name__ + ".tools", fromlist=["x"])


class FakeCtx:
    def __init__(self, config=None):
        self.config = config or {}
        self.tools, self.hooks, self.skills, self.web = {}, [], {}, []

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False,
                      description="", emoji="", override=False):
        assert name not in self.tools and not override
        self.tools[name] = dict(toolset=toolset, schema=schema, handler=handler, check_fn=check_fn)

    def register_hook(self, name, fn):
        self.hooks.append((name, fn))

    def register_skill(self, name, path, description=""):
        self.skills[name] = Path(path)

    def register_web_search_provider(self, provider):
        self.web.append(provider)


@pytest.fixture
def clean_env(monkeypatch):
    for name in ("UNBROWSE_API_KEY", "UNBROWSE_MCP_URL", "UNBROWSE_END_USER", "UNBROWSE_ALLOW_BUILTIN_BROWSER"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_safe_name():
    assert tools_mod.safe_name("unbrowse.scrape") == "unbrowse_scrape"
    assert tools_mod.safe_name("unbrowse.browse.open") == "unbrowse_browse_open"
    assert tools_mod.safe_name("a-b_c.d/e f") == "a-b_c_d_e_f"


def test_specs_cover_tools_json():
    raw = json.loads((PLUGIN_DIR / "skills/unbrowse/references/tools.json").read_text())["tools"]
    specs = tools_mod.tool_specs()
    assert [s["remote"] for s in specs] == [t["name"] for t in raw]
    for spec in specs:
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", spec["name"])
        assert spec["schema"]["name"] == spec["name"]
        assert spec["schema"]["parameters"]["type"] == "object"
        assert "properties" in spec["schema"]["parameters"]
        # descriptions reference the host names, never the dotted MCP names
        assert not re.search(r"unbrowse\.(?:discover|run|scrape|browse\.open|learn)\b", spec["schema"]["description"])
    by = {s["name"]: s for s in specs}
    assert "unbrowse_discover" in by["unbrowse_run"]["schema"]["description"]
    assert by["unbrowse_scrape"]["schema"]["parameters"]["required"] == ["url"]


def test_plugin_yaml_declares_every_tool():
    text = (PLUGIN_DIR / "plugin.yaml").read_text()
    try:
        import yaml
        manifest = yaml.safe_load(text)
    except ImportError:
        from ruamel.yaml import YAML
        manifest = YAML(typ="safe").load(text)
    assert manifest["provides_tools"] == [s["name"] for s in tools_mod.tool_specs()]
    assert manifest["provides_hooks"] == ["pre_tool_call"]
    assert manifest["name"] == "unbrowse"


def test_format_result_dedupes_structured():
    payload = {"a": 1}
    out = tools_mod.format_result({"content": [{"type": "text", "text": json.dumps(payload)}],
                                   "structuredContent": payload})
    assert out == {"text": '{"a": 1}'}
    out = tools_mod.format_result({"content": [{"type": "text", "text": "summary"}], "structuredContent": payload})
    assert out == {"text": "summary", "structured": payload}
    out = tools_mod.format_result({"content": [{"type": "text", "text": "boom"}], "isError": True})
    assert out == {"text": "boom", "error": "boom"}


def test_register_against_fake_ctx(clean_env, fake_mcp):
    ctx = FakeCtx()
    pkg.register(ctx)
    assert len(ctx.tools) == 24
    assert {t["toolset"] for t in ctx.tools.values()} == {"unbrowse"}
    assert [h[0] for h in ctx.hooks] == ["pre_tool_call"]
    assert ctx.skills["unbrowse"].name == "SKILL.md" and ctx.skills["unbrowse"].exists()
    scrape = ctx.tools["unbrowse_scrape"]
    assert scrape["check_fn"]() is False  # hidden without a key

    clean_env.setenv("UNBROWSE_API_KEY", "ub_k")
    clean_env.setenv("UNBROWSE_MCP_URL", fake_mcp.url)
    assert scrape["check_fn"]() is True
    out = json.loads(scrape["handler"]({"url": "https://example.com"}, task_id="t1", session_id="s"))
    assert "Example Domain" in out["text"] and "error" not in out
    sent = fake_mcp.requests[-1]
    assert sent["body"]["params"]["name"] == "unbrowse.scrape"
    assert sent["headers"]["authorization"] == "Bearer ub_k"
    assert sent["headers"]["user-agent"].startswith("unbrowse-hermes/")


def test_config_api_key_and_url(clean_env, fake_mcp):
    ctx = FakeCtx({"apiKey": "ub_from_config", "mcpUrl": fake_mcp.url, "endUser": "eu-1", "timeout": 30})
    pkg.register(ctx)
    assert ctx.tools["unbrowse_discover"]["check_fn"]() is True
    json.loads(ctx.tools["unbrowse_discover"]["handler"]({"query": "hn"}))
    h = fake_mcp.requests[-1]["headers"]
    assert h["authorization"] == "Bearer ub_from_config" and h["x-unbrowse-end-user"] == "eu-1"


def test_env_key_beats_config(clean_env, fake_mcp):
    clean_env.setenv("UNBROWSE_API_KEY", "ub_env")
    ctx = FakeCtx({"apiKey": "ub_cfg", "mcpUrl": fake_mcp.url})
    pkg.register(ctx)
    ctx.tools["unbrowse_sites"]["handler"]({})
    assert fake_mcp.requests[-1]["headers"]["authorization"] == "Bearer ub_env"


def test_handler_never_raises(clean_env, fake_mcp):
    clean_env.setenv("UNBROWSE_API_KEY", "ub_k")
    clean_env.setenv("UNBROWSE_MCP_URL", fake_mcp.url)
    ctx = FakeCtx()
    pkg.register(ctx)
    fake_mcp.responder = lambda b, h: (200, "application/json", json.dumps(
        {"jsonrpc": "2.0", "id": b["id"], "error": {"code": -32000, "message": "busy", "data": {"code": "browser_capacity"}}}))
    out = json.loads(ctx.tools["unbrowse_browse_open"]["handler"]({"url": "https://x.com"}))
    assert out["code"] == "browser_capacity" and "retry" in out["hint"]
    fake_mcp.responder = lambda b, h: (401, "application/json", '{"error":"invalid_token"}')
    out = json.loads(ctx.tools["unbrowse_scrape"]["handler"]({"url": "https://x.com"}))
    assert out["code"] == "invalid_token" and "UNBROWSE_API_KEY" in out["hint"] and "ub_k" not in json.dumps(out)
    clean_env.setenv("UNBROWSE_MCP_URL", "http://127.0.0.1:9/mcp")
    out = json.loads(ctx.tools["unbrowse_scrape"]["handler"]("not-a-dict"))
    assert out["code"] in ("network_error", "timeout")


def test_web_provider_registered_only_inside_hermes(clean_env):
    ctx = FakeCtx()
    pkg.register(ctx)
    try:
        import agent.web_search_provider  # noqa: F401
    except Exception:
        assert ctx.web == []
    else:
        assert [p.name for p in ctx.web] == ["unbrowse"]
