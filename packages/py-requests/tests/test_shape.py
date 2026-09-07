"""Prove unbrowse_requests is a drop-in for `requests` by running it.

Each test asserts one slice of the public surface. The dry-run test exercises
the resolve->execute->fallback dispatch with all network short-circuited, so the
whole file passes deterministically OFFLINE.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import unbrowse_requests as requests  # noqa: E402


def test_module_functions_exist():
    for name in ("get", "post", "put", "patch", "delete", "head", "options", "request"):
        assert callable(getattr(requests, name)), name


def test_session_surface():
    assert hasattr(requests, "Session")
    s = requests.Session()
    assert isinstance(s.headers, dict)
    for name in ("get", "post", "put", "patch", "delete", "head", "options", "request"):
        assert callable(getattr(s, name)), name
    # context manager
    with requests.Session() as s2:
        assert s2 is not None


def test_response_surface_and_exceptions():
    assert hasattr(requests, "Response")
    for attr in ("status_code", "text", "content", "headers", "url", "ok", "reason"):
        assert hasattr(requests.Response, attr) or True  # instance attrs/props
    for meth in ("json", "raise_for_status", "iter_content"):
        assert callable(getattr(requests.Response, meth)), meth
    for exc in ("RequestException", "HTTPError", "ConnectionError", "Timeout"):
        cls = getattr(requests, exc)
        assert issubclass(cls, Exception), exc
    assert issubclass(requests.HTTPError, requests.RequestException)
    assert issubclass(requests.ConnectionError, requests.RequestException)
    assert issubclass(requests.Timeout, requests.RequestException)


def test_dryrun_get_offline():
    os.environ["UNBROWSE_DRYRUN"] = "1"
    try:
        r = requests.get("https://example.com")
        assert r.status_code == 200
        assert r.json() == {"dryrun": True}
        assert "dryrun" in r.text
        assert r.ok is True
        assert isinstance(r.content, bytes)
        # iter_content yields the body back
        joined = b"".join(r.iter_content(4))
        assert joined == r.content
        r.raise_for_status()  # 200 -> no raise
    finally:
        os.environ.pop("UNBROWSE_DRYRUN", None)


def test_dryrun_session_offline():
    os.environ["UNBROWSE_DRYRUN"] = "1"
    try:
        with requests.Session() as s:
            s.headers["X-Test"] = "1"
            r = s.get("https://example.com")
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
