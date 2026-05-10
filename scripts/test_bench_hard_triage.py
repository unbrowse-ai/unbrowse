#!/usr/bin/env python3
"""Falsifiable signals for bench-hard-triage.route(). Pure-function tests
covering every routing rule, including the lost-sheep edge: BROWSER_BLOCK
with empty signals must still route to ACCEPT_BLOCK without fabricating.

Run:
  python3 scripts/test_bench_hard_triage.py
"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "bench_hard_triage", os.path.join(HERE, "bench-hard-triage.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def row(**overrides):
    base = {
        "url": "https://example.com/",
        "goal": "test",
        "verdict": "PRODUCT_FAIL",
        "source": "live-capture",
        "n_operations": 0,
        "error_code": "",
        "browser_block_signals": "",
        "capture_diagnostic": "",
        "filter_rejections": "",
        "total_endpoints_captured": "",
        "all_ops_dom_fallback": False,
    }
    base.update(overrides)
    return base


class TestRoute(unittest.TestCase):
    def test_pass_returns_none(self):
        self.assertIsNone(mod.route(row(verdict="PASS")))

    def test_pass_weak_returns_none(self):
        self.assertIsNone(mod.route(row(verdict="PASS_WEAK")))

    def test_dom_fallback_only_promotes(self):
        label, _, _ = mod.route(row(verdict="PASS_DOM_FALLBACK_ONLY", n_operations=3))
        self.assertEqual(label, "DOM_FALLBACK_PROMOTE")

    def test_browser_block_with_evidence_accepted(self):
        label, repair, ev = mod.route(
            row(verdict="BROWSER_BLOCK", browser_block_signals='["vendor:cloudflare"]')
        )
        self.assertEqual(label, "ACCEPT_BLOCK")
        self.assertIn("no repair", repair)
        self.assertIn("cloudflare", ev)

    def test_browser_block_lost_sheep_empty_signals(self):
        # The lost sheep: classifier said BROWSER_BLOCK but evidence channel is silent.
        # Route must still resolve, never crash, and admit the silence in evidence.
        label, repair, ev = mod.route(row(verdict="BROWSER_BLOCK"))
        self.assertEqual(label, "ACCEPT_BLOCK")
        self.assertIn("no repair", repair)
        self.assertEqual(ev, "block_signals= diag=")

    def test_auth_gated_accepted(self):
        label, _, _ = mod.route(row(verdict="AUTH_GATED", error_code="auth_required"))
        self.assertEqual(label, "ACCEPT_AUTH")

    def test_diag_no_endpoints_routes_extractor(self):
        label, _, _ = mod.route(row(capture_diagnostic="no_endpoints_extracted"))
        self.assertEqual(label, "REPAIR_EXTRACTOR")

    def test_diag_all_filtered_routes_filter_relax(self):
        label, _, ev = mod.route(
            row(
                capture_diagnostic="all_endpoints_filtered_by_noise_rules",
                filter_rejections='{"not_api_like": 12}',
            )
        )
        self.assertEqual(label, "REPAIR_FILTER_RELAX")
        self.assertIn("not_api_like", ev)

    def test_diag_below_threshold_routes_ranker(self):
        label, _, _ = mod.route(
            row(capture_diagnostic="endpoints_scored_below_relevance_threshold")
        )
        self.assertEqual(label, "REPAIR_RANKER")

    def test_sparse_capture_routes_capture_coverage(self):
        label, repair, _ = mod.route(
            row(browser_block_signals='["sparse_capture_mostly_noise"]', error_code="no_endpoints")
        )
        self.assertEqual(label, "REPAIR_SPARSE_CAPTURE")
        self.assertIn("capture-coverage", repair)

    def test_unknown_no_fabrication(self):
        # Honest unknown: silent on every channel, must NOT fabricate a repair route.
        label, repair, ev = mod.route(row())
        self.assertEqual(label, "UNKNOWN_NEEDS_HUMAN")
        self.assertIn("probe by hand", repair)
        # Evidence must surface the silence so the human can see what to investigate.
        self.assertIn("verdict=PRODUCT_FAIL", ev)


class TestLatestPerUrl(unittest.TestCase):
    def test_later_overwrites_earlier(self):
        rows = [
            {"url": "a", "run_id": "r1", "verdict": "PRODUCT_FAIL"},
            {"url": "a", "run_id": "r2", "verdict": "PASS"},
            {"url": "b", "run_id": "r2", "verdict": "BROWSER_BLOCK"},
        ]
        out = mod.latest_per_url(rows)
        urls = [r["url"] for r in out]
        verdicts = [r["verdict"] for r in out]
        self.assertEqual(urls, ["a", "b"])
        self.assertEqual(verdicts, ["PASS", "BROWSER_BLOCK"])

    def test_run_id_filter(self):
        rows = [
            {"url": "a", "run_id": "r1", "verdict": "PRODUCT_FAIL"},
            {"url": "a", "run_id": "r2", "verdict": "PASS"},
        ]
        out = mod.latest_per_url(rows, run_id="r1")
        self.assertEqual(out[0]["verdict"], "PRODUCT_FAIL")


if __name__ == "__main__":
    unittest.main(verbosity=2)
