#!/usr/bin/env python3
"""Day-4 luminaries — falsifiable signals over the Step-3 live_protocol.py.

Deterministic: monkeypatches live_protocol._run so the parser is tested without the
network. The load-bearing signal (Luke 15:4) is the honesty gate — a browse-strict
{session_id,tab_id} envelope must NEVER be read as a populated shortlist.

A real live smoke is included but guarded by UNBROWSE_LIVE=1 so the suite stays
deterministic by default.
  Run: python3 bench/capability/test_live_protocol.py
  Live smoke too: UNBROWSE_LIVE=1 python3 bench/capability/test_live_protocol.py
"""
import importlib.util
import json
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("live_protocol", os.path.join(HERE, "live_protocol.py"))
lp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lp)

# canned CLI outputs (real shapes observed from the installed binary)
GO_ENVELOPE = (
    '[07:40] [auth] browser_cookie_imported domain=old.reddit.com\n'
    + json.dumps({
        "ok": True, "session_id": "S1", "tab_id": "T1",
        "page": {"text": '{"kind":"Listing","data":{"children":[]}}', "structured_data": None},
        "autonomy": {"marketplace_publish_mode": "auto"},
    }) + "\n[capture-pipeline] drain cap reached\n"
)
RESOLVE_BROWSE_STRICT = (
    '[trace] phase=run BEGIN\n{"session_id":"S1","tab_id":"T1"}\n[capture-pipeline] drain\n'
)
# NEW contract shape: top-level `resolve --no-execute` nests the ranked endpoints under
# result.available_endpoints (the rewire away from the debug `eval resolve` {shortlist} shape).
RESOLVE_WITH_SHORTLIST = (
    '[trace] BEGIN\n' + json.dumps({"result": {"skill_id": "sk1", "available_endpoints": [
        {"endpoint_id": "reddit.listing.top", "score": 90.2},
        {"endpoint_id": "reddit.search", "score": 50.0}]}}) + "\n"
)


class TestGoParsing(unittest.TestCase):
    def test_extracts_real_payload(self):
        with mock.patch.object(lp, "_run", return_value=(0, GO_ENVELOPE, "")):
            r = lp.go("https://old.reddit.com/r/rust/top.json")
        self.assertTrue(r["ok"])
        self.assertEqual(r["session_id"], "S1")
        self.assertIn('"kind":"Listing"', r["page_text"])
        self.assertEqual(r["marketplace_publish_mode"], "auto")

    def test_no_envelope_is_handled(self):
        with mock.patch.object(lp, "_run", return_value=(0, "[trace] only\nno json\n", "")):
            r = lp.go("https://x")
        self.assertFalse(r["ok"])
        self.assertIn("error", r)


class TestResolveLiveHonesty(unittest.TestCase):
    """The gate: a browse-strict envelope must report NO marketplace shortlist."""
    def test_browse_strict_is_not_a_shortlist(self):
        with mock.patch.object(lp, "_run", return_value=(0, RESOLVE_BROWSE_STRICT, "")):
            r = lp.resolve_live("list top posts", url="https://old.reddit.com/r/rust")
        self.assertEqual(r["shortlist"], [])
        self.assertFalse(r["marketplace_available"])  # MUST NOT fabricate a green

    def test_real_shortlist_extracted(self):
        with mock.patch.object(lp, "_run", return_value=(0, RESOLVE_WITH_SHORTLIST, "")) as m:
            r = lp.resolve_live("list top posts", url="https://old.reddit.com/r/rust")
        self.assertEqual(len(r["shortlist"]), 2)
        self.assertTrue(r["marketplace_available"])
        # contract guard: resolve_live must drive top-level `resolve`, NOT the debug `eval resolve`.
        args = m.call_args[0][0]
        self.assertEqual(args[0], "resolve")
        self.assertNotIn("eval", args)


class TestJsonLines(unittest.TestCase):
    def test_skips_trace_keeps_json(self):
        out = list(lp._json_lines('[trace] x\n{"a":1}\nplain\n{"b":2}\n'))
        self.assertEqual(out, [{"a": 1}, {"b": 2}])

    def test_malformed_no_crash(self):
        out = list(lp._json_lines('{bad json\n{"ok":1}\n'))
        self.assertEqual(out, [{"ok": 1}])


@unittest.skipUnless(os.environ.get("UNBROWSE_LIVE") == "1", "live smoke (set UNBROWSE_LIVE=1)")
class TestLiveSmoke(unittest.TestCase):
    def test_go_returns_real_bytes(self):
        r = lp.go("https://old.reddit.com/r/rust/top.json?limit=2", timeout=120)
        self.assertTrue(r["ok"])
        self.assertGreater(len(r.get("page_text") or ""), 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
