"""unbrowse_aiohttp — a drop-in for the aiohttp client.

`import unbrowse_aiohttp as aiohttp` and your existing async code keeps working.
GET requests are routed through Unbrowse's resolve -> execute API when a cached
endpoint matches; everything else falls back to pure-stdlib urllib.request run in
a thread. No third-party dependencies.
"""
import os
import json
import asyncio
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
# Exceptions
# ---------------------------------------------------------------------------


class ClientError(Exception):
    pass


class ClientResponseError(ClientError):
    def __init__(self, status=0, message="", *a, **kw):
        self.status = status
        self.message = message
        super().__init__("%s, message=%r" % (status, message))


# ---------------------------------------------------------------------------
# Timeout (surface compatibility only)
# ---------------------------------------------------------------------------


class ClientTimeout:
    def __init__(self, total=None, connect=None, sock_read=None, sock_connect=None):
        self.total = total
        self.connect = connect
        self.sock_read = sock_read
        self.sock_connect = sock_connect


# ---------------------------------------------------------------------------
# Response
# ---------------------------------------------------------------------------


class _Response:
    def __init__(self, status, body, headers, url):
        self.status = int(status)
        self._body = body if isinstance(body, (bytes, bytearray)) else (body or "").encode()
        self.headers = headers or {}
        self.url = url

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def read(self):
        return bytes(self._body)

    async def text(self, encoding="utf-8"):
        return self._body.decode(encoding, "replace")

    async def json(self):
        return json.loads(self._body.decode("utf-8", "replace"))

    def raise_for_status(self):
        if self.status >= 400:
            raise ClientResponseError(status=self.status, message="HTTP %s" % self.status)


# ---------------------------------------------------------------------------
# Core blocking fetch (run in a thread from the async surface)
# ---------------------------------------------------------------------------


def _synthetic_dryrun(url):
    return _Response(200, b'{"dryrun": true}', {"content-type": "application/json"}, url)


def _native_blocking(method, url, headers=None, data=None, timeout=30):
    body = data
    if isinstance(body, str):
        body = body.encode()
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return _Response(r.getcode(), r.read(), dict(r.headers), url)
    except urllib.error.HTTPError as e:
        return _Response(e.code, e.read(), dict(e.headers or {}), url)
    except Exception as e:
        raise ClientError(str(e))


def _fetch_blocking(method, url, headers=None, data=None, intent=None, timeout=30):
    if _dryrun():
        return _synthetic_dryrun(url)
    if method.upper() == "GET":
        res = _resolve(url, intent or ("GET " + url))
        eid = _top_id(res)
        if eid:
            out = _execute(eid)
            if out and out.get("ok") is not False:
                body = out.get("body")
                if body is None:
                    body = json.dumps(out)
                if not isinstance(body, (str, bytes, bytearray)):
                    body = json.dumps(body)
                status = out.get("status") or 200
                return _Response(status, body, out.get("headers") or {"content-type": "application/json"}, url)
        # miss -> native
    return _native_blocking(method, url, headers=headers, data=data, timeout=timeout)


# ---------------------------------------------------------------------------
# ClientSession
# ---------------------------------------------------------------------------


class _RequestContextManager:
    """Both awaitable (`resp = await s.get(url)`) and an async context manager
    (`async with s.get(url) as resp:`), matching aiohttp's surface."""

    def __init__(self, coro):
        self._coro = coro
        self._resp = None

    def __await__(self):
        return self._coro.__await__()

    async def __aenter__(self):
        self._resp = await self._coro
        return self._resp

    async def __aexit__(self, *exc):
        return False


class ClientSession:
    def __init__(self, *args, **kwargs):
        self._headers = dict(kwargs.get("headers") or {})
        self._closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()
        return False

    async def close(self):
        self._closed = True

    async def _do(self, method, url, **kw):
        headers = dict(self._headers)
        headers.update(kw.get("headers") or {})
        data = kw.get("data")
        if kw.get("json") is not None:
            data = json.dumps(kw["json"]).encode()
            headers.setdefault("content-type", "application/json")
        intent = kw.get("intent")
        timeout = kw.get("timeout")
        if isinstance(timeout, ClientTimeout):
            timeout = timeout.total or 30
        if not isinstance(timeout, (int, float)):
            timeout = 30
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, lambda: _fetch_blocking(method, url, headers=headers, data=data, intent=intent, timeout=timeout)
        )

    def request(self, method, url, **kw):
        return _RequestContextManager(self._do(method, url, **kw))

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


__all__ = [
    "ClientSession",
    "ClientTimeout",
    "ClientError",
    "ClientResponseError",
]
