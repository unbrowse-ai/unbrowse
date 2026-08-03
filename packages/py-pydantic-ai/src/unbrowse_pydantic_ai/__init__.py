"""unbrowse_pydantic_ai — native Unbrowse tools for Pydantic AI.

Three plain functions backed by the Unbrowse API (resolve / execute / search).
Works offline in dry-run mode (UNBROWSE_DRYRUN=1). Register them with Pydantic
AI via `create_unbrowse_tools(Tool)` (passing `pydantic_ai.Tool`), or use the
exported plain functions directly with `agent.tool` / `Tool(...)`.
"""
import os, json, urllib.request

__all__ = [
    "unbrowse_tools",
    "unbrowse_resolve",
    "unbrowse_execute",
    "unbrowse_search",
    "create_unbrowse_tools",
]


# ---- shared backend helper -------------------------------------------------
def _base():
    return os.environ.get("UNBROWSE_API_URL") or os.environ.get("UNBROWSE_BASE") or "https://beta-api.unbrowse.ai"


def _auth():
    h = {"content-type": "application/json"}
    k = os.environ.get("UNBROWSE_API_KEY")
    if k:
        h["authorization"] = "Bearer " + k
    x = os.environ.get("UNBROWSE_X_PAYMENT") or os.environ.get("X_PAYMENT")
    if x:
        h["x-payment"] = x
    return h


def _post(path, payload, timeout=30):
    req = urllib.request.Request(_base() + path, data=json.dumps(payload).encode(), headers=_auth(), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _resolve(url, intent):
    try:
        return _post("/v1/resolve", {"url": url, "intent": intent}, 8)
    except Exception:
        return None


def _execute(eid, params=None):
    try:
        return _post("/v1/execute", {"endpoint_id": eid, "params": params or {}, "raw": True})
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _top_id(res):
    lst = (res or {}).get("available_operations") or (res or {}).get("available_endpoints") or []
    return lst[0].get("endpoint_id") if lst else None


def _dryrun():
    return os.environ.get("UNBROWSE_DRYRUN") == "1"


# ---- tool functions (plain callables for Pydantic AI) ----------------------
def unbrowse_resolve(url: str, intent: str) -> str:
    """Resolve a URL plus an intent to a ranked Unbrowse API endpoint shortlist. Returns a JSON string."""
    if _dryrun():
        return json.dumps({"dryrun": True, "tool": "unbrowse_resolve"})
    return json.dumps(_resolve(url, intent))


def unbrowse_execute(endpoint_id: str, params=None) -> str:
    """Execute a resolved Unbrowse endpoint by endpoint_id with optional params. Returns a JSON string."""
    if _dryrun():
        return json.dumps({"dryrun": True, "tool": "unbrowse_execute"})
    return json.dumps(_execute(endpoint_id, params))


def unbrowse_search(query: str, url=None) -> str:
    """Search via Unbrowse: resolve the query as intent, pick the top endpoint, and execute it. Returns a JSON string."""
    if _dryrun():
        return json.dumps({"dryrun": True, "tool": "unbrowse_search"})
    res = _resolve(url or "", query)
    eid = _top_id(res)
    if not eid:
        return json.dumps({"ok": False, "error": "no endpoint resolved", "resolve": res})
    return json.dumps(_execute(eid))


_SPECS = [
    {
        "name": "unbrowse_resolve",
        "description": "Resolve a URL plus an intent to a ranked Unbrowse API endpoint shortlist. Returns JSON.",
        "function": unbrowse_resolve,
    },
    {
        "name": "unbrowse_execute",
        "description": "Execute a resolved Unbrowse endpoint by endpoint_id with optional params. Returns JSON.",
        "function": unbrowse_execute,
    },
    {
        "name": "unbrowse_search",
        "description": "Search via Unbrowse: resolve the query as intent, pick the top endpoint, and execute it. Returns JSON.",
        "function": unbrowse_search,
    },
]

unbrowse_tools = [dict(s) for s in _SPECS]


# ---- factory: wrap Pydantic AI's real Tool ---------------------------------
def create_unbrowse_tools(Tool):
    """Given Pydantic AI's real `pydantic_ai.Tool`, return a list of
    `Tool(fn, name=..., description=...)` instances."""
    return [Tool(s["function"], name=s["name"], description=s["description"]) for s in _SPECS]
