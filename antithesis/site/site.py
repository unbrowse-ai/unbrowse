"""The fixture shop the nodes share a route to, as the five-node test's shop (unbrowse-node/app/src/share.rs `shop`).

`GET /api/items?q=` answers every search with one item, and `POST /api/cart?q=` adds it to the caller's cart (the
route that writes). Each remembers the request line and the cookie that came with it, so the workload can tell which
node called and under whose session. `GET /` is the page the routes were learned from.

The shop serves HTTPS on :443 under the harness's test CA (antithesis/Dockerfile `harness-certs`), because a route
another node listed goes over HTTPS to a public address only (unbrowse-node/crates/learn/src/egress.rs). Plain HTTP on
:8080 is a side door for the harness alone: `GET /_seen` (what the shop remembers; no route calls it) and `GET /` (the
healthcheck). The API isn't there, so a route that ran over plain HTTP would be seen failing, never succeeding.

The nodes reach it at a public-looking name (a network alias) on a public-range subnet, because a route's site is a
registrable domain, never an address.
"""

import json
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HTTPS_PORT = 443
SIDE_PORT = 8080
CERT = "/opt/unbrowse-antithesis/shop.pem"
KEY = "/opt/unbrowse-antithesis/shop.key"
SEEN = []
LOCK = threading.Lock()


class Shop(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    tls = True

    def log_message(self, fmt, *args):
        print("site:", "https" if self.tls else "http", fmt % args, flush=True)

    def answer(self, status, body, kind="application/json"):
        data = body.encode()
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def seen(self):
        with LOCK:
            SEEN.append({"line": self.requestline, "cookie": self.headers.get("cookie", ""), "from": self.client_address[0], "tls": self.tls})

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/items" and self.tls:
            self.seen()
            self.answer(200, json.dumps({"items": [{"id": 1, "name": "desk lamp"}]}))
        elif path == "/_seen" and not self.tls:
            with LOCK:
                self.answer(200, json.dumps(SEEN))
        elif path == "/":
            self.answer(200, "<!doctype html><title>Shop</title><form action=/><input name=q></form>", "text/html")
        else:
            self.answer(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        size = int(self.headers.get("content-length") or 0)
        if size:
            self.rfile.read(size)
        if urlsplit(self.path).path == "/api/cart" and self.tls:
            self.seen()
            self.answer(200, json.dumps({"cart": [{"id": 1, "name": "desk lamp"}]}))
        else:
            self.answer(404, json.dumps({"error": "not found"}))


class SideDoor(Shop):
    tls = False


if __name__ == "__main__":
    shop = ThreadingHTTPServer(("0.0.0.0", HTTPS_PORT), Shop)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    ctx.set_alpn_protocols(["http/1.1"])
    # The handshake runs on the request's own thread (first read), so one stalled client never holds up the rest.
    shop.socket = ctx.wrap_socket(shop.socket, server_side=True, do_handshake_on_connect=False)
    threading.Thread(target=ThreadingHTTPServer(("0.0.0.0", SIDE_PORT), SideDoor).serve_forever, daemon=True).start()
    print(f"site: the shop answers on https :{HTTPS_PORT}, the side door on http :{SIDE_PORT}", flush=True)
    shop.serve_forever()
