#!/usr/bin/env python3
"""Regression test for bench-local.sh's _classify() rule additions.
Specifically guards the Mode-1 soft-block rule shipped 2026-05-08:
text_bytes<100 + sparse_capture_mostly_noise + no real vendor → BROWSER_BLOCK.

Run:
  python3 scripts/test_bench_classifier.py
"""
import importlib.util
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH_LOCAL = os.path.join(HERE, "bench-local.sh")


def extract_classify():
    """Pull the _classify() function out of bench-local.sh's heredoc and
    return it as a callable. The function lives inside the extract.py
    heredoc starting at `cat > "$OUT_DIR/extract.py" <<'PY'` and ending at `PY`.
    """
    with open(BENCH_LOCAL) as f:
        src = f.read()
    m = re.search(r"<<'PY'\n(.*?)\nPY\n", src, re.S)
    assert m, "could not find embedded extract.py heredoc"
    body = m.group(1)
    # The heredoc references sys.argv at top — make it tolerant by skipping
    # the imperative head and grabbing only the function definition + helpers.
    func_match = re.search(r"def _classify\(row\):.*?(?=\nrow\[)", body, re.S)
    assert func_match, "could not find _classify in heredoc"
    func_src = "import json\n" + func_match.group(0)
    g = {}
    exec(func_src, g)
    return g["_classify"]

classify = extract_classify()

def row(**overrides):
    # Default = a "fell through every rule" row with trace_success=False
    # so it lands on PRODUCT_FAIL unless a specific rule catches it.
    base = {
        "captured_text_bytes": 1000,
        "browser_block_signals": "[]",
        "captured_html_bytes": 5000,
        "captured_api_calls": 1,
        "trace_success": False,
        "source": "live-capture",
        "has_available_operations": False,
        "n_operations": 0,
        "error_code": "",
        "auth_recommended": False,
        "capture_diagnostic": "",
        "all_ops_dom_fallback": False,
        "cli_timeout": False,
    }
    base.update(overrides)
    return base


class TestSoftBlockRule(unittest.TestCase):
    def test_mode1_g2_shape_classifies_browser_block(self):
        """g2.com observed shape: text=6, sparse_capture, no real vendor."""
        v = classify(row(
            captured_text_bytes=6,
            browser_block_signals='["sparse_capture_mostly_noise"]',
        ))
        self.assertEqual(v, "BROWSER_BLOCK")

    def test_mode1_target_shape_classifies_browser_block(self):
        """target.com observed shape: text=90 (still below threshold)."""
        v = classify(row(
            captured_text_bytes=90,
            browser_block_signals='["sparse_capture_mostly_noise"]',
        ))
        self.assertEqual(v, "BROWSER_BLOCK")

    def test_text_at_threshold_does_not_trigger(self):
        """text=100 is the boundary; rule uses < 100, so 100 falls through."""
        v = classify(row(
            captured_text_bytes=100,
            browser_block_signals='["sparse_capture_mostly_noise"]',
        ))
        # Falls through to PRODUCT_FAIL since no other rule matches
        self.assertEqual(v, "PRODUCT_FAIL")

    def test_real_vendor_takes_precedence_over_soft_block(self):
        """If a real vendor is named, that's the BROWSER_BLOCK reason — not soft-block.
        Behavior should still be BROWSER_BLOCK but via the vendor-rule path
        (validates the rule order doesn't shadow the more specific rule)."""
        v = classify(row(
            captured_text_bytes=6,
            browser_block_signals='["vendor:cloudflare", "sparse_capture_mostly_noise"]',
        ))
        self.assertEqual(v, "BROWSER_BLOCK")

    def test_sparse_alone_with_rich_text_does_not_trigger(self):
        """sparse_capture_mostly_noise on a page that DID render rich text
        should not be soft-blocked — that's a real PRODUCT_FAIL scenario."""
        v = classify(row(
            captured_text_bytes=10000,
            browser_block_signals='["sparse_capture_mostly_noise"]',
        ))
        self.assertEqual(v, "PRODUCT_FAIL")

    def test_text_below_100_without_sparse_signal_does_not_trigger(self):
        """Soft-block requires BOTH text<100 AND sparse signal — text alone
        shouldn't fire (could be a tiny but legitimate JSON response)."""
        v = classify(row(
            captured_text_bytes=50,
            browser_block_signals="[]",
            trace_success=True,
            source="direct-fetch",
        ))
        self.assertEqual(v, "PASS")

    def test_direct_document_success_classifies_pass(self):
        """Bloomberg direct-document returns useful HTML without operations."""
        v = classify(row(
            captured_text_bytes=4000,
            trace_success=True,
            source="direct-document",
        ))
        self.assertEqual(v, "PASS")


if __name__ == "__main__":
    unittest.main(verbosity=2)
