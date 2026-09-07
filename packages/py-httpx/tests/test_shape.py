"""Prove unbrowse_httpx is a drop-in for `httpx` by running it.

Each test asserts one slice of the public surface. The dry-run test exercises
the resolve->execute->fallback dispatch with all network short-circuited, so the
whole file passes deterministically OFFLINE.
"""
import asyncio
import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import unbrowse_httpx as httpx  # noqa: E402


def test_module_functions_exist():
    for name in ("get", "post", "put", "patch", "delete", "head", "options", "request"):
        assert callable(getattr(httpx, name)), name


def test_client_surface():
    assert hasattr(httpx, "Client")
    c = httpx.Client()
    assert isinstance(c.headers, dict)
    for name in ("get", "post", "put", "patch", "delete", "head", "options", "request"):
        assert callable(getattr(c, name)), name
    with httpx.Client() as c2:
        assert c2 is not None


def test_async_client_surface():
    assert hasattr(httpx, "AsyncClient")
    ac = httpx.AsyncClient()
    assert isinstance(ac.headers, dict)
    for name in ("get", "post", "put", "patch", "delete", "head", "options", "request"):
        assert callable(getattr(ac, name)), name
    assert inspect.iscoroutinefunction(ac.get)


def test_response_codes_and_exceptions():
    assert hasattr(httpx, "Response")
    for meth in ("json", "raise_for_status"):
        assert callable(getattr(httpx.Response, meth)), meth
    assert httpx.codes.OK == 200
    for exc in ("HTTPError", "RequestError", "HTTPStatusError"):
        cls = getattr(httpx, exc)
        assert issubclass(cls, Exception), exc


def test_dryrun_get_offline():
    os.environ["UNBROWSE_DRYRUN"] = "1"
    try:
        r = httpx.get("https://example.com")
        assert r.status_code == 200
        assert r.json() == {"dryrun": True}
        assert "dryrun" in r.text
        assert isinstance(r.content, bytes)
        assert r.raise_for_status() is r  # 200 -> no raise, returns self
    finally:
        os.environ.pop("UNBROWSE_DRYRUN", None)


def test_dryrun_async_client_offline():
    os.environ["UNBROWSE_DRYRUN"] = "1"

    async def go():
        async with httpx.AsyncClient() as client:
            return await client.get("https://example.com")

    try:
        r = asyncio.get_event_loop().run_until_complete(go()) \
            if sys.version_info < (3, 10) else asyncio.run(go())
        assert r.status_code == 200
        assert r.json() == {"dryrun": True}
    finally:
        os.environ.pop("UNBROWSE_DRYRUN", None)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print("PASS %s" % fn.__name__)
            passed += 1
        except AssertionError as e:
            print("FAIL %s: %s" % (fn.__name__, e))
        except Exception as e:
            print("ERROR %s: %s: %s" % (fn.__name__, type(e).__name__, e))
    print("\n%d/%d green" % (passed, len(fns)))
    sys.exit(0 if passed == len(fns) else 1)
