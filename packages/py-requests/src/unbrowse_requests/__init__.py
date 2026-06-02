"""unbrowse_requests — a zero-edit drop-in for the ``requests`` library.

    - import requests
    + import unbrowse_requests as requests

A safe GET first routes through Unbrowse's resolve+execute marketplace cache
(``/v1/resolve`` then ``/v1/execute``); on a hit the upstream ``Response`` is
synthesized from the cached body for free. A miss, any non-GET method, or
``UNBROWSE_REQUESTS_PASSTHROUGH=1`` falls back to a pure-stdlib
``urllib.request`` call — no third-party install needed. Semantics of the
``requests`` surface are preserved; the shim only lowers cost on cache hits.

Attribution: mirrors the public surface of ``requests``
(https://github.com/psf/requests, Apache-2.0). The shim itself is MIT.
"""
import os
import json
import urllib.request
import urllib.parse
import urllib.error

# ---------------------------------------------------------------------------
# Shared Unbrowse backend helper (identical across unbrowse_requests / _httpx)
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
# Internals
# ---------------------------------------------------------------------------

_REASONS = {200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently",
            302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized",
            403: "Forbidden", 404: "Not Found", 500: "Internal Server Error",
            502: "Bad Gateway", 503: "Service Unavailable"}


def _passthrough():
    return os.environ.get("UNBROWSE_REQUESTS_PASSTHROUGH") == "1"


def _intent_for(url):
    try:
        u = urllib.parse.urlparse(url)
        parts = [p for p in u.path.split("/") if p]
        if parts:
            return "fetch %s from %s" % (" ".join(parts[-2:]), u.hostname)
        return "fetch homepage of %s" % u.hostname
    except Exception:
        return "fetch resource"


def _build_url(url, params):
    if not params:
        return url
    qs = urllib.parse.urlencode({k: str(v) for k, v in params.items()})
    return url + ("&" if "?" in url else "?") + qs


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class RequestException(Exception):
    pass


class HTTPError(RequestException):
    pass


class ConnectionError(RequestException):
    pass


class Timeout(RequestException):
    pass


# ---------------------------------------------------------------------------
# Response
# ---------------------------------------------------------------------------


class Response(object):
    def __init__(self, status_code, content, headers, url, reason=None):
        self.status_code = int(status_code)
        if isinstance(content, str):
            content = content.encode("utf-8")
        self.content = content or b""
        self.headers = dict(headers or {})
        self.url = url
        self.reason = reason if reason is not None else _REASONS.get(self.status_code, "")

    @property
    def text(self):
        try:
            return self.content.decode("utf-8")
        except Exception:
            return self.content.decode("utf-8", "replace")

    @property
    def ok(self):
        return self.status_code < 400

    def json(self, **kw):
        return json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise HTTPError("%s Error for url: %s" % (self.status_code, self.url))
        return None

    def iter_content(self, chunk_size=1):
        data = self.content
        if chunk_size is None or chunk_size <= 0:
            chunk_size = len(data) or 1
        for i in range(0, len(data), chunk_size):
            yield data[i:i + chunk_size]

    def __repr__(self):
        return "<Response [%d]>" % self.status_code


# ---------------------------------------------------------------------------
# Core dispatch
# ---------------------------------------------------------------------------


def _synth_from_exec(exec_res, url):
    body = exec_res.get("body")
    if isinstance(body, (dict, list)):
        body = json.dumps(body)
        ct = "application/json"
    else:
        ct = "text/html; charset=utf-8"
    return Response(200, body, {"content-type": ct, "x-unbrowse-source": "marketplace-cache"}, url)


def _native(method, url, headers, body, timeout):
    data = None
    if body is not None:
        data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            hdrs = {k: v for k, v in r.headers.items()}
            return Response(r.getcode(), raw, hdrs, url, reason=r.reason)
    except urllib.error.HTTPError as e:
        raw = e.read()
        hdrs = {k: v for k, v in (e.headers.items() if e.headers else [])}
        return Response(e.code, raw, hdrs, url, reason=getattr(e, "reason", None))
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, (TimeoutError,)) or "timed out" in str(reason).lower():
            raise Timeout(str(reason))
        raise ConnectionError(str(reason))


def _dispatch(method, url, params=None, headers=None, json_body=None, data=None, timeout=30):
    method = (method or "GET").upper()
    full = _build_url(url, params)

    if _dryrun():
        return Response(200, '{"dryrun": true}', {"content-type": "application/json"}, full)

    hdrs = dict(headers or {})
    body = None
    if json_body is not None:
        body = json.dumps(json_body)
        hdrs.setdefault("Content-Type", "application/json")
    elif data is not None:
        if isinstance(data, dict):
            body = urllib.parse.urlencode(data)
            hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:
            body = data

    if method == "GET" and not _passthrough():
        resolved = _resolve(full, _intent_for(full))
        eid = _top_id(resolved)
        if eid:
            exec_res = _execute(eid)
            if exec_res and exec_res.get("ok") and exec_res.get("body") is not None:
                return _synth_from_exec(exec_res, full)

    return _native(method, full, hdrs, body, timeout)


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


def request(method, url, **kw):
    return _dispatch(
        method, url,
        params=kw.get("params"),
        headers=kw.get("headers"),
        json_body=kw.get("json"),
        data=kw.get("data"),
        timeout=kw.get("timeout", 30),
    )


def get(url, **kw):
    return request("GET", url, **kw)


def post(url, **kw):
    return request("POST", url, **kw)


def put(url, **kw):
    return request("PUT", url, **kw)


def patch(url, **kw):
    return request("PATCH", url, **kw)


def delete(url, **kw):
    return request("DELETE", url, **kw)


def head(url, **kw):
    return request("HEAD", url, **kw)


def options(url, **kw):
    return request("OPTIONS", url, **kw)


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------


class Session(object):
    def __init__(self):
        self.headers = {}

    def _merge_headers(self, kw):
        merged = dict(self.headers)
        merged.update(kw.get("headers") or {})
        kw = dict(kw)
        kw["headers"] = merged
        return kw

    def request(self, method, url, **kw):
        return request(method, url, **self._merge_headers(kw))

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)

    def put(self, url, **kw):
        return self.request("PUT", url, **kw)

    def patch(self, url, **kw):
        return self.request("PATCH", url, **kw)

    def delete(self, url, **kw):
        return self.request("DELETE", url, **kw)

    def head(self, url, **kw):
        return self.request("HEAD", url, **kw)

    def options(self, url, **kw):
        return self.request("OPTIONS", url, **kw)

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


__all__ = [
    "get", "post", "put", "patch", "delete", "head", "options", "request",
    "Session", "Response",
    "RequestException", "HTTPError", "ConnectionError", "Timeout",
]
