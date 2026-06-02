"""Shape tests for unbrowse_aiohttp. Plain python3, no pytest. Offline-deterministic.

Each test proves one slice of the aiohttp client surface under UNBROWSE_DRYRUN=1,
so no network is touched.
"""
import os
import sys
import asyncio

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import unbrowse_aiohttp as aiohttp  # noqa: E402


def _set_dryrun():
    os.environ["UNBROWSE_DRYRUN"] = "1"


def _clean_env():
    os.environ.pop("UNBROWSE_DRYRUN", None)


def test_session_get_dryrun():
    _set_dryrun()
    try:
        async def run():
            async with aiohttp.ClientSession() as s:
                async with s.get("https://example.com") as r:
                    assert r.status == 200
                    assert (await r.json()) == {"dryrun": True}
                    assert (await r.text()) == '{"dryrun": true}'
                    assert (await r.read()) == b'{"dryrun": true}'
                    assert r.url == "https://example.com"

        asyncio.run(run())
    finally:
        _clean_env()


def test_all_verbs_present():
    s = aiohttp.ClientSession()
    for m in ("get", "post", "put", "patch", "delete", "head", "request"):
        assert hasattr(s, m), "missing method %s" % m


def test_response_is_async_context_manager_and_awaitable():
    _set_dryrun()
    try:
        async def run():
            async with aiohttp.ClientSession() as s:
                # awaitable form: resp = await s.get(...)
                resp = await s.get("https://example.com")
                assert resp.status == 200
                # other verbs route fine under dryrun too
                async with s.post("https://example.com", json={"a": 1}) as r2:
                    assert r2.status == 200

        asyncio.run(run())
    finally:
        _clean_env()


def test_raise_for_status_and_exceptions():
    assert issubclass(aiohttp.ClientResponseError, aiohttp.ClientError)
    assert issubclass(aiohttp.ClientError, Exception)
    # a 500 response raises ClientResponseError
    r = aiohttp.__dict__["_Response"](500, b"err", {}, "https://x")
    try:
        r.raise_for_status()
        raise AssertionError("expected ClientResponseError")
    except aiohttp.ClientResponseError as e:
        assert e.status == 500
    # a 200 response does not raise
    aiohttp.__dict__["_Response"](200, b"ok", {}, "https://x").raise_for_status()


def test_client_timeout_accepts_total():
    t = aiohttp.ClientTimeout(total=5)
    assert t.total == 5


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
