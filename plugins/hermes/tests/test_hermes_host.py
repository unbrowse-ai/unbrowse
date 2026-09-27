"""The plugin inside a real Hermes: the host's own plugin loader, tool registry, pre_tool_call pipeline,
web_extract backend routing and Plugin Doctor. Each case runs in a subprocess with a throwaway HERMES_HOME.

Needs a Hermes interpreter: the current one when ``hermes_cli`` imports, else ``$HERMES_PYTHON``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import PLUGIN_DIR

HERE = Path(__file__).resolve().parent


def hermes_python() -> str | None:
    explicit = os.environ.get("HERMES_PYTHON")
    if explicit:
        return explicit
    try:
        import hermes_cli  # noqa: F401
    except Exception:
        return None
    return sys.executable


PY = hermes_python()
pytestmark = pytest.mark.skipif(PY is None, reason="Hermes is not importable (set HERMES_PYTHON)")


def install(home: Path, config: str) -> Path:
    target = home / "plugins" / "unbrowse"
    shutil.copytree(PLUGIN_DIR, target, ignore=shutil.ignore_patterns("tests", "pypi", "__pycache__", "*.pyc"))
    (home / "config.yaml").write_text(config)
    return target


def child_env(home: Path, **extra: str) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("UNBROWSE_", "HERMES_"))}
    env.update(HERMES_HOME=str(home), **extra)
    return env


def probe(home: Path, calls: list, **env: str) -> dict:
    out = subprocess.run([PY, str(HERE / "hermes_probe.py"), json.dumps({"calls": calls})],
                         env=child_env(home, **env), capture_output=True, text=True, timeout=600, cwd=str(home))
    assert out.returncode == 0, out.stderr[-3000:]
    return json.loads(out.stdout.strip().splitlines()[-1])


ENABLED = "plugins:\n  enabled:\n    - unbrowse\n"


def test_loader_registry_and_dispatch(tmp_path, fake_mcp):
    home = tmp_path / "home"
    install(home, ENABLED)
    report = probe(home, [
        {"tool": "browser_navigate", "args": {"url": "https://x.com"}},
        {"tool": "unbrowse_scrape", "args": {"url": "https://example.com"}},
        {"tool": "web_extract", "args": {"urls": ["https://example.com"]}},
    ], UNBROWSE_API_KEY="ub_fake_key", UNBROWSE_MCP_URL=fake_mcp.url)

    assert report["plugin"] == {"name": "unbrowse", "enabled": True, "tools": 24, "hooks": 1, "error": None,
                                "source": "user"}
    assert len(report["tools"]) == 24 and "unbrowse_scrape" in report["tools"]
    assert report["check_fn"] is True
    assert report["skill"].endswith("skills/unbrowse/SKILL.md")
    assert report["web_provider"] == {"name": "unbrowse", "extract": True, "search": False, "available": True}

    nav, scrape, extract = (r["result"] for r in report["results"])
    assert "unbrowse_scrape" in nav and "https://x.com" in nav
    scraped = json.loads(scrape)
    assert "fake body" in scraped["text"] and "structured" not in scraped and "error" not in scraped
    assert "unbrowse_scrape" in extract  # web backend is not unbrowse → guard routes the model to Unbrowse
    calls = [r for r in fake_mcp.requests if r["body"].get("method") == "tools/call"]
    assert [c["body"]["params"]["name"] for c in calls] == ["unbrowse.scrape"]
    assert calls[0]["headers"]["authorization"] == "Bearer ub_fake_key"


def test_web_extract_backend_unbrowse(tmp_path, fake_mcp):
    home = tmp_path / "home"
    install(home, ENABLED + "web:\n  extract_backend: unbrowse\n")
    report = probe(home, [{"tool": "web_extract", "args": {"urls": ["https://example.com"]}}],
                   UNBROWSE_API_KEY="ub_fake_key", UNBROWSE_MCP_URL=fake_mcp.url)
    result = json.loads(report["results"][0]["result"])
    page = result["results"][0]
    assert page["url"] == "https://example.com" and page["title"] == "Example Domain"
    assert "fake body" in page["content"]
    args = [r["body"]["params"]["arguments"] for r in fake_mcp.requests if r["body"].get("method") == "tools/call"]
    assert args == [{"url": "https://example.com", "formats": ["markdown"]}]


def test_opt_out_and_local_pages_leave_builtin_browser(tmp_path, fake_mcp):
    home = tmp_path / "home"
    install(home, ENABLED)
    # browser_back with no page: the built-in tool answers (not our block) — proves the hook stayed out.
    report = probe(home, [{"tool": "browser_back", "args": {}}], UNBROWSE_API_KEY="ub_fake_key",
                   UNBROWSE_MCP_URL=fake_mcp.url, UNBROWSE_ALLOW_BUILTIN_BROWSER="1")
    assert "Unbrowse replaces the built-in browser" not in report["results"][0]["result"]
    report = probe(home, [{"tool": "browser_back", "args": {}}], UNBROWSE_API_KEY="ub_fake_key",
                   UNBROWSE_MCP_URL=fake_mcp.url)
    assert "Unbrowse replaces the built-in browser" in report["results"][0]["result"]


def test_not_enabled_means_not_loaded(tmp_path):
    home = tmp_path / "home"
    install(home, "plugins:\n  enabled: []\n")
    report = probe(home, [], UNBROWSE_API_KEY="ub_fake_key")
    assert report["tools"] == [] and report["plugin"].get("enabled") is not True


def test_tools_hidden_without_key(tmp_path):
    home = tmp_path / "home"
    install(home, ENABLED)
    report = probe(home, [])
    assert report["check_fn"] is False and report["web_provider"]["available"] is False


def test_plugin_doctor_and_validate(tmp_path):
    hermes = Path(PY).with_name("hermes")
    cmd = [str(hermes)] if hermes.exists() else [PY, "-m", "hermes_cli.main"]
    home = tmp_path / "home"
    home.mkdir()
    for args in (["plugins", "doctor", str(PLUGIN_DIR), "--ci"], ["plugins", "validate", str(PLUGIN_DIR)]):
        out = subprocess.run(cmd + args, env=child_env(home), capture_output=True, text=True, timeout=600)
        assert out.returncode == 0, out.stdout[-3000:] + out.stderr[-3000:]
    assert "24 tool(s), 1 hook(s)" in subprocess.run(
        cmd + ["plugins", "doctor", str(PLUGIN_DIR), "--ci"], env=child_env(home), capture_output=True, text=True,
        timeout=600).stdout
