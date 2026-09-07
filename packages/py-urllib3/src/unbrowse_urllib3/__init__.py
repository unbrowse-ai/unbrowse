"""unbrowse_urllib3 — a drop-in for urllib3.

`import unbrowse_urllib3 as urllib3` and your existing code keeps working. GET
requests are routed through Unbrowse's resolve -> execute API when a cached
endpoint matches; everything else falls back to pure-stdlib urllib.request. No
third-party dependencies.
"""
import os
import json
import urllib.parse
import urllib.request
import urllib.error

# ---------------------------------------------------------------------------
# Shared Unbrowse backend helper (pure stdlib)
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Warnings shim
# ---------------------------------------------------------------------------


def disable_warnings(*args, **kwargs):
    """No-op; provided for surface compatibility."""
    return None


# ---------------------------------------------------------------------------
# HTTPResponse
# ---------------------------------------------------------------------------


class HTTPResponse:
    def __init__(self, status, data, headers, url):
        self.status = int(status)
        self.data = data if isinstance(data, (bytes, bytearray)) else (data or "").encode()
        self.headers = dict(headers or {})
        self._url = url
        self.decode_content = True

    def read(self, *args, **kwargs):
        return bytes(self.data)

    def json(self):
        return json.loads(self.data.decode("utf-8", "replace"))

    def geturl(self):
        return self._url


# ---------------------------------------------------------------------------
# Core fetch
# ---------------------------------------------------------------------------


def _synthetic_dryrun(url):
    return HTTPResponse(200, b'{"dryrun": true}', {"content-type": "application/json"}, url)


def _native(method, url, headers=None, body=None, timeout=30):
    if isinstance(body, str):
        body = body.encode()
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return HTTPResponse(r.getcode(), r.read(), dict(r.headers), url)
    except urllib.error.HTTPError as e:
        return HTTPResponse(e.code, e.read(), dict(e.headers or {}), url)


def _request(method, url, fields=None, headers=None, body=None, timeout=30, **kw):
    if _dryrun():
        return _synthetic_dryrun(url)
    if method.upper() == "GET":
        # urllib3 puts GET `fields` into the query string
        target = url
        if fields:
            sep = "&" if ("?" in url) else "?"
            target = url + sep + urllib.parse.urlencode(fields)
        res = _resolve(target, "GET " + target)
        eid = _top_id(res)
        if eid:
            out = _execute(eid)
            if out and out.get("ok") is not False:
                payload = out.get("body")
                if payload is None:
                    payload = json.dumps(out)
                if not isinstance(payload, (str, bytes, bytearray)):
                    payload = json.dumps(payload)
                status = out.get("status") or 200
                return HTTPResponse(status, payload, out.get("headers") or {"content-type": "application/json"}, target)
        return _native("GET", target, headers=headers, timeout=timeout)
    # non-GET -> native (fields encoded as form body if no explicit body)
    if body is None and fields:
        body = urllib.parse.urlencode(fields).encode()
    return _native(method, url, headers=headers, body=body, timeout=timeout)


# ---------------------------------------------------------------------------
# PoolManager
# ---------------------------------------------------------------------------


class PoolManager:
    def __init__(self, *args, **kwargs):
        self._headers = dict(kwargs.get("headers") or {})

    def request(self, method, url, fields=None, headers=None, body=None, **kw):
        merged = dict(self._headers)
        merged.update(headers or {})
        timeout = kw.pop("timeout", 30)
        if not isinstance(timeout, (int, float)):
            timeout = 30
        return _request(method, url, fields=fields, headers=merged, body=body, timeout=timeout)

    def clear(self):
        return None


# ---------------------------------------------------------------------------
# Top-level request (urllib3 2.x style)
# ---------------------------------------------------------------------------


def request(method, url, **kw):
    return PoolManager().request(method, url, **kw)


__all__ = [
    "PoolManager",
    "HTTPResponse",
    "request",
    "disable_warnings",
]
