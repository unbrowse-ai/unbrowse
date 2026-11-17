"""The framework adapters (unbrowse.adapters.langchain, unbrowse.adapters.openai_agents) against the fake node of
test_client.py: the tools each gives and their schemas, one call through each tool, failures answered as the tool's
result, and each framework's own tool-calling path with a scripted model, so no model API is called. The shared core
runs everywhere; a framework's tests run where it is installed (``pip install unbrowse[langchain,openai-agents]``)."""

import asyncio
import json
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_client  # noqa: E402
from test_client import SEEN, TOKEN, Handler, last  # noqa: E402

from unbrowse import UnbrowseNode  # noqa: E402
from unbrowse.adapters import DEFAULT_TOOLS, TOOLS, chosen, run_tool  # noqa: E402

try:
    import langchain_core  # noqa: F401

    HAS_LANGCHAIN = True
except ImportError:
    HAS_LANGCHAIN = False
try:
    import agents  # noqa: F401

    HAS_AGENTS = True
except ImportError:
    HAS_AGENTS = False

MANIFEST = json.loads((Path(__file__).resolve().parents[3] / "unbrowse-node" / "agent-api.json").read_text())
MCP = {p["tool"]: p for p in MANIFEST["primitives"]}
DEFAULT = ["unbrowse_do", "unbrowse_search", "unbrowse_call", "unbrowse_logins", "unbrowse_whoami"]
NO_BROWSER = "the node has no browser: install Chrome, or download Chrome for Testing in the Unbrowse app's Settings"

_answer = test_client.answer


def answer(method, path, query, headers, body):
    # The fake node of test_client.py, and a node with no browser asked to walk a page.
    if path == "/v1/do" and body and body.get("goal") == "read a page" and body.get("url"):
        return 422, {"error": NO_BROWSER}
    # A node with the browser add-on names the case and says how to get it, or that it is fetching it now.
    if path == "/v1/do" and body and body.get("goal") in ("learn a page", "learn a page soon") and body.get("url"):
        state = "missing" if body["goal"] == "learn a page" else "installing"
        return 422, {"error": "this needs the node's browser", "code": "browser_missing", "browser": state, "missing": ["chromium"], "install": "unbrowse browser install", "fetch": state == "installing"}
    # A tool sends only the arguments the model gave, as MCP does; the node reads one left out as empty (serde's
    # defaults), and the fake reads every one.
    if body is not None and path in ("/v1/do", "/v1/browse"):
        body = {"url": "", "inputs": {}, "site": "", "goal": "", **body}
    return _answer(method, path, query, headers, body)


class Server:
    @classmethod
    def setUpClass(cls):
        test_client.answer = answer
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        test_client.answer = _answer

    def node(self):
        return UnbrowseNode(token=TOKEN, base_url=self.base, session="s1")


class CoreTest(Server, unittest.TestCase):
    """What every adapter shares, without a framework."""

    def test_the_five_tools_by_default_browse_only_when_asked(self):
        self.assertEqual([t["name"] for t in chosen()], DEFAULT)
        self.assertEqual([t["name"] for t in chosen([*DEFAULT_TOOLS, "browse"])], [*DEFAULT, "unbrowse_browse"])
        self.assertEqual([t["name"] for t in chosen(["unbrowse_do", "report"])], ["unbrowse_do", "unbrowse_report"])
        with self.assertRaisesRegex(ValueError, "no Unbrowse tool scrape"):
            chosen(["scrape"])

    def test_every_tool_is_the_mcp_servers(self):
        self.assertEqual([t["name"] for t in TOOLS.values()], list(MCP))
        for t in TOOLS.values():
            p = MCP[t["name"]]
            self.assertTrue(t["description"].endswith(p["description"]), t["name"])
            self.assertEqual(t["input_schema"]["properties"], p["input"]["properties"])
            self.assertEqual(t["input_schema"]["required"], p["input"].get("required", []))
        self.assertIn("before you write a scraper", TOOLS["do"]["description"])
        self.assertIn("inaccessible", TOOLS["do"]["description"])

    def test_one_call_through_each_tool(self):
        node, spec = self.node(), {t["name"]: t for t in TOOLS.values()}
        r = run_tool(node, spec["unbrowse_do"], {"goal": "search HN stories", "url": "https://hn.algolia.com/?q=rust", "inputs": {"q": 42}, "pays": None})
        self.assertEqual(r["how"], "called")
        self.assertEqual(last()["body"], {"goal": "search HN stories", "url": "https://hn.algolia.com/?q=rust", "inputs": {"q": "42"}, "session": "s1"})
        self.assertEqual(run_tool(node, spec["unbrowse_search"], {"query": "hn"})["routes"][0]["id"], "hn-search")
        self.assertEqual(last()["url"], "/v1/routes?q=hn")
        c = run_tool(node, spec["unbrowse_call"], {"route_id": "hn-search", "inputs": {"q": "zig"}})
        self.assertEqual((c["data"]["hits"][0]["title"], c["retry"]), ("zig", "as_is"))
        self.assertEqual(run_tool(node, spec["unbrowse_logins"], {})["logins"][0]["ref"], "vault:example.com:me")
        self.assertEqual(run_tool(node, spec["unbrowse_whoami"], {})["node"], "lewis-mac")
        self.assertEqual(run_tool(node, spec["unbrowse_browse"], {"do": ["open", "https://chat.example.com"], "session": "b"})["output"], "open done")
        self.assertEqual(last()["body"]["session"], "s1:b", "a session the model names is one of this client's")

    def test_a_failed_call_is_the_tools_answer(self):
        node, do = self.node(), TOOLS["do"]
        self.assertEqual(run_tool(node, do, {"goal": "post a listing"}), {"error": "no route does that yet: give url, a page that does it, and the node learns it", "code": "not_found"})
        self.assertEqual(run_tool(node, TOOLS["call"], {"route_id": ""}), {"error": "unbrowse_call needs route_id", "code": "bad_request"})
        r = run_tool(node, do, {"goal": "read a page", "url": "https://example.com/page"})
        self.assertEqual(r["code"], "browser_missing")
        self.assertIn("still calls the routes the node has", r["hint"])
        named = run_tool(node, do, {"goal": "learn a page", "url": "https://example.com/page"})
        self.assertEqual(named["code"], "browser_missing")
        self.assertIn("`unbrowse browser install` on the node's machine", named["hint"])
        fetching = run_tool(node, do, {"goal": "learn a page soon", "url": "https://example.com/page"})
        self.assertIn("fetching its browser now: try again in a minute", fetching["hint"])
        down = UnbrowseNode(token=TOKEN, base_url="http://127.0.0.1:9", timeout=2)
        self.assertEqual(run_tool(down, TOOLS["whoami"], {})["code"], "unreachable")


@unittest.skipUnless(HAS_LANGCHAIN, "langchain-core isn't installed: pip install 'unbrowse[langchain]'")
class LangChainTest(Server, unittest.TestCase):
    def tools(self, include=None):
        from unbrowse.adapters.langchain import unbrowse_tools

        return {t.name: t for t in unbrowse_tools(self.node(), include)}

    def test_the_tools_and_their_schemas(self):
        self.assertEqual(list(self.tools()), DEFAULT)
        tools = self.tools([*DEFAULT_TOOLS, "browse"])
        for name, t in tools.items():
            self.assertTrue(t.description.endswith(MCP[name]["description"]))
            self.assertEqual(t.args_schema["properties"], MCP[name]["input"]["properties"])
            # What LangChain hands a model to call it with.
            from langchain_core.utils.function_calling import convert_to_openai_tool

            self.assertEqual(convert_to_openai_tool(t)["function"]["parameters"]["properties"], MCP[name]["input"]["properties"])

    def test_one_call_through_each_tool(self):
        t = self.tools([*DEFAULT_TOOLS, "browse"])
        self.assertEqual(json.loads(t["unbrowse_do"].invoke({"goal": "search HN stories"}))["how"], "called")
        self.assertEqual(json.loads(t["unbrowse_search"].invoke({"query": "hn"}))["routes"][0]["id"], "hn-search")
        self.assertEqual(json.loads(t["unbrowse_call"].invoke({"route_id": "hn-search", "inputs": {"q": "zig"}}))["data"]["hits"][0]["title"], "zig")
        self.assertEqual(json.loads(t["unbrowse_logins"].invoke({}))["logins"][0]["site"], "example.com")
        self.assertEqual(json.loads(t["unbrowse_whoami"].invoke({}))["agent"], "claude")
        self.assertEqual(json.loads(t["unbrowse_browse"].invoke({"do": ["snapshot", "-i"]}))["output"], "snapshot done")
        self.assertEqual(json.loads(asyncio.run(t["unbrowse_whoami"].ainvoke({})))["agent"], "claude", "async too")

    def test_a_failed_call_is_the_tools_answer(self):
        r = json.loads(self.tools()["unbrowse_do"].invoke({"goal": "post a listing"}))
        self.assertEqual(r["code"], "not_found")

    def test_a_chat_models_tool_call_comes_back_as_a_tool_message(self):
        from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        class Scripted(GenericFakeChatModel):
            bound: list = []

            def bind_tools(self, tools, **kwargs):
                Scripted.bound = [t.name for t in tools]
                return self

        tools = self.tools()
        call = {"id": "c1", "name": "unbrowse_do", "args": {"goal": "search HN stories"}, "type": "tool_call"}
        model = Scripted(messages=iter([AIMessage(content="", tool_calls=[call])])).bind_tools(list(tools.values()))
        ai = model.invoke([HumanMessage("What's on HN about rust?")])
        self.assertEqual(Scripted.bound, DEFAULT)
        msg = tools[ai.tool_calls[0]["name"]].invoke(ai.tool_calls[0])
        self.assertIsInstance(msg, ToolMessage)
        self.assertEqual(msg.tool_call_id, "c1")
        self.assertEqual(json.loads(msg.content)["how"], "called")


@unittest.skipUnless(HAS_AGENTS, "openai-agents isn't installed: pip install 'unbrowse[openai-agents]'")
class OpenAIAgentsTest(Server, unittest.TestCase):
    def tools(self, include=None):
        from unbrowse.adapters.openai_agents import unbrowse_tools

        return {t.name: t for t in unbrowse_tools(self.node(), include)}

    def invoke(self, tool, args):
        return json.loads(asyncio.run(tool.on_invoke_tool(None, json.dumps(args))))

    def test_the_tools_and_their_schemas(self):
        self.assertEqual(list(self.tools()), DEFAULT)
        for name, t in self.tools([*DEFAULT_TOOLS, "browse"]).items():
            self.assertTrue(t.description.endswith(MCP[name]["description"]))
            self.assertEqual(t.params_json_schema["properties"], MCP[name]["input"]["properties"])
            self.assertFalse(t.strict_json_schema)

    def test_one_call_through_each_tool(self):
        t = self.tools([*DEFAULT_TOOLS, "browse"])
        self.assertEqual(self.invoke(t["unbrowse_do"], {"goal": "search HN stories"})["how"], "called")
        self.assertEqual(self.invoke(t["unbrowse_search"], {"query": "hn"})["routes"][0]["id"], "hn-search")
        self.assertEqual(self.invoke(t["unbrowse_call"], {"route_id": "hn-search", "inputs": {"q": "zig"}})["data"]["hits"][0]["title"], "zig")
        self.assertEqual(self.invoke(t["unbrowse_logins"], {})["logins"][0]["site"], "example.com")
        self.assertEqual(self.invoke(t["unbrowse_whoami"], {})["agent"], "claude")
        self.assertEqual(self.invoke(t["unbrowse_browse"], {"do": ["snapshot", "-i"]})["output"], "snapshot done")

    def test_a_failed_call_is_the_tools_answer(self):
        self.assertEqual(self.invoke(self.tools()["unbrowse_do"], {"goal": "post a listing"})["code"], "not_found")
        bad = json.loads(asyncio.run(self.tools()["unbrowse_do"].on_invoke_tool(None, "{not json")))
        self.assertEqual(bad["code"], "bad_request")

    def test_runner_calls_unbrowse_do_with_a_scripted_model(self):
        from agents import Agent, Runner, set_tracing_disabled
        from agents.items import ModelResponse
        from agents.models.interface import Model
        from agents.usage import Usage
        from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

        set_tracing_disabled(True)

        class Scripted(Model):
            def __init__(self):
                self.turn = 0

            async def get_response(self, *args, **kwargs):
                self.turn += 1
                if self.turn == 1:
                    out = [ResponseFunctionToolCall(type="function_call", call_id="c1", name="unbrowse_do", arguments=json.dumps({"goal": "search HN stories"}), status="completed")]
                else:
                    out = [ResponseOutputMessage(id="m1", type="message", role="assistant", status="completed", content=[ResponseOutputText(type="output_text", text="The top story is rust.", annotations=[])])]
                return ModelResponse(output=out, usage=Usage(), response_id=None)

            def stream_response(self, *args, **kwargs):
                raise NotImplementedError

        agent = Agent(name="hn", instructions="Answer from websites with Unbrowse.", model=Scripted(), tools=list(self.tools().values()))
        r = asyncio.run(Runner.run(agent, "What's on HN about rust?"))
        self.assertEqual(r.final_output, "The top story is rust.")
        out = [i for i in r.new_items if i.type == "tool_call_output_item"]
        self.assertEqual(json.loads(out[0].output)["how"], "called")
        self.assertTrue(any(s["url"] == "/v1/do" for s in SEEN))


if __name__ == "__main__":
    unittest.main()
