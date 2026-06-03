#!/usr/bin/env python3
"""unbrowse-http-shim — minimal HTTP front for a LOCAL unbrowse instance, so a
Cloudflare Tunnel can expose it (mac-mini unbrowse, reachable publicly, no Worker
deploy). GET /health -> ok; GET /search?intent=X -> unbrowse search JSON."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import json, os, shutil, subprocess

UNBROWSE = (os.environ.get("UNBROWSE_BIN") or shutil.which("unbrowse")
            or os.path.expanduser("~/.bun/bin/unbrowse"))
PORT = int(os.environ.get("UNBROWSE_SHIM_PORT", "8799"))
HOST = os.environ.get("UNBROWSE_SHIM_HOST", "127.0.0.1")  # set 0.0.0.0 for Tailscale reach


class H(BaseHTTPRequestHandler):
    def _json(self, code, body: bytes):
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            return self._json(200, json.dumps({"ok": True, "service": "unbrowse-tunnel", "bin": UNBROWSE}).encode())
        if u.path == "/search":
            intent = parse_qs(u.query).get("intent", [""])[0]
            if not intent:
                return self._json(400, b'{"error":"intent required"}')
            try:
                p = subprocess.run([UNBROWSE, "search", "--intent", intent],
                                   capture_output=True, text=True, timeout=180)
                out = p.stdout or ""
                i = out.find("{")
                payload = out[i:].encode() if i >= 0 else json.dumps({"raw": out, "err": p.stderr[:500]}).encode()
                return self._json(200, payload)
            except Exception as e:
                return self._json(500, json.dumps({"error": str(e)}).encode())
        return self._json(404, b'{"error":"not found"}')

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"[unbrowse-shim] serving on {HOST}:{PORT} (unbrowse={UNBROWSE})", flush=True)
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
