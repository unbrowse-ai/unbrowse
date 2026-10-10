"""Unbrowse core tools as Hermes tools: specs from the shipped skill's tools.json, handlers over the MCP client."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List

from .client import McpError, UnbrowseMcp, result_text

TOOLSET = "unbrowse"
TOOLS_JSON = Path(__file__).resolve().parent / "skills" / "unbrowse" / "references" / "tools.json"
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")
_DOTTED = re.compile(r"\bunbrowse(?:\.[a-z][a-z_]*)+")


def safe_name(name: str) -> str:
    """Host-safe tool name: every char outside ``[A-Za-z0-9_-]`` becomes ``_`` (``unbrowse.scrape`` → ``unbrowse_scrape``)."""
    return _UNSAFE.sub("_", name)


def load_core_tools(path: Path = TOOLS_JSON) -> List[Dict[str, Any]]:
    """The core tool list (name, description, inputSchema) shipped with the skill."""
    data = json.loads(path.read_text(encoding="utf-8"))
    # Only unbrowse_x: the export also carries the ChatGPT-connector ``search`` / ``fetch``, which would shadow host tools.
    return [t for t in (data["tools"] if isinstance(data, dict) else data) if t["name"].startswith("unbrowse")]


def _rename_refs(text: str, known: Dict[str, str]) -> str:
    """Rewrite dotted tool references in a description to the names this host exposes."""
    return _DOTTED.sub(lambda m: known.get(m.group(0), m.group(0)), text or "")


def tool_specs(tools: List[Dict[str, Any]] | None = None) -> List[Dict[str, Any]]:
    """``[{remote, name, schema}]`` — ``schema`` is Hermes' ``{name, description, parameters}``."""
    tools = load_core_tools() if tools is None else tools
    known = {t["name"]: safe_name(t["name"]) for t in tools}
    specs = []
    for tool in tools:
        params = dict(tool.get("inputSchema") or {"type": "object", "properties": {}})
        params.pop("$schema", None)
        params.setdefault("type", "object")
        params.setdefault("properties", {})
        specs.append({
            "remote": tool["name"],
            "name": known[tool["name"]],
            "schema": {
                "name": known[tool["name"]],
                "description": _rename_refs(tool.get("description") or tool["name"], known),
                "parameters": params,
            },
        })
    return specs


def format_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """``{text, structured?, error?}``. ``structured`` is left out when the text already is that JSON."""
    text = result_text(result)
    out: Dict[str, Any] = {"text": text}
    structured = result.get("structuredContent")
    if structured is not None:
        try:
            same = json.loads(text) == structured
        except ValueError:
            same = False
        if not same:
            out["structured"] = structured
    if result.get("isError"):
        out["error"] = text or "Unbrowse tool returned an error"
    return out


def make_handler(remote: str, client_factory: Callable[[], UnbrowseMcp]) -> Callable[..., str]:
    """A Hermes handler: ``(args, **kwargs) -> JSON string``. Never raises."""

    def handler(args: Dict[str, Any], **kwargs: Any) -> str:
        del kwargs
        try:
            client = client_factory()
            result = client.call_tool(remote, args if isinstance(args, dict) else {})
            return json.dumps(format_result(result), ensure_ascii=False)
        except McpError as exc:
            payload: Dict[str, Any] = {"text": "", "error": exc.message, "code": exc.code}
            if exc.code == "browser_capacity":
                payload["hint"] = "Unbrowse's cloud browsers are busy; wait about 30 seconds and retry."
            elif exc.status == 401 or exc.code in ("unauthorized", "invalid_token"):
                payload["hint"] = "Set a valid UNBROWSE_API_KEY (https://unbrowse.ai) in the Hermes .env."
            return json.dumps(payload, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001 — handler contract: never raise
            return json.dumps({"text": "", "error": f"{type(exc).__name__}: {exc}", "code": "plugin_error"})

    handler.__name__ = f"unbrowse_{safe_name(remote)}"
    return handler
