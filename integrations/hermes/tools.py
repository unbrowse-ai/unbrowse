"""What runs when the model calls a tool: one request to the node through the unbrowse SDK, answered as a JSON string.

The tools are the SDK's (``unbrowse.adapters``): every agent tool the node's MCP server lists, with its name,
description and input schema, written from the node's own ``agent-api.json``. A handler never raises: it answers what
the MCP server would, the node's JSON, or ``{"error": <the node's reason>, "code": ...}`` when the node refuses or
can't be reached. A call that reached the site and didn't pass is a result (``ok: false`` with ``retry``), not an error.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

# The tools the node serves, in its order (unbrowse-node/agent-api.json). plugin.yaml's provides_tools names the same;
# the tests fail when either drifts from the node.
TOOL_NAMES = (
    "unbrowse_search",
    "unbrowse_do",
    "unbrowse_walk",
    "unbrowse_browse",
    "unbrowse_challenge",
    "unbrowse_observe",
    "unbrowse_logins",
    "unbrowse_open",
    "unbrowse_call",
    "unbrowse_inspect",
    "unbrowse_judge",
    "unbrowse_whoami",
    "unbrowse_setup",
    "unbrowse_report",
)

NO_SDK = (
    "the unbrowse Python SDK isn't installed where Hermes runs: install it into Hermes's Python with "
    "pip install \"unbrowse @ git+https://github.com/unbrowse-ai/unbrowse-core#subdirectory=unbrowse-sdk/python\""
)

# One browsing session for every call this plugin makes, so the page an unbrowse_browse step opens is the one the
# next step acts on, as the MCP server keeps each client's.
SESSION = uuid.uuid4().hex


def _adapters() -> Any:
    """The SDK's tools module, or None. Another package that took the name ``unbrowse`` doesn't count."""
    try:
        from unbrowse import adapters
    except ImportError:
        return None
    return adapters if hasattr(adapters, "TOOLS") and hasattr(adapters, "run_tool") else None


def available() -> bool:
    """The tools show when the SDK is installed and the agent has a token.

    The node itself isn't asked: when it isn't running, the call says so, and that tells the model more than a missing
    tool would.
    """
    return _adapters() is not None and bool(os.environ.get("UNBROWSE_AGENT_TOKEN"))


def _schema(name: str, spec: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if spec is None:
        # Without the SDK the tool is hidden (available() is False); it keeps its name so the plugin still says what it
        # provides.
        return {"name": name, "description": NO_SDK, "parameters": {"type": "object", "properties": {}}}
    return {"name": spec["name"], "description": spec["description"], "parameters": spec["input_schema"]}


def _handler(name: str) -> Callable[..., str]:
    def handle(args: Optional[Dict[str, Any]] = None, **kwargs: Any) -> str:
        adapters = _adapters()
        if adapters is None:
            return json.dumps({"error": NO_SDK, "code": "unavailable"}, ensure_ascii=False)
        spec = next((s for s in adapters.TOOLS.values() if s["name"] == name), None)
        if spec is None:
            return json.dumps({"error": f"this unbrowse SDK has no tool {name}: update it", "code": "unavailable"}, ensure_ascii=False)
        # A fresh client each call: it reads UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN as they are now.
        from unbrowse import UnbrowseNode

        return json.dumps(adapters.run_tool(UnbrowseNode(session=SESSION), spec, _args(args)), ensure_ascii=False)

    handle.__name__ = name
    return handle


def _args(v: Any) -> Dict[str, Any]:
    """The model's arguments. Some models send the object as a JSON string; that is read as the object."""
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return {}
    return v if isinstance(v, dict) else {}


def tools() -> List[Tuple[Dict[str, Any], Callable[..., str]]]:
    """Each tool's schema, in Hermes's shape (name, description, parameters), and its handler."""
    adapters = _adapters()
    specs = {s["name"]: s for s in adapters.TOOLS.values()} if adapters else {}
    return [(_schema(name, specs.get(name)), _handler(name)) for name in TOOL_NAMES]
