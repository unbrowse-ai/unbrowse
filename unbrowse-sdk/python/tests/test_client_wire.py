"""What the client sends for each option it takes, what it raises for a reply that is not the shape the node usually
gives, and how it says a node that cannot be reached, will not answer, or answers in a stranger's words. Against a fake
node whose answers each test writes (node_fixture.py), which proves itself and signs as the node does."""

import os
import sys
import unittest
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_fixture import TOKEN, Listener, StubNode, closed_port  # noqa: E402

import test_client  # noqa: E402

from unbrowse import (  # noqa: E402
    AuthenticationError,
    NodeConnectionError,
    NodeTimeoutError,
    UnbrowseError,
    UnbrowseNode,
    UnbrowseOwner,
)
from unbrowse._proof import port_of  # noqa: E402

PAGES = ["https://shop.example/items/1", "https://shop.example/items/2"]


def shapes(method, path, query, headers, body):
    """The shared fake node's answers (test_client.py), for the requests these tests don't write an answer for."""
    return test_client.answer(method, path, query, dict(headers), body)


class WithoutAnyToken:
    """The agent and owner tokens, out of the environment for the test."""

    def setUp(self):
        for k in ("UNBROWSE_AGENT_TOKEN", "UNBROWSE_OWNER_TOKEN"):
            old = os.environ.pop(k, None)
            if old is not None:
                self.addCleanup(os.environ.__setitem__, k, old)


class Options(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = StubNode(shapes, tokens=(test_client.TOKEN, test_client.OLD_TOKEN))

    @classmethod
    def tearDownClass(cls):
        cls.stub.close()

    def node(self):
        return UnbrowseNode(token=test_client.TOKEN, base_url=self.stub.base, session="s1")

    def test_do_sends_the_fields_it_wants_how_long_to_wait_and_that_the_browser_is_optional(self):
        self.node().do("search HN stories", fields=["hits.title", "hits.url"], wait_ms=500, browser="if_present")
        sent = self.stub.last()["body"]
        self.assertEqual(sent["fields"], ["hits.title", "hits.url"])
        self.assertEqual(sent["wait_ms"], 500)
        self.assertEqual(sent["browser"], "if_present")

    def test_do_pages_sends_each_page_as_a_url_or_with_the_goal_and_inputs_of_its_own(self):
        r = self.node().do_pages(
            "read the price",
            [PAGES[0], {"url": PAGES[1], "goal": "read the stock", "inputs": {"size": 9}}, {"url": "https://shop.example/items/3"}],
            {"currency": "SGD"},
            browser="if_present",
            fields=["price"],
            wait_ms=2500,
        )
        sent = self.stub.last()["body"]
        self.assertEqual(
            sent["pages"],
            [{"url": PAGES[0]}, {"url": PAGES[1], "goal": "read the stock", "inputs": {"size": "9"}}, {"url": "https://shop.example/items/3"}],
        )
        self.assertEqual(sent["inputs"], {"currency": "SGD"})
        self.assertEqual((sent["browser"], sent["fields"], sent["wait_ms"]), ("if_present", ["price"], 2500))
        self.assertEqual(r.ask, "ask_batch")
        self.assertTrue(r.still_working)

    def test_do_pages_collects_a_batch_by_its_ask_waiting_as_long_as_it_is_told(self):
        r = self.node().do_pages("", [], ask="ask_batch", wait_ms=10)
        self.assertEqual(self.stub.last()["body"], {"ask": "ask_batch", "session": "s1", "wait_ms": 10})
        self.assertEqual(r.count, {"learned": 2})
        self.assertFalse(r.still_working)

    def test_do_pages_refuses_an_ask_that_is_not_a_batch_saying_to_collect_it_with_do(self):
        with self.assertRaises(UnbrowseError) as e:
            self.node().do_pages("", [], ask="ask_1")
        self.assertEqual(e.exception.code, "unsupported")
        self.assertIn("collect it with do", e.exception.message)

    def test_do_pages_refuses_a_browser_setting_the_node_does_not_know_before_sending_anything(self):
        before = len(self.stub.seen)
        with self.assertRaises(ValueError) as e:
            self.node().do_pages("read", PAGES, browser="sometimes")
        self.assertIn("'sometimes'", str(e.exception))
        self.assertEqual(len(self.stub.seen), before)

    def test_do_pages_says_a_node_from_before_pages_cannot_do_them(self):
        stub = StubNode(lambda m, p, q, h, b: (200, {"how": "called", "route": {"id": "r"}, "result": {"ok": True}}))
        self.addCleanup(stub.close)
        with self.assertRaises(UnbrowseError) as e:
            UnbrowseNode(token=TOKEN, base_url=stub.base).do_pages("read", PAGES)
        self.assertEqual(e.exception.code, "unsupported")
        self.assertIn("ask for each page with do", e.exception.message)

    def test_call_sends_the_fields_it_wants_by_their_paths(self):
        self.node().call("hn-search", {"q": "rust"}, fields=["hits.points"])
        self.assertEqual(self.stub.last()["body"], {"inputs": {"q": "rust"}, "fields": ["hits.points"]})


class Shapes(unittest.TestCase):
    """The reply shapes the node's newer answers carry, read whole by the client's own types."""

    def stub(self, reply):
        stub = StubNode(reply)
        self.addCleanup(stub.close)
        return UnbrowseNode(token=TOKEN, base_url=stub.base)

    def test_a_calls_answer_says_which_fields_it_holds_and_every_other_path_to_ask_for(self):
        fields = {"returned": ["hits.title", 7], "more": [{"path": "hits.points", "kind": "number", "example": "12"}, {"path": "hits.tags", "kind": "list", "example": 3}, "junk"], "more_total": "2", "whole": True}
        node = self.stub(lambda *a: (200, {"ok": True, "ms": 3, "data": {}, "error": None, "retry": "as_is", "fields": fields}))
        got = node.call("r").fields
        self.assertEqual(got.returned, ["hits.title", "7"])
        self.assertEqual([(f.path, f.kind, f.example) for f in got.more], [("hits.points", "number", "12"), ("hits.tags", "list", None)])
        self.assertEqual((got.more_total, got.whole), (2, True))

    def test_a_calls_answer_with_no_fields_object_says_none_and_a_junk_one_says_none_too(self):
        reply = {"ok": True, "ms": 3, "data": {}, "error": None, "retry": "as_is"}
        self.assertIsNone(self.stub(lambda *a: (200, reply)).call("r").fields)
        self.assertIsNone(self.stub(lambda *a: (200, dict(reply, fields="all of them"))).call("r").fields)

    def test_a_route_a_node_lists_carries_its_standing_among_the_entries_of_its_route(self):
        rep = {"default": True, "unverified": False, "counted_uses": 41, "pass_rate": 0.93, "unavailable": True, "version": 2}
        route = {"id": "0x" + "a" * 64, "site": "", "what": "", "remote": True, "fee": 0.01, "reputation": rep}
        node = self.stub(lambda *a: (200, {"routes": [route, dict(route, reputation=None), dict(route, reputation={"counted_uses": None})]}))
        first, none, bare = node.search("flights")
        self.assertEqual((first.reputation.default, first.reputation.unverified, first.reputation.counted_uses), (True, False, 41))
        self.assertEqual((first.reputation.pass_rate, first.reputation.unavailable, first.reputation.version), (0.93, True, 2))
        self.assertIsNone(none.reputation)
        self.assertEqual((bare.reputation.default, bare.reputation.unverified, bare.reputation.counted_uses, bare.reputation.version), (False, True, 0, 0))

    def test_a_network_answer_names_the_entry_and_its_standing(self):
        entry = {"id": "0x" + "b" * 64, "contributor": "0xfed", "fee": 0.02, "listed_as": {"site": "example-air.com", "what": "Search flights"}, "reputation": {"default": True, "unverified": False, "counted_uses": 50, "pass_rate": 0.9}}
        reply = {"how": "network", "entry": entry, "result": {"ok": True, "ms": 5, "data": {}, "error": None, "retry": "as_is"}}
        got = self.stub(lambda *a: (200, reply)).do("search flights")
        self.assertEqual(got.entry.reputation.counted_uses, 50)
        self.assertEqual(got.entry.listed_site, "example-air.com")

    def test_a_goal_that_went_on_without_a_route_it_could_not_pay_for_says_which_and_why(self):
        refused = {"entry_id": "0x" + "c" * 64, "error": "the agent's daily limit is spent", "why": "raise the limit in the app"}
        reply = {"how": "browse", "site": "hotels.example", "page": "- searchbox", "why": "no call answers the goal", "payment_refused": refused}
        got = self.stub(lambda *a: (200, reply)).do("search hotels", url="https://hotels.example")
        self.assertEqual((got.payment_refused.entry_id, got.payment_refused.error, got.payment_refused.why), (refused["entry_id"], refused["error"], refused["why"]))
        bare = self.stub(lambda *a: (200, dict(reply, payment_refused={"entry_id": 7, "error": 1}))).do("search hotels", url="https://hotels.example")
        self.assertEqual((bare.payment_refused.entry_id, bare.payment_refused.error, bare.payment_refused.why), ("7", "", ""))
        self.assertIsNone(self.stub(lambda *a: (200, dict(reply, payment_refused="no"))).do("search hotels", url="https://hotels.example").payment_refused)

    def test_a_browse_reply_names_the_next_command_as_a_tool_call_or_bare(self):
        step = lambda nxt: self.stub(lambda *a: (200, {"site": "shop.example", "output": "clicked", "next": nxt})).browse(["click", "@e1"]).next
        self.assertEqual(step({"tool": "unbrowse_browse", "args": {"do": ["ask_owner", "a code", 3]}}), ["ask_owner", "a code"])
        self.assertEqual(step(["ask_owner", "a code"]), ["ask_owner", "a code"])
        self.assertIsNone(step({"tool": "unbrowse_do", "args": {"do": ["x"]}}), "a tool that is not browse is not a browse command")
        self.assertIsNone(step({"tool": "unbrowse_browse"}))


class Failures(WithoutAnyToken, unittest.TestCase):
    def failing(self, status, body):
        stub = StubNode(lambda *a: (status, body))
        self.addCleanup(stub.close)
        with self.assertRaises(UnbrowseError) as e:
            UnbrowseNode(token=TOKEN, base_url=stub.base).whoami()
        return e.exception

    def test_a_failed_reply_whose_body_is_the_json_value_null_raises_the_sdks_error_with_the_status(self):
        # UNB-180: not a TypeError from reading a field of nothing.
        for status in (500, 404, 422):
            e = self.failing(status, None)
            self.assertIsInstance(e, UnbrowseError)
            self.assertEqual(e.status, status)
            self.assertEqual(e.message, "null")

    def test_a_failed_reply_that_is_a_json_list_or_string_raises_the_sdks_error_with_the_status(self):
        e = self.failing(502, ["bad", "gateway"])
        self.assertEqual((e.status, e.body), (502, ["bad", "gateway"]))
        e = self.failing(500, '"went wrong"')
        self.assertEqual((e.status, e.message), (500, '"went wrong"'))

    def test_a_failed_reply_that_is_not_json_is_said_in_its_own_words(self):
        e = self.failing(502, "Bad Gateway from the proxy")
        self.assertEqual((e.status, e.code, e.message, e.body), (502, "bad_gateway", "Bad Gateway from the proxy", "Bad Gateway from the proxy"))

    def test_a_failed_reply_with_no_body_says_the_statuss_reason(self):
        e = self.failing(500, "")
        self.assertEqual((e.status, e.message), (500, "Internal Server Error"))

    def test_a_node_that_names_a_code_it_has_no_class_for_is_read_by_its_status(self):
        e = self.failing(409, {"error": "taken", "code": "from_a_newer_node"})
        self.assertEqual((e.status, e.message, e.code), (409, "taken", "conflict"))

    def test_the_mcp_server_config_needs_a_token_and_says_so_before_reaching_the_node(self):
        stub = StubNode(lambda *a: (200, {}))
        self.addCleanup(stub.close)
        with self.assertRaises(UnbrowseError) as e:
            UnbrowseNode(base_url=stub.base).mcp_server()
        self.assertEqual(e.exception.code, "unauthorized")
        self.assertIn("UNBROWSE_AGENT_TOKEN", e.exception.message)
        self.assertEqual(stub.seen, [])


class Unreachable(WithoutAnyToken, unittest.TestCase):
    def owner(self, base):
        return UnbrowseOwner(base_url=base, timeout=0.3)

    def listener(self, mode):
        listener = Listener(mode)
        self.addCleanup(listener.close)
        return listener

    def test_a_node_that_hangs_up_on_the_proof_is_unreachable_and_the_token_is_never_sent(self):
        l = self.listener("hangs_up")
        with self.assertRaises(NodeConnectionError) as e:
            UnbrowseNode(token=TOKEN, base_url=f"http://127.0.0.1:{l.port}").whoami()
        self.assertEqual((e.exception.code, e.exception.status), ("unreachable", 0))
        self.assertIn("is the Unbrowse app running?", e.exception.message)

    def test_a_node_that_hangs_up_on_a_request_with_no_token_is_unreachable(self):
        l = self.listener("hangs_up")
        with self.assertRaises(NodeConnectionError) as e:
            self.owner(f"http://127.0.0.1:{l.port}").node_info()
        self.assertEqual((e.exception.code, e.exception.status), ("unreachable", 0))

    def test_a_node_that_is_not_there_is_unreachable_with_no_token_too(self):
        with self.assertRaises(NodeConnectionError) as e:
            self.owner(f"http://127.0.0.1:{closed_port()}").node_info()
        self.assertEqual((e.exception.code, e.exception.status), ("unreachable", 0))
        self.assertNotIsInstance(e.exception, NodeTimeoutError)

    def test_a_node_that_takes_the_request_and_never_answers_times_out_for_a_request_with_no_token(self):
        l = self.listener("silent")
        with self.assertRaises(NodeTimeoutError) as e:
            self.owner(f"http://127.0.0.1:{l.port}").node_info()
        self.assertEqual((e.exception.code, e.exception.status), ("timeout", 0))
        self.assertIn("0.3 s", e.exception.message)

    def test_a_listener_that_never_finishes_the_secure_handshake_times_out_for_a_proof(self):
        l = self.listener("silent")
        with self.assertRaises(NodeTimeoutError) as e:
            UnbrowseNode(token=TOKEN, base_url=f"https://127.0.0.1:{l.port}", timeout=0.3).whoami()
        self.assertEqual((e.exception.code, e.exception.status), ("timeout", 0))
        self.assertIn("0.3 s", e.exception.message)

    def test_a_listener_that_never_finishes_the_secure_handshake_times_out_for_a_request_with_no_token(self):
        l = self.listener("silent")
        with self.assertRaises(NodeTimeoutError) as e:
            self.owner(f"https://127.0.0.1:{l.port}").node_info()
        self.assertEqual((e.exception.code, e.exception.status), ("timeout", 0))
        self.assertIn("0.3 s", e.exception.message)


class Ports(unittest.TestCase):
    def test_a_port_is_the_one_named_else_the_schemes_own(self):
        self.assertEqual(port_of("http://127.0.0.1:7788"), 7788)
        self.assertEqual(port_of("http://node.example"), 80)
        self.assertEqual(port_of("https://node.example"), 443)

    def test_an_address_with_no_port_to_prove_is_none(self):
        self.assertIsNone(port_of("ftp://node.example"))
        self.assertIsNone(port_of("http://127.0.0.1:notaport"))

    def test_a_token_goes_to_no_address_that_names_no_port_to_prove(self):
        for base in ("ftp://node.example", "http://127.0.0.1:notaport"):
            with self.assertRaises(AuthenticationError) as e:
                UnbrowseNode(token=TOKEN, base_url=base).whoami()
            self.assertIn("names no port to prove", e.exception.message)
            self.assertIn("the token wasn't sent", e.exception.message)


if __name__ == "__main__":
    unittest.main()
