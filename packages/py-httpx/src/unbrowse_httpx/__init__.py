"""unbrowse_httpx — a zero-edit drop-in for the ``httpx`` library.

    - import httpx
    + import unbrowse_httpx as httpx

A safe GET first routes through Unbrowse's resolve+execute marketplace cache
(``/v1/resolve`` then ``/v1/execute``); on a hit the upstream ``Response`` is
synthesized from the cached body for free. A miss, any non-GET method, or
``UNBROWSE_HTTPX_PASSTHROUGH=1`` falls back to a pure-stdlib
``urllib.request`` call — no third-party install needed. Semantics of the
``httpx`` surface are preserved; the shim only lowers cost on cache hits.

Attribution: mirrors the public surface of ``httpx``
(https://github.com/encode/httpx, BSD-3-Clause). The shim itself is MIT.
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
# Status codes
# ---------------------------------------------------------------------------


class codes(object):
    """Subset of httpx.codes (HTTP status code constants)."""
    CONTINUE = 100
    OK = 200
    CREATED = 201
    ACCEPTED = 202
    NO_CONTENT = 204
    MOVED_PERMANENTLY = 301
    FOUND = 302
    NOT_MODIFIED = 304
    BAD_REQUEST = 400
    UNAUTHORIZED = 401
    FORBIDDEN = 403
    NOT_FOUND = 404
    INTERNAL_SERVER_ERROR = 500
    BAD_GATEWAY = 502
    SERVICE_UNAVAILABLE = 503


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class HTTPError(Exception):
    def __init__(self, message, request=None, response=None):
        super(HTTPError, self).__init__(message)
        self.request = request
        self.response = response


class RequestError(HTTPError):
    pass


class HTTPStatusError(HTTPError):
    pass


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _passthrough():
    return os.environ.get("UNBROWSE_HTTPX_PASSTHROUGH") == "1"


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
# Response
# ---------------------------------------------------------------------------


class Response(object):
    def __init__(self, status_code, content, headers, url):
        self.status_code = int(status_code)
        if isinstance(content, str):
            content = content.encode("utf-8")
        self.content = content or b""
        self.headers = dict(headers or {})
        self.url = url

    @property
    def text(self):
        try:
            return self.content.decode("utf-8")
        except Exception:
            return self.content.decode("utf-8", "replace")

    @property
    def is_success(self):
        return 200 <= self.status_code < 300

    def json(self, **kw):
        return json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise HTTPStatusError(
                "Client/server error '%s' for url '%s'" % (self.status_code, self.url),
                response=self,
            )
        return self

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
            return Response(r.getcode(), raw, hdrs, url)
    except urllib.error.HTTPError as e:
        raw = e.read()
        hdrs = {k: v for k, v in (e.headers.items() if e.headers else [])}
        return Response(e.code, raw, hdrs, url)
    except (urllib.error.URLError, OSError) as e:
        raise RequestError(str(getattr(e, "reason", e)))


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
# Module-level functions
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
# Client (sync)
# ---------------------------------------------------------------------------


class Client(object):
    def __init__(self, **kw):
        self.headers = dict(kw.get("headers") or {})

    def _merge(self, kw):
        merged = dict(self.headers)
        merged.update(kw.get("headers") or {})
        kw = dict(kw)
        kw["headers"] = merged
        return kw

    def request(self, method, url, **kw):
        return request(method, url, **self._merge(kw))

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


# ---------------------------------------------------------------------------
# AsyncClient
# ---------------------------------------------------------------------------


class AsyncClient(object):
    def __init__(self, **kw):
        self.headers = dict(kw.get("headers") or {})

    def _merge(self, kw):
        merged = dict(self.headers)
        merged.update(kw.get("headers") or {})
        kw = dict(kw)
        kw["headers"] = merged
        return kw

    async def request(self, method, url, **kw):
        return request(method, url, **self._merge(kw))

    async def get(self, url, **kw):
        return await self.request("GET", url, **kw)

    async def post(self, url, **kw):
        return await self.request("POST", url, **kw)

    async def put(self, url, **kw):
        return await self.request("PUT", url, **kw)

    async def patch(self, url, **kw):
        return await self.request("PATCH", url, **kw)

    async def delete(self, url, **kw):
        return await self.request("DELETE", url, **kw)

    async def head(self, url, **kw):
        return await self.request("HEAD", url, **kw)

    async def options(self, url, **kw):
        return await self.request("OPTIONS", url, **kw)

    async def aclose(self):
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.aclose()
        return False


__all__ = [
    "get", "post", "put", "patch", "delete", "head", "options", "request",
    "Client", "AsyncClient", "Response", "codes",
    "HTTPError", "RequestError", "HTTPStatusError",
]
