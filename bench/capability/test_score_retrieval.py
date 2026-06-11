#!/usr/bin/env python3
"""Day-4 luminaries — falsifiable signals over the Step-3 Axis-A seed.

Run: python3 bench/capability/test_score_retrieval.py
Each test would FAIL if the scorer math, abstention logic, adapter JSON parser, or
corpus/gold alignment regressed. The load-bearing one (Luke 15:4) is the end-to-end
aggregate pin: nDCG@10 must equal exactly 0.6577 on the committed fixture.
"""
import importlib.util
import json
import math
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(modname, relpath):
    spec = importlib.util.spec_from_file_location(modname, os.path.join(HERE, relpath))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


score = _load("score_retrieval", "score_retrieval.py")
adapter = _load("unbrowse_cli", "adapters/unbrowse_cli.py")


class TestNDCG(unittest.TestCase):
    def test_relevant_at_rank0_is_one(self):
        self.assertAlmostEqual(score.ndcg_at_k(["a", "b", "c"], {"a"}, 10), 1.0)

    def test_relevant_at_rank1_is_log2_3(self):
        # gain at index 1 -> 1/log2(3); idcg with one relevant -> 1/log2(2)=1
        self.assertAlmostEqual(score.ndcg_at_k(["x", "a", "b"], {"a"}, 10), 1 / math.log2(3), places=4)

    def test_miss_is_zero(self):
        self.assertEqual(score.ndcg_at_k(["x", "y"], {"a"}, 10), 0.0)

    def test_empty_relevant_is_zero(self):
        self.assertEqual(score.ndcg_at_k(["x"], set(), 10), 0.0)


class TestRecall(unittest.TestCase):
    def test_full_recall(self):
        self.assertEqual(score.recall_at_k(["a", "b"], {"a", "b"}, 10), 1.0)

    def test_partial_recall(self):
        self.assertEqual(score.recall_at_k(["a", "x"], {"a", "b"}, 10), 0.5)

    def test_k_truncates(self):
        self.assertEqual(score.recall_at_k(["x", "a"], {"a"}, 1), 0.0)


class TestShortlistTolerance(unittest.TestCase):
    def test_bare_strings(self):
        self.assertEqual(score.shortlist_ids({"shortlist": ["a", "b"]}), ["a", "b"])

    def test_endpoint_id_objects(self):
        self.assertEqual(score.shortlist_ids({"shortlist": [{"endpoint_id": "a"}, {"id": "b"}]}), ["a", "b"])

    def test_empty(self):
        self.assertEqual(score.shortlist_ids({}), [])


class TestAdapterParser(unittest.TestCase):
    def test_last_json_amid_trace_noise(self):
        # mirrors the real CLI: verbose trace lines then a clean JSON line
        noisy = '[07:16:24] [trace] BEGIN\n[unbrowse] ToS skipped\n{"error":"no_active_session"}\n'
        self.assertEqual(adapter._last_json(noisy), {"error": "no_active_session"})

    def test_last_json_none_when_absent(self):
        self.assertIsNone(adapter._last_json("just trace\nno json here\n"))

    def test_find_result_body_skips_trailing_log(self):
        # the resolve body precedes a trailing info-log JSON line; must NOT return the log
        text = ('{"shortlist":[{"endpoint_id":"a"}]}\n'
                '{"level":"info","msg":"done"}\n')
        body = adapter._find_result_body(text)
        self.assertIn("shortlist", body)
        self.assertEqual(body["shortlist"][0]["endpoint_id"], "a")

    def test_find_result_body_surfaces_error_envelope(self):
        body = adapter._find_result_body('[trace]\n{"error":"no_active_session"}\n')
        self.assertEqual(body, {"error": "no_active_session"})


class TestTypeCoercion(unittest.TestCase):
    """Day-8 books: int endpoint ids must compare equal to string gold (silent-0 bug)."""
    def test_int_shortlist_ids_coerced(self):
        self.assertEqual(score.shortlist_ids({"shortlist": [{"endpoint_id": 1}, 2]}), ["1", "2"])


class TestCorpusAlignment(unittest.TestCase):
    """Schema signal: every corpus id has a qrels row and a fixture row; no orphans."""
    def _ids(self, path):
        with open(os.path.join(HERE, path)) as f:
            return {json.loads(l)["id"] for l in f if l.strip()}

    def test_corpus_qrels_fixture_aligned(self):
        corpus = self._ids("corpus/R.jsonl")
        qrels = self._ids("gold/axisA_qrels.jsonl")
        fixture = self._ids("snapshots/resolve_R_fixture.jsonl")
        self.assertEqual(corpus, qrels, "qrels must cover exactly the corpus ids")
        self.assertEqual(corpus, fixture, "fixture must cover exactly the corpus ids")


class TestAdversarial(unittest.TestCase):
    """Day-5 living input — the lost-sheep cases. Duplicate endpoints must not
    earn credit twice; metrics must never exceed 1.0 on degenerate input."""
    def test_duplicate_endpoint_caps_recall(self):
        self.assertEqual(score.recall_at_k(["a", "a"], {"a"}, 10), 1.0)

    def test_duplicate_endpoint_caps_ndcg(self):
        self.assertEqual(score.ndcg_at_k(["a", "a"], {"a"}, 10), 1.0)

    def test_triple_dup_partial_recall(self):
        self.assertEqual(score.recall_at_k(["a", "a", "a"], {"a", "b"}, 10), 0.5)

    def test_missing_result_row_is_miss(self):
        self.assertEqual(score.ndcg_at_k([], {"a"}, 10), 0.0)

    def test_malformed_shortlist_items_skipped(self):
        self.assertEqual(
            score.shortlist_ids({"shortlist": [None, {"foo": "bar"}, {"endpoint_id": "a"}, "b"]}),
            ["a", "b"],
        )


class TestEndToEnd(unittest.TestCase):
    """Luke 15:4 — the load-bearing pin. The committed fixture must score exactly this."""
    def _run(self, *extra):
        cmd = [sys.executable, os.path.join(HERE, "score_retrieval.py"),
               "--corpus", os.path.join(HERE, "corpus/R.jsonl"),
               "--qrels", os.path.join(HERE, "gold/axisA_qrels.jsonl"),
               "--results", os.path.join(HERE, "snapshots/resolve_R_fixture.jsonl"),
               *extra]
        return subprocess.run(cmd, capture_output=True, text=True)

    def test_aggregate_pinned(self):
        p = self._run()
        self.assertEqual(p.returncode, 0)
        out = json.loads(p.stdout)
        self.assertEqual(out["ndcg@10"], 0.6577)
        self.assertEqual(out["recall@10"], 0.75)
        self.assertEqual(out["abstention_acc"], 1.0)

    def test_gate_rejects_high_threshold(self):
        p = self._run("--gate", "--min-ndcg", "0.9")
        self.assertEqual(p.returncode, 1, "gate must FAIL when nDCG below threshold")

    def test_gate_passes_low_threshold(self):
        p = self._run("--gate", "--min-ndcg", "0.5")
        self.assertEqual(p.returncode, 0, "gate must PASS when nDCG above threshold")


if __name__ == "__main__":
    unittest.main(verbosity=2)
