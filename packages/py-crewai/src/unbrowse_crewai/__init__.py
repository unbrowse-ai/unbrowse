"""unbrowse_crewai — native Unbrowse tools for CrewAI.

Three tools backed by the Unbrowse API (resolve / execute / search). Works
offline in dry-run mode (UNBROWSE_DRYRUN=1). If `crewai` is installed, use
`create_unbrowse_tools(BaseTool)` to get real CrewAI tools; otherwise the
exported instances use a local minimal base so the module imports with no
third-party dependency.
"""
import os, json, urllib.request

__all__ = [
    "unbrowse_tools",
    "unbrowse_resolve_tool",
    "unbrowse_execute_tool",
    "unbrowse_search_tool",
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


# ---- tool behaviors --------------------------------------------------------
def _do_resolve(url, intent):
    if _dryrun():
        return json.dumps({"dryrun": True, "tool": "unbrowse_resolve"})
    return json.dumps(_resolve(url, intent))


def _do_execute(endpoint_id, params=None):
    if _dryrun():
        return json.dumps({"dryrun": True, "tool": "unbrowse_execute"})
    return json.dumps(_execute(endpoint_id, params))


def _do_search(query, url=None):
    if _dryrun():
        return json.dumps({"dryrun": True, "tool": "unbrowse_search"})
    res = _resolve(url or "", query)
    eid = _top_id(res)
    if not eid:
        return json.dumps({"ok": False, "error": "no endpoint resolved", "resolve": res})
    return json.dumps(_execute(eid))


# ---- _run impls (signature-compatible with CrewAI BaseTool._run) -----------
def _run_resolve(self=None, **kwargs):
    return _do_resolve(kwargs.get("url", ""), kwargs.get("intent", ""))


def _run_execute(self=None, **kwargs):
    return _do_execute(kwargs.get("endpoint_id", ""), kwargs.get("params"))


def _run_search(self=None, **kwargs):
    return _do_search(kwargs.get("query", ""), kwargs.get("url"))


_SPECS = [
    {
        "name": "unbrowse_resolve",
        "description": "Resolve a URL plus an intent to a ranked Unbrowse API endpoint shortlist. Returns JSON.",
        "_run": _run_resolve,
    },
    {
        "name": "unbrowse_execute",
        "description": "Execute a resolved Unbrowse endpoint by endpoint_id with optional params. Returns JSON.",
        "_run": _run_execute,
    },
    {
        "name": "unbrowse_search",
        "description": "Search via Unbrowse: resolve the query as intent, pick the top endpoint, and execute it. Returns JSON.",
        "_run": _run_search,
    },
]


# ---- local minimal base (crewai not installed) -----------------------------
class _BaseTool:
    name = ""
    description = ""

    def run(self, **kw):
        return self._run(**kw)


def _make_instance(spec):
    cls = type(
        "UnbrowseTool_" + spec["name"],
        (_BaseTool,),
        {
            "name": spec["name"],
            "description": spec["description"],
            "_run": staticmethod(spec["_run"]),
        },
    )
    return cls()


unbrowse_resolve_tool = _make_instance(_SPECS[0])
unbrowse_execute_tool = _make_instance(_SPECS[1])
unbrowse_search_tool = _make_instance(_SPECS[2])

unbrowse_tools = [unbrowse_resolve_tool, unbrowse_execute_tool, unbrowse_search_tool]


# ---- factory: wrap CrewAI's real BaseTool ----------------------------------
def create_unbrowse_tools(BaseTool):
    """Given CrewAI's real `crewai.tools.BaseTool`, return 3 subclassed tools
    wrapping the same `_run` impls."""
    out = []
    for spec in _SPECS:
        cls = type(
            "UnbrowseTool_" + spec["name"],
            (BaseTool,),
            {
                "name": spec["name"],
                "description": spec["description"],
                "_run": staticmethod(spec["_run"]),
            },
        )
        try:
            out.append(cls())
        except Exception:
            # Some pydantic-backed bases require field defaults at init; pass them.
            out.append(cls(name=spec["name"], description=spec["description"]))
    return out
