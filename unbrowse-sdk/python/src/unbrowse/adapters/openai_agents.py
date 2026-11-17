"""Unbrowse as OpenAI Agents SDK tools: ``Agent(name=..., instructions=..., tools=unbrowse_tools())``. Needs
``pip install unbrowse[openai-agents]``.

Each tool is the node's MCP tool of the same name, with its description and input schema, and answers what the MCP
server would, as JSON text: the node's answer, or ``{"error", "code"}`` when a call fails, so the model reads what went
wrong. The tools aren't strict: a route's ``inputs`` is an open map, which strict mode can't describe."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Iterable, List, Optional

try:
    from agents import FunctionTool
except ImportError as e:  # pragma: no cover - the message is the point
    raise ImportError("unbrowse.adapters.openai_agents needs openai-agents: pip install 'unbrowse[openai-agents]'") from e

from ..client import UnbrowseNode
from ._core import DEFAULT_TOOLS, as_text, chosen, node_of, run_tool

__all__ = ["unbrowse_tools", "DEFAULT_TOOLS"]


def _tool(node: UnbrowseNode, spec: Dict[str, Any]) -> FunctionTool:
    async def invoke(_ctx: Any, args_json: str) -> str:
        try:
            given = json.loads(args_json) if args_json else {}
        except ValueError as e:
            return as_text({"error": f"the arguments aren't JSON: {e}", "code": "bad_request"})
        # The client is synchronous: its request runs in a thread, so the agent's loop isn't held up.
        return as_text(await asyncio.to_thread(run_tool, node, spec, given if isinstance(given, dict) else {}))

    return FunctionTool(
        name=spec["name"],
        description=spec["description"],
        params_json_schema=spec["input_schema"],
        on_invoke_tool=invoke,
        strict_json_schema=False,
    )


def unbrowse_tools(node: Optional[UnbrowseNode] = None, include: Optional[Iterable[str]] = None) -> List[FunctionTool]:
    """The Unbrowse tools as OpenAI Agents ``FunctionTool``s.

    ``node`` defaults to ``Unbrowse()``, which reads UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN. ``include`` names the
    tools to give, with or without ``unbrowse_`` (default ``DEFAULT_TOOLS``: do, search, call, logins, whoami); add
    ``"browse"`` for pages that need clicks or typing: ``include=[*DEFAULT_TOOLS, "browse"]``."""
    client = node_of(node)
    return [_tool(client, spec) for spec in chosen(include)]
