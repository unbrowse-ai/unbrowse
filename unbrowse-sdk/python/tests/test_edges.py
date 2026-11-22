"""Small contracts the larger tests leave: the address a request is signed for, what a tool answers for a call that is
missing what it needs or fails in a way the node never named, and what making an agent key needs."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_fixture import TOKEN, StubNode  # noqa: E402

from unbrowse import UnbrowseNode, UnbrowseOwner  # noqa: E402
from unbrowse._signed import address_of  # noqa: E402
from unbrowse.adapters import TOOLS, run_tool  # noqa: E402
from unbrowse.adapters._core import tool_error  # noqa: E402


class SignedAddress(unittest.TestCase):
    def test_a_request_is_signed_for_the_host_and_port_with_the_port_always_written(self):
        self.assertEqual(address_of("http://Node.Example/v1/whoami"), ("node.example:80", "/v1/whoami"))
        self.assertEqual(address_of("https://node.example/v1/do?x=1"), ("node.example:443", "/v1/do?x=1"))
        self.assertEqual(address_of("http://127.0.0.1:7788"), ("127.0.0.1:7788", ""))

    def test_an_ipv6_host_is_signed_for_in_brackets_as_the_node_reads_its_host_header(self):
        self.assertEqual(address_of("http://[::1]:7788/v1/whoami"), ("[::1]:7788", "/v1/whoami"))
        self.assertEqual(address_of("https://[2001:db8::1]/x"), ("[2001:db8::1]:443", "/x"))


class ToolAnswers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = StubNode(lambda *a: (200, {"how": "called"}))
        cls.node = UnbrowseNode(token=TOKEN, base_url=cls.stub.base, session="s1")

    @classmethod
    def tearDownClass(cls):
        cls.stub.close()

    def test_a_do_with_neither_a_goal_nor_an_ask_says_what_it_needs_without_reaching_the_node(self):
        before = len(self.stub.seen)
        self.assertEqual(run_tool(self.node, TOOLS["do"], {}), {"error": "unbrowse_do needs goal", "code": "bad_request"})
        self.assertEqual(run_tool(self.node, TOOLS["do"], {"goal": "", "url": "https://shop.example"}), {"error": "unbrowse_do needs goal", "code": "bad_request"})
        self.assertEqual(len(self.stub.seen), before)

    def test_a_do_with_an_ask_alone_goes_to_the_node(self):
        self.assertEqual(run_tool(self.node, TOOLS["do"], {"ask": "ask_1"}), {"how": "called"})
        self.assertEqual(self.stub.last()["body"]["ask"], "ask_1")

    def test_a_call_that_fails_in_a_way_the_node_never_named_is_the_tools_answer_not_a_crash(self):
        got = run_tool(self.node, TOOLS["do"], {"goal": {"not", "json"}})
        self.assertEqual(got["code"], "error")
        self.assertIn("not JSON serializable", got["error"])
        self.assertEqual(tool_error(ValueError("bad value")), {"error": "bad value", "code": "error"})


class AgentKeys(unittest.TestCase):
    def test_an_agent_key_needs_its_daily_limit_and_how_long_it_lasts(self):
        owner = UnbrowseOwner(token="owner", base_url="http://127.0.0.1:1")
        for args in ({"cap_usdc": 5}, {"days": 30}, {}):
            with self.subTest(args):
                with self.assertRaises(TypeError) as e:
                    owner.agent_create("claude", **args)
                self.assertIn("agent_create needs name, cap_usdc and days", str(e.exception))


if __name__ == "__main__":
    unittest.main()
