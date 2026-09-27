import pytest

from conftest import load_plugin_package

guard_mod = __import__(load_plugin_package().__name__ + ".guard", fromlist=["x"])


def make_guard(settings=None, active=True, backend="", env=None):
    cfg = {"block_browser": True, "block_web_extract": "auto", "block_web_search": False, **(settings or {})}
    env = env or {}
    return guard_mod.BrowserGuard(lambda: cfg, lambda: active, lambda: backend, env.get)


def blocked(result):
    return isinstance(result, dict) and result.get("action") == "block" and bool(result.get("message"))


@pytest.mark.parametrize("url", [
    "https://x.com", "http://example.com/a", "x.com", "https://8.8.8.8/", "https://news.ycombinator.com/item?id=1",
])
def test_blocks_public_navigation(url):
    res = make_guard().check("browser_navigate", {"url": url}, task_id="t")
    assert blocked(res)
    assert "unbrowse_scrape" in res["message"] and "unbrowse_discover" in res["message"]
    assert "unbrowse_browse_open" in res["message"]


@pytest.mark.parametrize("url", [
    "http://localhost:3000", "http://127.0.0.1:8080/x", "http://[::1]/", "http://0.0.0.0:5173", "http://10.1.2.3",
    "http://192.168.1.5/admin", "http://172.20.0.4", "http://169.254.169.254/", "http://myapp.localhost",
    "http://printer.local", "http://intranet", "file:///tmp/a.html", "about:blank", "data:text/html,hi",
])
def test_allows_local_navigation(url):
    assert make_guard().check("browser_navigate", {"url": url}, task_id="t") is None


def test_message_carries_url_for_scrape():
    res = make_guard().check("browser_navigate", {"url": "https://x.com/home"}, task_id="t")
    assert '{"url": "https://x.com/home"}' in res["message"]


def test_opt_out_env():
    g = make_guard(env={"UNBROWSE_ALLOW_BUILTIN_BROWSER": "1"})
    assert g.check("browser_navigate", {"url": "https://x.com"}, task_id="t") is None
    assert g.check("browser_click", {"ref": "@e1"}, task_id="t") is None
    assert g.check("web_extract", {"urls": ["https://x.com"]}, task_id="t") is None
    assert blocked(make_guard(env={"UNBROWSE_ALLOW_BUILTIN_BROWSER": "0"}).check(
        "browser_navigate", {"url": "https://x.com"}, task_id="t"))


def test_inactive_without_key():
    g = make_guard(active=False)
    assert g.check("browser_navigate", {"url": "https://x.com"}, task_id="t") is None


def test_setting_turns_browser_block_off():
    g = make_guard({"block_browser": False})
    assert g.check("browser_navigate", {"url": "https://x.com"}, task_id="t") is None


def test_follow_up_tools_track_task_navigation():
    g = make_guard()
    assert blocked(g.check("browser_snapshot", {}, task_id="a"))  # nothing local opened yet
    assert g.check("browser_navigate", {"url": "http://localhost:3000"}, task_id="a") is None
    assert g.check("browser_click", {"ref": "@e3"}, task_id="a") is None
    assert g.check("browser_snapshot", {}, task_id="a") is None
    assert blocked(g.check("browser_click", {"ref": "@e3"}, task_id="b"))  # other task
    assert blocked(g.check("browser_navigate", {"url": "https://x.com"}, task_id="a"))
    assert blocked(g.check("browser_click", {"ref": "@e3"}, task_id="a"))  # last navigation was public


def test_task_memory_is_bounded():
    g = guard_mod.BrowserGuard(lambda: {}, lambda: True, lambda: "", {}.get, max_tasks=3)
    for i in range(10):
        g.check("browser_navigate", {"url": "http://localhost"}, task_id=f"t{i}")
    assert len(g._local_task) == 3
    assert g.check("browser_click", {}, task_id="t9") is None
    assert blocked(g.check("browser_click", {}, task_id="t0"))


def test_browser_exec_scans_code_for_urls():
    g = make_guard()
    assert blocked(g.check("browser_exec", {"code": "goto('https://x.com/login')"}, task_id="e"))
    assert g.check("browser_exec", {"code": "goto('http://localhost:8080')"}, task_id="e") is None
    assert blocked(g.check("browser_exec", {"code": "print(page.title())"}, task_id="fresh"))


def test_web_extract_auto_mode():
    assert blocked(make_guard().check("web_extract", {"urls": ["https://example.com"]}, task_id="t"))
    assert make_guard(backend="unbrowse").check("web_extract", {"urls": ["https://example.com"]}, task_id="t") is None
    assert make_guard().check("web_extract", {"urls": ["http://localhost/a"]}, task_id="t") is None
    assert make_guard({"block_web_extract": "false"}).check("web_extract", {"urls": ["https://e.com"]}, task_id="t") is None
    assert blocked(make_guard({"block_web_extract": "true"}, backend="unbrowse").check(
        "web_extract", {"urls": ["https://e.com"]}, task_id="t"))
    res = make_guard().check("web_extract", {"urls": "https://example.com"}, task_id="t")
    assert blocked(res) and "web.extract_backend: unbrowse" in res["message"]


def test_web_search_opt_in():
    assert make_guard().check("web_search", {"query": "q"}, task_id="t") is None
    assert blocked(make_guard({"block_web_search": True}).check("web_search", {"query": "q"}, task_id="t"))


def test_other_tools_untouched_and_never_raises():
    g = make_guard()
    assert g.check("terminal", {"command": "curl https://x.com"}, task_id="t") is None
    assert g.check("unbrowse_scrape", {"url": "https://x.com"}, task_id="t") is None
    broken = guard_mod.BrowserGuard(lambda: 1 / 0, lambda: True, lambda: "", {}.get)
    assert broken.check("browser_navigate", {"url": "https://x.com"}, task_id="t") is None
    assert g.check("browser_navigate", None) is None  # no URL: nothing public to route; Hermes rejects it itself
