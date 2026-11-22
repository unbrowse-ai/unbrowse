"""What every framework adapter shares: which tools to give, and running one against the node. Each adapter
(langchain.py, openai_agents.py) only wraps these in its framework's tool type."""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional

from ..client import UnbrowseError, UnbrowseNode
from ._tools import TOOLS

# The tools an adapter gives when ``include`` is left out. ``browse`` (driving the node's browser by hand) and
# ``report`` come only when ``include`` names them.
DEFAULT_TOOLS = ("do", "search", "call", "logins", "whoami")

# A node without a browser can still call the routes it has and other contributors' routes; only walking a page it
# hasn't learned needs one. A node that has the browser add-on names the case itself (``"code": "browser_missing"`` in
# its answer, which an SDK that knows the code raises as BrowserMissingError and an older one as a 422) and says how to
# get the browser (``install``); an older node says it only in its words, which the pattern catches.
_NO_BROWSER = re.compile(r"has no browser|downloading its browser", re.I)
_STILL = "unbrowse_do still calls the routes the node has, and routes other contributors list for the site"


def _browser_hint(e: "UnbrowseError") -> str:
    said = e.body if isinstance(e.body, dict) else {}
    if said.get("browser") == "installing":
        return f"The node is fetching its browser now: try again in a minute. Meanwhile {_STILL}."
    if isinstance(said.get("install"), str):
        return (
            f"This node has no browser, so it can't walk a page it hasn't learned. {_STILL}; the owner gets the browser "
            f"with `{said['install']}` on the node's machine."
        )
    return (
        f"This node has no browser, so it can't walk a page it hasn't learned. {_STILL}; ask the owner to install "
        "Chrome, or to download Chrome for Testing in the Unbrowse app's Settings, for the rest."
    )


def node_of(node: Optional[UnbrowseNode] = None) -> UnbrowseNode:
    """The client the tools use: the one given, or ``Unbrowse()``, which reads UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN."""
    return node if node is not None else UnbrowseNode()


def chosen(include: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
    """The tools ``include`` asks for, by name with or without ``unbrowse_``, in its order (default ``DEFAULT_TOOLS``).
    An unknown name raises, naming the ones there are."""
    out = []
    for n in include if include is not None else DEFAULT_TOOLS:
        short = n[len("unbrowse_"):] if n.startswith("unbrowse_") else n
        if short not in TOOLS:
            raise ValueError(f"no Unbrowse tool {n}: there are {', '.join(TOOLS)}")
        out.append(TOOLS[short])
    return out


def tool_error(e: BaseException) -> Dict[str, Any]:
    """A raised error as the tool's answer, so the model reads what went wrong instead of the run crashing."""
    if isinstance(e, UnbrowseError):
        named = isinstance(e.body, dict) and e.body.get("code") == "browser_missing"
        missing = named or type(e).__name__ == "BrowserMissingError" or e.code == "browser_missing" or bool(_NO_BROWSER.search(str(e)))
        out: Dict[str, Any] = {"error": str(e), "code": "browser_missing" if missing else e.code}
        if missing:
            out["hint"] = _browser_hint(e)
        return out
    return {"error": str(e), "code": "error"}


def _is_string_map(s: Optional[Dict[str, Any]]) -> bool:
    return bool(s) and s.get("type") == "object" and (s.get("additionalProperties") or {}).get("type") == "string"


def run_tool(node: UnbrowseNode, spec: Dict[str, Any], given: Optional[Dict[str, Any]]) -> Any:
    """Runs one tool against the node and answers what the MCP server would: the node's own JSON, in its snake case, or
    ``{"error", "code"}`` when the call fails. It never raises for a failed call."""
    try:
        props = spec["input_schema"]["properties"]
        args: Dict[str, Any] = {}
        for k, v in (given or {}).items():
            # Only the tool's own arguments; a model in non-strict mode may send None for one it leaves out.
            if k not in props or v is None:
                continue
            args[k] = {n: x if isinstance(x, str) else json.dumps(x) for n, x in v.items()} if _is_string_map(props[k]) and isinstance(v, dict) else v
        # As the MCP server answers a call missing an argument it needs.
        for k in spec["input_schema"].get("required", []):
            if args.get(k) in (None, ""):
                return {"error": f"{spec['name']} needs {k}", "code": "bad_request"}
        # And one of the argument sets the call takes one of in full (a goal, or an ask to collect): with none, the
        # first set's first missing name, as the MCP server says it.
        groups = spec.get("needs_one_of") or []
        if groups and not any(all(args.get(k) not in (None, "") for k in g) for g in groups):
            k = next(k for k in groups[0] if args.get(k) in (None, ""))
            return {"error": f"{spec['name']} needs {k}", "code": "bad_request"}
        # Every page this client opens is in its own session, as the MCP server keeps each client's: a session the
        # model names is one of this client's.
        if "session" in props:
            args["session"] = f"{node.session}:{args['session']}" if args.get("session") else node.session
        return node._primitive(spec["name"], args)
    except Exception as e:  # noqa: BLE001 - every failure is the tool's answer
        return tool_error(e)


def as_text(v: Any) -> str:
    """The answer as text, for frameworks whose tools answer a string."""
    return v if isinstance(v, str) else json.dumps(v)
