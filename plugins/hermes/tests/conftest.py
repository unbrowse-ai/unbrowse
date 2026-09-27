"""Shared fixtures: import the plugin directory as a package, and a scriptable fake MCP server."""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
PKG = "unbrowse_hermes_under_test"


def load_plugin_package():
    if PKG in sys.modules:
        return sys.modules[PKG]
    spec = importlib.util.spec_from_file_location(PKG, PLUGIN_DIR / "__init__.py",
                                                  submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[PKG] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def plugin():
    return load_plugin_package()


class FakeMcp:
    """Records requests; ``responder(body, headers) -> (status, content_type, text)``."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.responder: Callable[[Dict[str, Any], Dict[str, str]], tuple] = self.default

    @staticmethod
    def rpc_result(body: Dict[str, Any], result: Any) -> str:
        return json.dumps({"jsonrpc": "2.0", "id": body.get("id"), "result": result})

    def default(self, body, headers):
        if body.get("method") == "tools/call":
            args = body["params"]["arguments"]
            payload = {"url": args.get("url"), "metadata": {"title": "Example Domain", "statusCode": 200},
                       "markdown": "# Example Domain\n\nfake body"}
            return 200, "application/json", self.rpc_result(body, {
                "content": [{"type": "text", "text": json.dumps(payload)}], "structuredContent": payload})
        return 200, "application/json", self.rpc_result(body, {"tools": []})


@pytest.fixture
def fake_mcp():
    fake = FakeMcp()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            headers = {k.lower(): v for k, v in self.headers.items()}
            fake.requests.append({"body": body, "headers": headers, "path": self.path})
            status, ctype, text = fake.responder(body, headers)
            data = text.encode()
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # silence
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}/mcp"
    try:
        yield fake
    finally:
        server.shutdown()
        server.server_close()
