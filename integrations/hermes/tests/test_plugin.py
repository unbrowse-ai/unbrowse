"""The plugin against a fake node on the agent API's paths, and a stub of Hermes's plugin context.

Runs offline, without Hermes installed: ``python3 -m unittest discover -s tests`` from integrations/hermes. The SDK
comes from this checkout.
"""

import importlib.util
import json
import os
import re
import socket
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

PLUGIN = Path(__file__).resolve().parent.parent
REPO = PLUGIN.parent.parent
SDK = REPO / "unbrowse-sdk" / "python" / "src"
API = json.loads((REPO / "unbrowse-node" / "agent-api.json").read_text(encoding="utf-8"))
SERVED = [p["tool"] for p in API["primitives"]]

# The SDK from this checkout, never another package that took the name.
sys.path.insert(0, str(SDK))

from unbrowse._proof import node_proof, token_key  # noqa: E402

# The node's signed door, as the SDK's own fake nodes have it.
sys.path.insert(0, str(REPO / "unbrowse-sdk" / "python" / "tests"))
from signed_fixture import Signing  # noqa: E402


def load_plugin():
    """Import the plugin the way Hermes does: as hermes_plugins.<name>, so its relative imports resolve."""
    if "hermes_plugins" not in sys.modules:
        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []
        sys.modules["hermes_plugins"] = ns
    spec = importlib.util.spec_from_file_location("hermes_plugins.unbrowse", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


plugin = load_plugin()
tools = sys.modules["hermes_plugins.unbrowse.tools"]

TOKEN = "agent-token"
SEEN = []
HN = {"id": "hn-search", "site": "hn.algolia.com", "what": "search HN stories", "method": "GET", "path": "/api/v1/search", "write": False, "inputs": [{"name": "q", "default": "rust", "secret": False}]}


def proof_answer(path, port):
    """The node's answer to ``/v1/node/proof``: the proof for TOKEN when the asker names its key."""
    u = urlparse(path)
    if u.path != "/v1/node/proof":
        return None
    q = parse_qs(u.query)
    held = (q.get("key") or [""])[0] == token_key(TOKEN)
    return {"agents": [node_proof(TOKEN, port, bytes.fromhex((q.get("challenge") or [""])[0]))] if held else []}


def answer(method, path, headers, body):
    if headers.get("authorization") != f"Bearer {TOKEN}":
        return 401, {"error": "unknown, revoked or expired agent key"}
    route = f"{method} {path}"
    if route == "GET /v1/routes":
        return 200, {"routes": [HN]}
    if route == "POST /v1/do":
        if body.get("goal") == "search HN stories":
            return 200, {"how": "called", "route": HN, "result": {"ok": True, "ms": 212, "data": {"hits": [{"title": body.get("inputs", {}).get("q", "rust"), "url": None}]}, "retry": "as_is"}}
        return 404, {"error": "no route does that yet: give url, a page that does it, and the node learns it"}
    if route == "POST /v1/routes/paused/call":
        return 503, {"error": "the node is paused by its owner"}
    if route == "POST /v1/browse":
        return 200, {"site": body.get("site") or "chat.example.com", "output": f"{body['do'][0]} done"}
    if route == "GET /v1/whoami":
        return 200, {"agent": "hermes", "address": "0xabc", "browser": "present"}
    return 404, {"error": "no such route"}


class Handler(Signing, BaseHTTPRequestHandler):
    TOKENS = staticmethod(lambda: [TOKEN])

    def _handle(self):
        u = urlparse(self.path)
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        headers = {k.lower(): v for k, v in self.headers.items()}
        proof = proof_answer(self.path, self.server.server_address[1])
        if proof is not None:
            # The SDK asks the node to prove it holds the token before the token goes; not a request the plugin made.
            status, out = 200, proof
        else:
            SEEN.append({"method": self.command, "url": self.path, "headers": headers, "body": body})
            status, out = answer(self.command, u.path, headers, body)
        data = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = _handle

    def log_message(self, *args):
        pass


def last():
    return SEEN[-1]


class Ctx:
    """What register() touches of Hermes's PluginContext (hermes_cli/plugins.py), recorded."""

    def __init__(self):
        self.tools = {}
        self.skills = {}

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, description="", emoji="", override=False):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "check_fn": check_fn, "requires_env": requires_env}

    def register_skill(self, name, path, description="", frontmatter=None):
        if ":" in name or not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise ValueError(name)
        if not Path(path).exists():
            raise FileNotFoundError(path)
        self.skills[name] = Path(path)


def manifest_tools():
    """provides_tools in plugin.yaml, read without a YAML library: one "  - name" line each."""
    text = (PLUGIN / "plugin.yaml").read_text(encoding="utf-8")
    block = text.split("provides_tools:\n", 1)[1]
    names = []
    for line in block.splitlines():
        if not line.startswith("  - "):
            break
        names.append(line[4:].strip())
    return names


class RegisterTest(unittest.TestCase):
    def setUp(self):
        self.ctx = Ctx()
        plugin.register(self.ctx)

    def test_registers_every_tool_the_node_serves_in_one_toolset_gated_on_the_token(self):
        self.assertEqual(list(self.ctx.tools), SERVED)
        self.assertEqual(list(tools.TOOL_NAMES), SERVED)
        for name, t in self.ctx.tools.items():
            self.assertEqual(t["toolset"], "unbrowse", name)
            self.assertEqual(t["requires_env"], ["UNBROWSE_AGENT_TOKEN"], name)
            self.assertIs(t["check_fn"], tools.available, name)

    def test_the_manifest_declares_what_register_registers(self):
        self.assertEqual(manifest_tools(), SERVED)

    def test_the_tools_say_what_the_nodes_mcp_server_says(self):
        for p in API["primitives"]:
            schema = self.ctx.tools[p["tool"]]["schema"]
            self.assertEqual(schema["name"], p["tool"])
            self.assertIn(p["description"], schema["description"], p["tool"])
            self.assertEqual(sorted(schema["parameters"]["properties"]), sorted(p["input"].get("properties", {})), p["tool"])
            self.assertEqual(sorted(schema["parameters"].get("required", [])), sorted(p["required"]), p["tool"])

    def test_ships_the_skill_under_the_plugins_name(self):
        self.assertEqual(list(self.ctx.skills), ["unbrowse"])
        skill = self.ctx.skills["unbrowse"].read_text(encoding="utf-8")
        self.assertRegex(skill, r"(?m)^name: unbrowse$")
        self.assertIn("requires_toolsets: [unbrowse]", skill)
        self.assertNotRegex(skill, r"Wallet, New agent key|signs? in to (Unbrowse|the node)")

    def test_available_needs_the_sdk_and_the_token(self):
        with mock.patch.dict(os.environ, {"UNBROWSE_AGENT_TOKEN": TOKEN}):
            self.assertTrue(tools.available())
            with mock.patch.object(tools, "_adapters", return_value=None):
                self.assertFalse(tools.available())
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(tools.available())

    def test_without_the_sdk_the_tools_keep_their_names_and_say_how_to_get_it(self):
        with mock.patch.object(tools, "_adapters", return_value=None):
            ctx = Ctx()
            plugin.register(ctx)
            self.assertEqual(list(ctx.tools), SERVED)
            r = json.loads(ctx.tools["unbrowse_do"]["handler"]({"goal": "x"}))
        self.assertEqual(r["code"], "unavailable")
        self.assertIn("subdirectory=unbrowse-sdk/python", r["error"])


class ToolsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        ctx = Ctx()
        plugin.register(ctx)
        cls.handlers = {n: t["handler"] for n, t in ctx.tools.items()}

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        env = mock.patch.dict(os.environ, {"UNBROWSE_NODE": self.base, "UNBROWSE_AGENT_TOKEN": TOKEN})
        env.start()
        self.addCleanup(env.stop)

    def call(self, name, args, **context):
        out = self.handlers[name](args, **context)
        self.assertIsInstance(out, str, "a handler answers a JSON string")
        return json.loads(out)

    def test_do_sends_the_goal_and_inputs_as_strings_and_the_sites_data_passes_through(self):
        r = self.call("unbrowse_do", {"goal": "search HN stories", "url": "https://hn.algolia.com/?q=rust", "inputs": {"q": "tauri", "page": 2}}, task_id="t1")
        self.assertEqual(last()["url"], "/v1/do")
        self.assertEqual(last()["body"]["goal"], "search HN stories")
        self.assertEqual(last()["body"]["inputs"], {"q": "tauri", "page": "2"})
        self.assertEqual(last()["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(r["how"], "called")
        self.assertEqual(r["result"]["data"], {"hits": [{"title": "tauri", "url": None}]})

    def test_arguments_sent_as_a_json_string_are_read_as_the_object(self):
        r = self.call("unbrowse_do", json.dumps({"goal": "search HN stories"}))
        self.assertEqual(r["how"], "called")

    def test_a_missing_argument_is_answered_before_reaching_the_node(self):
        before = len(SEEN)
        r = self.call("unbrowse_do", {})
        self.assertEqual(r, {"error": "unbrowse_do needs goal", "code": "bad_request"})
        self.assertEqual(len(SEEN), before)

    def test_a_refusal_is_the_nodes_reason_with_a_code_never_a_raise(self):
        r = self.call("unbrowse_do", {"goal": "send a message"})
        self.assertEqual(r["code"], "not_found")
        self.assertIn("give url", r["error"])
        r = self.call("unbrowse_call", {"route_id": "paused"})
        self.assertIn("paused by its owner", r["error"])

    def test_browse_steps_share_one_session(self):
        self.call("unbrowse_browse", {"do": ["open", "https://chat.example.com/"]})
        first = last()["body"]["session"]
        self.call("unbrowse_browse", {"do": ["snapshot", "-i"]})
        self.assertTrue(first)
        self.assertEqual(last()["body"]["session"], first)

    def test_search_and_whoami_reach_the_nodes_paths(self):
        self.call("unbrowse_search", {"query": "hn stories & more"})
        self.assertEqual(last()["url"], "/v1/routes?q=hn%20stories%20%26%20more")
        self.assertEqual(self.call("unbrowse_whoami", {})["agent"], "hermes")

    def test_a_node_that_isnt_running_is_answered_as_unreachable(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        with mock.patch.dict(os.environ, {"UNBROWSE_NODE": f"http://127.0.0.1:{port}"}):
            r = self.call("unbrowse_whoami", {})
        self.assertEqual(r["code"], "unreachable")

    def test_the_token_never_shows_in_an_answer(self):
        for name, args in (("unbrowse_do", {"goal": "search HN stories"}), ("unbrowse_call", {"route_id": "paused"}), ("unbrowse_browse", {"do": ["open", "https://chat.example.com/"]})):
            self.assertNotIn(TOKEN, self.handlers[name](args))


if __name__ == "__main__":
    unittest.main()
