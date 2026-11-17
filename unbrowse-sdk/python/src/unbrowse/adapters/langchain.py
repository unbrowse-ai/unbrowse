"""Unbrowse as LangChain tools: ``create_agent(model, tools=unbrowse_tools())``, or
``model.bind_tools(unbrowse_tools())``. Needs ``pip install unbrowse[langchain]``.

Each tool is the node's MCP tool of the same name, with its description and input schema, and answers what the MCP
server would, as JSON text: the node's answer, or ``{"error", "code"}`` when a call fails, so the model reads what went
wrong."""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Iterable, List, Optional

try:
    from langchain_core.tools import StructuredTool
except ImportError as e:  # pragma: no cover - the message is the point
    raise ImportError("unbrowse.adapters.langchain needs langchain-core: pip install 'unbrowse[langchain]'") from e

from ..client import UnbrowseNode
from ._core import DEFAULT_TOOLS, as_text, chosen, node_of, run_tool

__all__ = ["unbrowse_tools", "DEFAULT_TOOLS"]


def _tool(node: UnbrowseNode, spec: Dict[str, Any]) -> StructuredTool:
    def run(**kwargs: Any) -> str:
        return as_text(run_tool(node, spec, kwargs))

    async def arun(**kwargs: Any) -> str:
        # The client is synchronous: its request runs in a thread, so an async agent isn't held up.
        return await asyncio.to_thread(run, **kwargs)

    return StructuredTool.from_function(
        func=run,
        coroutine=arun,
        name=spec["name"],
        description=spec["description"],
        args_schema=spec["input_schema"],
        infer_schema=False,
    )


def unbrowse_tools(node: Optional[UnbrowseNode] = None, include: Optional[Iterable[str]] = None) -> List[StructuredTool]:
    """The Unbrowse tools as LangChain ``StructuredTool``s.

    ``node`` defaults to ``Unbrowse()``, which reads UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN. ``include`` names the
    tools to give, with or without ``unbrowse_`` (default ``DEFAULT_TOOLS``: do, search, call, logins, whoami); add
    ``"browse"`` for pages that need clicks or typing: ``include=[*DEFAULT_TOOLS, "browse"]``."""
    client = node_of(node)
    return [_tool(client, spec) for spec in chosen(include)]
