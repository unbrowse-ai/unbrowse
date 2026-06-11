#!/usr/bin/env python3
"""Day-5 signals over score_execute.py — golden + edges + adversarial, pinned.

The load-bearing adversarial pin (Luke 15:4): an anti-bot HTML challenge page (or any
unparseable payload) MUST score 0 on field checks and never crash — execution did NOT
return the real data.
  Run: python3 bench/capability/test_score_execute.py
"""
import importlib.util
import json
import math
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("score_execute", os.path.join(HERE, "score_execute.py"))
se = importlib.util.module_from_spec(spec)
spec.loader.exec_module(se)

GOLD = {
    "id": "B", "field_checks": [
        {"path": "kind", "op": "equals", "value": "Listing"},
        {"path": "data.children", "op": "min_count", "value": 1},
        {"path": "data.children[].data.subreddit", "op": "all_nonempty"},
        {"path": "data.children[].data.title", "op": "all_nonempty"},
    ],
}


def score(data):
    return se.score_record({"id": "B", "data": data}, GOLD)["score"]


class TestGolden(unittest.TestCase):
    def test_valid_listing_scores_one(self):
        data = json.dumps({"kind": "Listing", "data": {"children": [
            {"data": {"subreddit": "rust", "title": "A post"}}]}})
        self.assertEqual(score(data), 1.0)


class TestEdges(unittest.TestCase):
    def test_empty_listing(self):
        self.assertEqual(score(json.dumps({"kind": "Listing", "data": {"children": []}})), 0.25)

    def test_blank_subreddit(self):
        data = json.dumps({"kind": "Listing", "data": {"children": [
            {"data": {"subreddit": "", "title": "x"}}]}})
        self.assertEqual(score(data), 0.75)


class TestAdversarial(unittest.TestCase):
    def test_html_challenge_is_zero_no_crash(self):
        self.assertEqual(score("<html>Just a moment... Cloudflare checking</html>"), 0.0)

    def test_truncated_json_is_zero_no_crash(self):
        self.assertEqual(score('{"kind":"Listing","dat'), 0.0)

    def test_error_envelope_is_zero(self):
        self.assertEqual(score(json.dumps({"error": "rate limited"})), 0.0)


class TestTextMetrics(unittest.TestCase):
    def test_token_f1_perfect(self):
        self.assertEqual(se.token_f1("the rust book", "the rust book"), 1.0)

    def test_token_f1_partial(self):
        self.assertGreater(se.token_f1("the rust book", "the rust"), 0.0)

    def test_token_f1_disjoint_zero(self):
        self.assertEqual(se.token_f1("abc", "xyz"), 0.0)

    def test_rouge_l_order_matters(self):
        # full LCS
        self.assertEqual(se.rouge_l("a b c", "a b c"), 1.0)
        # reordered → lower LCS-F1
        self.assertLess(se.rouge_l("c b a", "a b c"), 1.0)

    def test_rouge_l_empty_zero(self):
        self.assertEqual(se.rouge_l("", "x"), 0.0)


class TestPathResolver(unittest.TestCase):
    def test_index_and_all(self):
        obj = {"a": [{"b": 1}, {"b": 2}]}
        self.assertEqual(se._resolve_all(obj, se._split_path("a[0].b")), 1)
        self.assertEqual(se._resolve_all(obj, se._split_path("a[].b")), [1, 2])



class TestAuditFixes(unittest.TestCase):
    """Day-8 books: fixes for the wrong-page / hollow-payload / token-leak holes."""
    def test_exists_rejects_empty_list(self):
        # exists on a []-resolved EMPTY list must be False (no real rows)
        self.assertFalse(se.check_field({"data": {"children": []}},
                                        {"path": "data.children[].data.title", "op": "exists"}))

    def test_contains_only_string_leaves(self):
        # contains must NOT match against serialized-JSON structural chars
        self.assertFalse(se.check_field({"data": {"children": [{"x": 1}]}},
                                        {"path": "data.children", "op": "contains", "value": "["}))
        self.assertTrue(se.check_field({"data": {"sub": "rust-lang"}},
                                       {"path": "data.sub", "op": "contains", "value": "rust"}))

    def test_html_with_answer_text_still_zero(self):
        # MED-5: an HTML wall must score 0 EVEN when gold also has answer_text (no token leak)
        gold = {"id": "X", "field_checks": [{"path": "kind", "op": "equals", "value": "Listing"}],
                "answer_text": "the rust book loading please wait"}
        r = se.score_record({"id": "X", "data": "<html>the rust book loading please wait</html>"}, gold)
        self.assertEqual(r["score"], 0.0)

    def test_subreddit_equality_catches_wrong_page(self):
        gold = {"id": "X", "field_checks": [{"path": "data.children[0].data.subreddit", "op": "equals", "value": "rust"}]}
        right = json.dumps({"data": {"children": [{"data": {"subreddit": "rust"}}]}})
        wrong = json.dumps({"data": {"children": [{"data": {"subreddit": "programming"}}]}})
        self.assertEqual(se.score_record({"id": "X", "data": right}, gold)["score"], 1.0)
        self.assertEqual(se.score_record({"id": "X", "data": wrong}, gold)["score"], 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
