"""unbrowse_browser_use — a drop-in for `browser-use`, backed by Unbrowse.

Swap the import and keep your agent code:

    # from browser_use import Agent
    from unbrowse_browser_use import Agent

    agent = Agent(task="get the top story on hacker news", llm=my_llm)
    history = await agent.run()
    print(history.final_result())

It mirrors browser-use's public surface — `Agent(task, llm=...)`, `await
agent.run()`, an `AgentHistoryList` with `.final_result()/.is_done()/.urls()/
.extracted_content()/.errors()`, plus `Browser`, `BrowserConfig`, `Controller` —
but instead of driving a live browser step-by-step with an LLM on every task, it
resolves the task against the Unbrowse shared route graph and replays the cached
API route when one exists (falling back to live capture only on a miss). Same
agent code; the work happens on Unbrowse's side.

Offline shape mode: `UNBROWSE_BROWSER_USE_DRYRUN=1`.

Not affiliated with or endorsed by the browser-use project; `browser-use` is the
upstream this package is a drop-in for. Trademarks belong to their owners.
"""
import os
import json
import asyncio
import urllib.request

__all__ = ["Agent", "AgentHistoryList", "Browser", "BrowserConfig", "Controller"]


# ---- browser-use-shaped result --------------------------------------------
class AgentHistoryList:
    """Mirrors browser_use AgentHistoryList: what you read off `await agent.run()`."""

    def __init__(self, result="", done=True, urls=None, errors=None, actions=None):
        self._result = result
        self._done = done
        self._urls = urls or []
        self._errors = errors or []
        self._actions = actions or []

    def final_result(self):
        return self._result

    def is_done(self):
        return self._done

    def urls(self):
        return self._urls

    def extracted_content(self):
        return [self._result] if self._result else []

    def errors(self):
        return self._errors

    def model_actions(self):
        return self._actions

    def __repr__(self):
        return f"AgentHistoryList(done={self._done}, result={self._result!r:.60})"


# ---- minimal browser-use surface objects ----------------------------------
class BrowserConfig:
    def __init__(self, headless=True, **kwargs):
        self.headless = headless
        self.__dict__.update(kwargs)


class Browser:
    def __init__(self, config=None, **kwargs):
        self.config = config or BrowserConfig(**kwargs)

    async def close(self):
        return None

    async def new_context(self, *a, **k):
        return self


class Controller:
    def __init__(self, *a, **k):
        self.actions = {}

    def action(self, *a, **k):
        # browser-use's @controller.action decorator — no-op passthrough
        def deco(fn):
            self.actions[getattr(fn, "__name__", "action")] = fn
            return fn
        return deco


# ---- Unbrowse backend ------------------------------------------------------
def _base():
    return (os.environ.get("UNBROWSE_API_URL")
            or os.environ.get("UNBROWSE_BASE")
            or "https://beta-api.unbrowse.ai")


def _auth():
    h = {"content-type": "application/json"}
    k = os.environ.get("UNBROWSE_API_KEY")
    if k:
        h["authorization"] = "Bearer " + k
    return h


def _post(path, payload, timeout=60):
    req = urllib.request.Request(_base() + path, data=json.dumps(payload).encode(),
                                 headers=_auth(), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _dryrun():
    return (os.environ.get("UNBROWSE_BROWSER_USE_DRYRUN") == "1"
            or os.environ.get("UNBROWSE_DRYRUN") == "1")


def _run_task(task, url):
    """Resolve the task as an intent and replay the top endpoint (route replay),
    returning (result_text, urls). Honest: returns the error text on failure."""
    try:
        res = _post("/v1/resolve", {"url": url or "", "intent": task}, 12)
    except Exception as e:
        return (f"resolve failed: {e}", [])
    ops = (res or {}).get("available_operations") or (res or {}).get("available_endpoints") or []
    if not ops:
        return (json.dumps(res) if res else "no route resolved", [])
    eid = ops[0].get("endpoint_id")
    urls = [o.get("url") for o in ops if o.get("url")]
    try:
        out = _post("/v1/execute", {"endpoint_id": eid, "params": {}, "raw": True})
        return (json.dumps(out), urls)
    except Exception as e:
        return (f"execute failed: {e}", urls)


# ---- the browser-use-compatible Agent -------------------------------------
class Agent:
    """Drop-in for `browser_use.Agent`, backed by Unbrowse route resolve+replay."""

    def __init__(self, task=None, llm=None, browser=None, controller=None,
                 url=None, use_vision=False, **kwargs):
        self.task = task
        self.llm = llm
        self.browser = browser
        self.controller = controller
        self.url = url
        self._kwargs = kwargs

    async def run(self, max_steps=100, **kwargs):
        if _dryrun():
            return AgentHistoryList(
                result=f"[dryrun] completed task: {self.task}",
                done=True, urls=["https://example.com"],
                actions=[{"task": self.task, "max_steps": max_steps}],
            )
        result, urls = await asyncio.to_thread(_run_task, self.task or "", self.url)
        return AgentHistoryList(result=result, done=True, urls=urls)

    def run_sync(self, max_steps=100, **kwargs):
        """Convenience for callers not in an event loop."""
        return asyncio.run(self.run(max_steps=max_steps, **kwargs))
