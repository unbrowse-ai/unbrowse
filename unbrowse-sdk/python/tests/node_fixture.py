"""A fake node whose answers a test writes, for the tests that need an answer the shared fakes don't give (a body that
isn't JSON, a JSON ``null``, a stream the node didn't sign). It proves itself and verifies and signs as the node does
(proof_fixture.py and signed_fixture.py), so the client under test meets it as it meets the node. Not a test file.

``StubNode(reply)``: ``reply(method, path, query, headers, body)`` answers ``(status, body)`` or ``(status, body, content_type)``. A ``dict``, ``list``,
``None``, number or ``bool`` body goes out as its JSON; ``str`` and ``bytes`` go out as they are; ``Unsigned(bytes)`` is
the whole HTTP answer, written past the signing (what a process between the node and the client could say)."""

import json
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from proof_fixture import proof_answer  # noqa: E402
from signed_fixture import Signing  # noqa: E402

TOKEN = "stub-agent-token"


class Unsigned:
    def __init__(self, data):
        self.data = data


class StubNode:
    def __init__(self, reply, tokens=(TOKEN,), owner=None):
        self.reply = reply
        self.seen = []
        stub = self

        class Handler(Signing, BaseHTTPRequestHandler):
            TOKENS = staticmethod(lambda: list(tokens) + ([owner] if owner else []))

            def _handle(self):
                proof = proof_answer(self.path, self.server.server_address[1], agents=tokens, owner=owner)
                if proof is not None:
                    return self._send(200, proof)
                u = urlparse(self.path)
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                headers = {k.lower(): v for k, v in self.headers.items()}
                stub.seen.append({"method": self.command, "url": self.path, "headers": headers, "body": body})
                status, out, *kind = stub.reply(self.command, u.path, parse_qs(u.query), headers, body)
                if isinstance(out, Unsigned):
                    self.wfile.unsigned(out.data)
                    self.close_connection = True
                    return
                self._send(status, out, *kind)

            def _send(self, status, out, kind=None):
                data = out if isinstance(out, bytes) else out.encode() if isinstance(out, str) else json.dumps(out).encode()
                self.send_response(status)
                if kind:
                    self.send_header("content-type", kind)
                if kind != "text/event-stream":
                    self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _handle

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()

    def last(self):
        return self.seen[-1]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Listener:
    """A bare TCP listener: ``mode`` ``"silent"`` takes connections and says nothing, ``"hangs_up"`` reads the request
    and closes the connection without an answer."""

    def __init__(self, mode):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.mode = mode
        self.held = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            if self.mode == "silent":
                self.held.append(conn)
                continue
            try:
                seen = b""
                while b"\r\n\r\n" not in seen:
                    got = conn.recv(65536)
                    if not got:
                        break
                    seen += got
            except OSError:
                pass
            conn.close()

    def close(self):
        self.sock.close()
        for c in self.held:
            c.close()


def closed_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port
