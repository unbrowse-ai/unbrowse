"""Unbrowse plugin for Hermes Agent (Nous Research).

Registers the hosted Unbrowse core tools (``unbrowse_scrape``, ``unbrowse_discover``, ``unbrowse_run``,
``unbrowse_browse_open``, ...), Unbrowse as a ``web_extract`` backend (``web.extract_backend: unbrowse``),
a ``pre_tool_call`` guard that sends public-web browsing to Unbrowse instead of the built-in browser, and
the Unbrowse skill (``skill_view("unbrowse:unbrowse")``).

Settings live under ``plugins.entries.unbrowse.settings`` (see plugin.yaml ``config_schema``); the API key
belongs in ``$HERMES_HOME/.env`` as ``UNBROWSE_API_KEY``.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .client import DEFAULT_MCP_URL, UnbrowseMcp
from .guard import BrowserGuard
from .tools import TOOLSET, make_handler, tool_specs
from .web_provider import build_provider

logger = logging.getLogger(__name__)

PLUGIN_DIR = Path(__file__).resolve().parent
SKILL_MD = PLUGIN_DIR / "skills" / "unbrowse" / "SKILL.md"
SETTING_DEFAULTS: Dict[str, Any] = {
    "apiKey": "", "mcpUrl": "", "endUser": "", "timeout": 180,
    "blockBrowser": True, "blockWebExtract": "auto", "blockWebSearch": False,
}


def _env(name: str) -> Optional[str]:
    """Config-aware env lookup (process env, then ``$HERMES_HOME/.env``, profile secret scopes honoured)."""
    try:
        from agent.web_search_provider import get_provider_env

        return get_provider_env(name) or None
    except Exception:  # noqa: BLE001 — outside Hermes, or an unscoped multiplex lookup
        return (os.environ.get(name) or "").strip() or None


def _extract_backend() -> str:
    try:
        from hermes_cli.config import load_config_readonly

        web = (load_config_readonly() or {}).get("web") or {}
        return str(web.get("extract_backend") or web.get("backend") or "").strip().lower()
    except Exception:  # noqa: BLE001
        return ""


class Settings:
    """Reads plugin settings lazily, so config edits apply without a restart."""

    def __init__(self, get_config: Callable[[str, Any], Any], env: Callable[[str], Optional[str]] = _env):
        self._get = get_config
        self._env = env

    def get(self, key: str) -> Any:
        try:
            value = self._get(key, SETTING_DEFAULTS.get(key))
        except Exception:  # noqa: BLE001 — unreadable config: defaults
            value = SETTING_DEFAULTS.get(key)
        return SETTING_DEFAULTS.get(key) if value is None else value

    def api_key(self) -> Optional[str]:
        return self._env("UNBROWSE_API_KEY") or (str(self.get("apiKey") or "").strip() or None)

    def mcp_url(self) -> str:
        return self._env("UNBROWSE_MCP_URL") or str(self.get("mcpUrl") or "").strip() or DEFAULT_MCP_URL

    def end_user(self) -> Optional[str]:
        return self._env("UNBROWSE_END_USER") or (str(self.get("endUser") or "").strip() or None)

    def timeout(self) -> float:
        try:
            return max(5.0, float(self.get("timeout")))
        except (TypeError, ValueError):
            return 180.0

    def guard_settings(self) -> Dict[str, Any]:
        return {"block_browser": self.get("blockBrowser"), "block_web_extract": self.get("blockWebExtract"),
                "block_web_search": self.get("blockWebSearch")}

    def client(self) -> UnbrowseMcp:
        return UnbrowseMcp(api_key=self.api_key() or "", url=self.mcp_url(), end_user=self.end_user() or "",
                           timeout=self.timeout(), client="hermes")


def register(ctx) -> None:
    """Hermes plugin entry point."""
    settings = Settings(ctx.get_config)
    has_key = lambda: bool(settings.api_key())  # noqa: E731

    for spec in tool_specs():
        ctx.register_tool(
            name=spec["name"], toolset=TOOLSET, schema=spec["schema"],
            handler=make_handler(spec["remote"], settings.client),
            check_fn=has_key, description=spec["schema"]["description"],
        )

    guard = BrowserGuard(settings.guard_settings, has_key, _extract_backend, _env)
    ctx.register_hook("pre_tool_call", guard.check)

    if hasattr(ctx, "register_web_search_provider"):
        provider = build_provider(settings.client, has_key)
        if provider is not None:
            ctx.register_web_search_provider(provider)

    if SKILL_MD.exists() and hasattr(ctx, "register_skill"):
        ctx.register_skill("unbrowse", SKILL_MD, description=(
            "Operating guide for the Unbrowse tools: discover → run, scrape, cloud browser, credentials."))
