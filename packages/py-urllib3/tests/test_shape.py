"""Shape tests for unbrowse_urllib3. Plain python3, no pytest. Offline-deterministic.

Each test proves one slice of the urllib3 surface under UNBROWSE_DRYRUN=1, so no
network is touched.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import unbrowse_urllib3 as urllib3  # noqa: E402


def _set_dryrun():
    os.environ["UNBROWSE_DRYRUN"] = "1"


def _clean_env():
    os.environ.pop("UNBROWSE_DRYRUN", None)


def test_poolmanager_get_dryrun():
    _set_dryrun()
    try:
        resp = urllib3.PoolManager().request("GET", "https://example.com")
        assert resp.status == 200
        assert resp.json() == {"dryrun": True}
        assert resp.data == b'{"dryrun": true}'
        assert resp.read() == b'{"dryrun": true}'
        assert isinstance(resp.headers, dict)
        assert resp.geturl() == "https://example.com"
    finally:
        _clean_env()


def test_top_level_request_dryrun():
    _set_dryrun()
    try:
        resp = urllib3.request("GET", "https://example.com")
        assert resp.status == 200
        assert resp.json() == {"dryrun": True}
    finally:
        _clean_env()


def test_poolmanager_accepts_arbitrary_kwargs():
    pm = urllib3.PoolManager(num_pools=10, maxsize=5, cert_reqs="CERT_REQUIRED", retries=3)
    assert hasattr(pm, "request")


def test_disable_warnings_is_noop():
    assert urllib3.disable_warnings() is None
    assert urllib3.disable_warnings("anything") is None


def test_httpresponse_surface():
    r = urllib3.HTTPResponse(200, b'{"a": 1}', {"content-type": "application/json"}, "https://x")
    assert r.status == 200
    assert r.data == b'{"a": 1}'
    assert r.json() == {"a": 1}
    assert r.read() == b'{"a": 1}'
    assert r.geturl() == "https://x"
    assert r.decode_content is True


def test_non_get_under_dryrun():
    _set_dryrun()
    try:
        resp = urllib3.PoolManager().request("POST", "https://example.com", fields={"k": "v"})
        assert resp.status == 200
        assert resp.json() == {"dryrun": True}
    finally:
        _clean_env()


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
