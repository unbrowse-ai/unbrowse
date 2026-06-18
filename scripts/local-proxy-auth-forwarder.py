#!/usr/bin/env python3
"""
scripts/local-proxy-auth-forwarder.py

Local TCP forward-proxy that bridges Chrome to an authenticated upstream
HTTP proxy. Chrome's --proxy-server flag rejects URLs with inline auth
(user:pass@host) and returns ERR_NO_SUPPORTED_PROXIES. This forwarder
accepts unauthenticated traffic on localhost and injects the
Proxy-Authorization header before forwarding to the upstream.

Role: this is the local wedge that closes the kuri-proxy auth
gap. The bridge spawns one of these per kuri session, Chrome connects
to the localhost port without auth, every request flows through with
the upstream creds added at the forwarder layer.

Usage:
  python3 scripts/local-proxy-auth-forwarder.py \\
      --upstream http://user:pass@geo.iproyal.com:12321 \\
      [--bind 127.0.0.1:0] [--quiet]

  --upstream URL    : full proxy URL with inline credentials
  --bind HOST:PORT  : where to listen (default 127.0.0.1:0 — kernel-picked)
  --quiet           : suppress per-request log lines
  --ready-file PATH : also write "port=<N>\n" to this file once listening
                       (lets parent processes discover the port without
                        racing the stdout stream)

Outputs (stdout, line-delimited):
  ready port=<N>    : listening, port N (parse this to get the kernel-picked port)
  conn <client>     : per CONNECT/GET (suppressed under --quiet)
  err <msg>         : per error

Exits on SIGTERM/SIGINT. Survives until parent kills it.
"""

import argparse
import base64
import select
import socket
import socketserver
import sys
import threading
import urllib.parse


def parse_upstream(url: str) -> tuple[str, int, str | None]:
    """Parse upstream proxy URL into (host, port, auth_header_value or None)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"upstream must be http:// or https://, got {parsed.scheme}://")
    host = parsed.hostname
    if not host:
        raise ValueError("upstream missing host")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    auth_value = None
    if parsed.username:
        user = urllib.parse.unquote(parsed.username)
        password = urllib.parse.unquote(parsed.password or "")
        token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
        auth_value = f"Basic {token}"
    return host, port, auth_value


class ProxyForwarder(socketserver.BaseRequestHandler):
    """Per-connection handler. Reads the first HTTP request line + headers,
    injects Proxy-Authorization, forwards to upstream. Tunnels bytes after."""

    upstream_host: str = ""
    upstream_port: int = 0
    upstream_auth: str | None = None
    quiet: bool = False

    def handle(self) -> None:
        client = self.request
        client.settimeout(60)
        try:
            request_data = self._read_until_headers_end(client)
            if not request_data:
                return
            modified = self._inject_auth(request_data)
            upstream = socket.create_connection(
                (self.upstream_host, self.upstream_port), timeout=15
            )
            upstream.sendall(modified)
            if not self.quiet:
                first_line = request_data.split(b"\r\n", 1)[0].decode("latin-1", errors="replace")
                print(f"conn {first_line[:80]}", flush=True)
            self._tunnel(client, upstream)
        except Exception as exc:
            if not self.quiet:
                print(f"err {type(exc).__name__}: {exc}", flush=True)

    def _read_until_headers_end(self, sock: socket.socket) -> bytes:
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(8192)
            if not chunk:
                return buf
            buf += chunk
            if len(buf) > 64 * 1024:
                return buf
        return buf

    def _inject_auth(self, request: bytes) -> bytes:
        if not self.upstream_auth:
            return request
        header = f"Proxy-Authorization: {self.upstream_auth}\r\n".encode("latin-1")
        idx = request.find(b"\r\n")
        if idx == -1:
            return request
        existing_lower = request.lower()
        if b"\r\nproxy-authorization:" in existing_lower or existing_lower.startswith(b"proxy-authorization:"):
            return request
        return request[: idx + 2] + header + request[idx + 2 :]

    def _tunnel(self, client: socket.socket, upstream: socket.socket) -> None:
        sockets = [client, upstream]
        try:
            while True:
                readable, _, exceptional = select.select(sockets, [], sockets, 30)
                if exceptional:
                    return
                if not readable:
                    return
                for sock in readable:
                    data = sock.recv(16384)
                    if not data:
                        return
                    peer = upstream if sock is client else client
                    peer.sendall(data)
        finally:
            for s in sockets:
                try:
                    s.close()
                except Exception:
                    pass


class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", required=True, help="upstream proxy URL (http://user:pass@host:port)")
    parser.add_argument("--bind", default="127.0.0.1:0", help="bind address (default 127.0.0.1:0)")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--ready-file", default=None, help="also write port=N here once listening")
    args = parser.parse_args()

    try:
        host, port, auth_value = parse_upstream(args.upstream)
    except ValueError as exc:
        print(f"err {exc}", flush=True)
        return 2

    bind_host, _, bind_port_str = args.bind.partition(":")
    bind_port = int(bind_port_str or "0")

    ProxyForwarder.upstream_host = host
    ProxyForwarder.upstream_port = port
    ProxyForwarder.upstream_auth = auth_value
    ProxyForwarder.quiet = args.quiet

    server = ThreadedServer((bind_host, bind_port), ProxyForwarder)
    chosen_port = server.server_address[1]
    print(f"ready port={chosen_port}", flush=True)
    if args.ready_file:
        try:
            with open(args.ready_file, "w") as f:
                f.write(f"port={chosen_port}\n")
        except OSError as exc:
            print(f"err ready-file: {exc}", flush=True)
    try:
        server.serve_forever(poll_interval=1.0)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
