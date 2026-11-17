"""The node's signed door, for the fake nodes. Not a test file.

``Signing`` goes first in a fake's bases (``class Handler(Signing, BaseHTTPRequestHandler)``), with ``TOKENS`` the
tokens the fake node holds (a callable). A request signed with one of them is checked as the node checks it, each nonce
once, and handed on with the token where the node's handlers read it (``authorization``); what the handler answers is
signed: its status and body, or for an event stream each event with its place. An unsigned request goes on as it is.
Written apart from the SDK's ``_signed``, so the tests check one against the other."""

import hashlib
import hmac
import io
import re
import time


def _mac(token, parts):
    return hmac.new(token.encode(), "\n".join(parts).encode(), hashlib.sha256).hexdigest()


def body_hash(b):
    return hashlib.sha256(b).hexdigest()


def request_mac(token, method, authority, target, body, at, nonce):
    return _mac(token, ("unbrowse/request/v2", method.upper(), authority.lower(), target, body_hash(body), str(at), nonce))


def reply_mac(token, status, hashed, nonce):
    return _mac(token, ("unbrowse/reply/v1", str(status), hashed, nonce))


def event_mac(token, nonce, seq, name, data):
    return _mac(token, ("unbrowse/event/v1", nonce, str(seq), name, data))


def _key(token):
    from unbrowse._proof import token_key

    return token_key(token)


class _SignedWriter:
    """Holds what a handler writes and signs it: the whole answer when it is done, or an event stream as it goes."""

    def __init__(self, real, token, nonce):
        self.real, self.token, self.nonce = real, token, nonce
        self.buf = b""
        self.head = None
        self.stream = False
        self.pending = ""
        self.seq = 0

    def unsigned(self, data):
        """For a test standing in for a process between the node and the client: bytes the node didn't sign."""
        self.real.write(data)
        self.real.flush()

    def _split_head(self):
        if self.head is None and b"\r\n\r\n" in self.buf:
            head, self.buf = self.buf.split(b"\r\n\r\n", 1)
            self.head = head.decode("latin-1")
            self.stream = "text/event-stream" in self.head.lower()
            if self.stream:
                status = int(self.head.split(" ", 2)[1])
                self.real.write((self.head + f"\r\nx-unbrowse-reply: {reply_mac(self.token, status, 'event-stream', self.nonce)}\r\n\r\n").encode("latin-1"))

    def _events(self):
        self.pending += self.buf.decode()
        self.buf = b""
        out = ""
        while True:
            m = re.search(r"\r?\n\r?\n", self.pending)
            if not m:
                break
            block, self.pending = self.pending[: m.start()], self.pending[m.end():]
            lines = re.split(r"\r?\n", block)
            name = next((ln[6:].strip() for ln in lines if ln.startswith("event:")), "message")
            data = "\n".join(re.sub(r"^ ", "", ln[5:]) for ln in lines if ln.startswith("data:"))
            if any(ln.startswith("data:") for ln in lines):
                out += f"{block}\nid: {self.seq}.{event_mac(self.token, self.nonce, self.seq, name, data)}\n\n"
                self.seq += 1
            else:
                out += block + "\n\n"
        return out.encode()

    def write(self, data):
        self.buf += data
        self._split_head()
        if self.stream:
            self.real.write(self._events())
        return len(data)

    def flush(self):
        if self.stream:
            self.real.flush()

    def finish(self):
        if self.stream or self.head is None:
            if self.head is None and self.buf:
                self.real.write(self.buf)
            self.real.flush()
            return
        status = int(self.head.split(" ", 2)[1])
        lines = [ln for ln in self.head.split("\r\n") if not ln.lower().startswith("content-length:")]
        lines.append(f"Content-Length: {len(self.buf)}")
        lines.append(f"x-unbrowse-reply: {reply_mac(self.token, status, body_hash(self.buf), self.nonce)}")
        self.real.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + self.buf)
        self.real.flush()


class Signing:
    TOKENS = staticmethod(lambda: [])
    _seen = set()

    def parse_request(self):
        if not super().parse_request():
            return False
        key = self.headers.get("x-unbrowse-key")
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        self.rfile = io.BytesIO(body)
        if not key:
            return True
        token = next((t for t in self.TOKENS() if _key(t) == key), None)
        at, nonce, sig = self.headers.get("x-unbrowse-time"), self.headers.get("x-unbrowse-nonce"), self.headers.get("x-unbrowse-signature")
        good = (
            token is not None
            and nonce not in Signing._seen
            and abs(time.time() - float(at or 0)) <= 60
            and hmac.compare_digest(request_mac(token, self.command, self.headers.get("host") or "", self.path, body, at, nonce), sig or "")
        )
        if not good:
            self.send_response(401)
            self.send_header("content-type", "application/json")
            data = b'{"error": "the request\'s signature doesn\'t match it"}'
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return False
        Signing._seen.add(nonce)
        del self.headers["authorization"]
        self.headers["authorization"] = f"Bearer {token}"
        self.wfile = _SignedWriter(self.wfile, token, nonce)
        return True

    def handle_one_request(self):
        real = self.wfile
        try:
            super().handle_one_request()
        finally:
            if isinstance(self.wfile, _SignedWriter):
                self.wfile.finish()
            self.wfile = real
