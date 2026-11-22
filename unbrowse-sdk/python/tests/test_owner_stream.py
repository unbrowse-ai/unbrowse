"""The owner's live events (``GET /owner/events``) as the client reads them: each event by its name and whole, whatever
line ending the stream uses, and never one the node didn't sign. Against fake nodes whose streams each test writes."""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_fixture import StubNode, Unsigned  # noqa: E402

from unbrowse import UnbrowseError, UnbrowseOwner  # noqa: E402

OWNER = "stub-owner-token"
SSE = "text/event-stream"
EXPECTED = [("open", None), ("call", {"phase": "start", "route": "hn-search"}), ("eye", "not json"), ("activity", None)]


def stream(text):
    return lambda *a: (200, text, SSE)


class WithoutOwnerToken:
    def setUp(self):
        old = os.environ.pop("UNBROWSE_OWNER_TOKEN", None)
        if old is not None:
            self.addCleanup(os.environ.__setitem__, "UNBROWSE_OWNER_TOKEN", old)

    def stub(self, reply, **kw):
        stub = StubNode(reply, **kw)
        self.addCleanup(stub.close)
        return stub


class EventLines(WithoutOwnerToken, unittest.TestCase):
    """Through a proxy that signs for the node: no token here, so the stream is read as it comes."""

    def events(self, text):
        return list(UnbrowseOwner(base_url=self.stub(stream(text)).base).events())

    def test_a_stream_with_unix_line_endings_is_read_event_by_event(self):
        text = ': keep-alive\n\nevent: call\ndata: {"phase":"start",\ndata: "route":"hn-search"}\n\nevent: eye\ndata: not json\n\nevent: activity\ndata: null\n\n'
        self.assertEqual(self.events(text), EXPECTED)

    def test_a_stream_with_crlf_line_endings_is_read_event_by_event(self):
        # UNB-181
        text = ': keep-alive\r\n\r\nevent: call\r\ndata: {"phase":"start",\r\ndata: "route":"hn-search"}\r\n\r\nevent: eye\r\ndata: not json\r\n\r\nevent: activity\r\ndata: null\r\n\r\n'
        self.assertEqual(self.events(text), EXPECTED)

    # UNB-181. Fails on the current src: the reader splits on LF only, so a stream whose lines end in a lone CR (which
    # the event-stream format allows) reads as one long line and no event comes out of it. Marked as the failure it is
    # until src/unbrowse/owner.py reads such a stream; then this reports an unexpected success, and the mark goes.
    @unittest.expectedFailure
    def test_a_stream_with_bare_cr_line_endings_is_read_event_by_event(self):
        text = ': keep-alive\r\revent: call\rdata: {"phase":"start",\rdata: "route":"hn-search"}\r\revent: eye\rdata: not json\r\revent: activity\rdata: null\r\r'
        self.assertEqual(self.events(text), EXPECTED)

    def test_an_event_with_no_name_is_a_message_and_a_value_may_have_no_space_after_the_colon(self):
        self.assertEqual(self.events("data:{\"a\":1}\n\nid: 9\nretry: 5\ndata: plain\n\n"), [("open", None), ("message", {"a": 1}), ("message", "plain")])

    def test_an_event_cut_off_before_its_blank_line_is_never_passed_on(self):
        self.assertEqual(self.events("event: call\ndata: 1\n\nevent: call\ndata: 2\n"), [("open", None), ("call", 1)])


class Unsigned_(WithoutOwnerToken, unittest.TestCase):
    def test_a_stream_the_node_didnt_sign_is_refused_before_any_event_reaches_the_caller(self):
        wire = b"HTTP/1.0 200 OK\r\ncontent-type: text/event-stream\r\n\r\nevent: call\ndata: {\"forged\": true}\n\n"
        stub = self.stub(lambda *a: (200, Unsigned(wire)), owner=OWNER)
        got = []
        with self.assertRaises(UnbrowseError) as e:
            for pair in UnbrowseOwner(token=OWNER, base_url=stub.base).events():
                got.append(pair)
        self.assertEqual(got, [])
        self.assertEqual((e.exception.code, e.exception.status), ("unreachable", 0))
        self.assertIn("didn't sign its answer", e.exception.message)

    def test_a_stream_the_node_signed_arrives_event_by_event_with_each_in_its_place(self):
        stub = self.stub(stream("event: call\ndata: 1\n\nevent: call\ndata: 2\n\n"), owner=OWNER)
        self.assertEqual(list(UnbrowseOwner(token=OWNER, base_url=stub.base).events()), [("open", None), ("call", 1), ("call", 2)])


if __name__ == "__main__":
    unittest.main()
