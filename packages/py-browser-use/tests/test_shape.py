"""Shape parity tests for unbrowse_browser_use — plain python3, MUST pass OFFLINE.

Proves the shim provides browser-use's public Agent surface. Run:
    python3 packages/py-browser-use/tests/test_shape.py
"""
import os, sys, asyncio

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import unbrowse_browser_use as M


def test_exports_match_browser_use():
    for name in ("Agent", "AgentHistoryList", "Browser", "BrowserConfig", "Controller"):
        assert hasattr(M, name), f"missing {name}"


def test_agent_surface():
    a = M.Agent(task="get top hacker news story", llm=None)
    assert a.task == "get top hacker news story"
    assert hasattr(a, "run") and callable(a.run)
    assert hasattr(a, "run_sync") and callable(a.run_sync)


def test_agent_run_returns_history_shape():
    os.environ["UNBROWSE_BROWSER_USE_DRYRUN"] = "1"
    try:
        a = M.Agent(task="summarize quantum computing")
        hist = asyncio.run(a.run(max_steps=5))
        assert isinstance(hist, M.AgentHistoryList)
        # the exact methods browser-use callers use on the result
        for m in ("final_result", "is_done", "urls", "extracted_content", "errors", "model_actions"):
            assert hasattr(hist, m) and callable(getattr(hist, m)), m
        assert isinstance(hist.final_result(), str) and hist.final_result()
        assert hist.is_done() is True
        assert isinstance(hist.urls(), list)
        assert isinstance(hist.extracted_content(), list)
    finally:
        os.environ.pop("UNBROWSE_BROWSER_USE_DRYRUN", None)


def test_run_sync_path():
    os.environ["UNBROWSE_BROWSER_USE_DRYRUN"] = "1"
    try:
        hist = M.Agent(task="t").run_sync()
        assert isinstance(hist, M.AgentHistoryList) and hist.is_done()
    finally:
        os.environ.pop("UNBROWSE_BROWSER_USE_DRYRUN", None)


def test_browser_and_controller_surface():
    b = M.Browser(config=M.BrowserConfig(headless=True))
    assert b.config.headless is True
    assert hasattr(b, "close")
    asyncio.run(b.close())  # awaitable no-op
    c = M.Controller()
    # browser-use's @controller.action decorator must be a usable passthrough
    @c.action("describe", param_model=None)
    def my_action():
        return "ok"
    assert my_action() == "ok"
    assert "my_action" in c.actions


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print(f"PASS {fn.__name__}"); passed += 1
        except AssertionError as e:
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{passed}/{len(fns)} green")
    sys.exit(0 if passed == len(fns) else 1)
