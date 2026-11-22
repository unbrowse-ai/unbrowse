import json
import tempfile
import unittest
from pathlib import Path

import hard_sites

HERE = Path(__file__).resolve().parent
LIST = HERE / "staging-hard-sites.json"
STEPS = ("first", "replay", "call_unrelated", "no_results", "recheck")


def checks(**outcomes):
    """Five checks, each `pass` unless named: checks(replay="ok_but_wrong")."""
    return [{"step": s, "outcome": outcomes.get(s, "pass")} for s in STEPS]


class TheList(unittest.TestCase):
    def setUp(self):
        self.cases = hard_sites.cases(LIST)

    def test_it_holds_thirty_distinct_sites(self):
        self.assertEqual(len(self.cases), 30)
        self.assertEqual(len({c["site"] for c in self.cases}), 30)

    def test_every_site_says_why_it_is_hard_with_evidence_and_what_a_right_answer_holds(self):
        for c in self.cases:
            hard = c.get("hard") or {}
            for key in ("gate", "why", "right"):
                self.assertTrue(str(hard.get(key, "")).strip(), f"{c['site']}: no {key}")
            self.assertTrue(hard.get("evidence"), f"{c['site']}: no evidence")

    def test_every_case_is_one_run_bank_can_ask(self):
        for c in self.cases:
            self.assertIn("{q}", c["url"], c["site"])
            self.assertEqual(len(c["values"]), 3, c["site"])
            self.assertTrue(c["goal"].strip(), c["site"])

    def test_no_two_sites_share_a_domain_so_one_wall_skips_no_other_site(self):
        domains = [hard_sites.run_bank.registrable(c) for c in self.cases]
        self.assertEqual(len(domains), len(set(domains)), domains)

    def test_a_run_id_named_as_evidence_is_one_the_list_describes(self):
        doc = json.loads(LIST.read_text())
        for c in self.cases:
            for e in c["hard"]["evidence"]:
                head = e.split()[0]
                if head.isdigit():
                    self.assertIn(head, doc["evidence_runs"], f"{c['site']}: {e}")


class Shards(unittest.TestCase):
    def test_every_site_lands_in_exactly_one_shard(self):
        sites = [c["site"] for c in hard_sites.cases(LIST)]
        for count in (1, 6, 10):
            got = [s for i in range(count) for s in hard_sites.shard(sites, i, count)]
            self.assertEqual(sorted(got), sorted(sites))

    def test_a_shard_is_one_run_bank_batch(self):
        sites = [c["site"] for c in hard_sites.cases(LIST)]
        for i in range(10):
            self.assertLessEqual(len(hard_sites.shard(sites, i, 10)), hard_sites.run_bank.MAX_BATCH)

    def test_a_shard_outside_the_count_is_refused(self):
        with self.assertRaises(SystemExit):
            hard_sites.shard(["a"], 10, 10)


class Labels(unittest.TestCase):
    def test_five_passes_with_no_browser_is_right(self):
        self.assertEqual(hard_sites.label({"checks": checks()})[0], "right")

    def test_five_passes_through_the_browser_need_a_browser(self):
        self.assertEqual(hard_sites.label({"checks": checks(), "warm_in_browser": ["replay"]})[0], "needs a browser")

    def test_a_page_that_needed_hands_needs_a_browser(self):
        record = {"checks": [{"step": "first", "outcome": "fail", "why": "needs_hands"}] + checks()[1:]}
        self.assertEqual(hard_sites.label(record)[0], "needs a browser")

    def test_a_wall_is_walled(self):
        self.assertEqual(hard_sites.label({"checks": checks(first="blocked")})[0], "walled")
        self.assertEqual(hard_sites.label({"checks": checks(first="requires_account")})[0], "walled")
        self.assertEqual(hard_sites.label({"checks": checks(replay="fail"), "stopped": "rate_limited"})[0], "walled")

    def test_a_site_skipped_for_a_wall_on_its_domain_is_walled(self):
        self.assertEqual(hard_sites.label(None, {"why": "a_wall_on_this_domain"})[0], "walled")

    def test_an_answer_the_rule_reads_as_wrong_is_wrong(self):
        self.assertEqual(hard_sites.label({"checks": checks(replay="ok_but_wrong")})[0], "wrong")
        self.assertEqual(hard_sites.label({"checks": checks(recheck="fail")})[0], "wrong")

    def test_a_reply_the_node_was_still_working_on_is_unknown_not_wrong(self):
        working = {"outcome": "fail", "why": "http_200", "how": "working"}
        record = {"checks": [dict(working, step="first"), dict(working, step="replay")]}
        self.assertEqual(hard_sites.label(record)[0], "unknown")
        mixed = checks()
        mixed[1].update(working)
        self.assertEqual(hard_sites.label({"checks": mixed})[0], "unknown")
        mixed[3]["outcome"] = "ok_but_wrong"
        self.assertEqual(hard_sites.label({"checks": mixed})[0], "wrong", "a real wrong answer beside it is still wrong")

    def test_no_record_a_timeout_or_a_safety_stop_is_unknown(self):
        self.assertEqual(hard_sites.label(None)[0], "unknown")
        self.assertEqual(hard_sites.label({"checks": checks(replay="fail"), "stopped": "timeout"})[0], "unknown")
        self.assertEqual(hard_sites.label({"checks": checks(first="safety_stop")})[0], "unknown")
        self.assertEqual(hard_sites.label({"checks": []})[0], "unknown")


class Report(unittest.TestCase):
    def test_a_report_counts_each_site_once_from_every_shard_and_keeps_its_seconds(self):
        listed = [{"site": s, "hard": {"gate": "g"}} for s in ("a.com", "b.com", "c.com", "d.com")]
        with tempfile.TemporaryDirectory() as d:
            Path(d, "shard-0").mkdir()
            Path(d, "shard-0", "reads-0.json").write_text(json.dumps({"sites": [
                {"site": "a.com", "checks": checks()}, {"site": "b.com", "checks": checks(first="blocked")}]}))
            Path(d, "shard-0", "times-0.jsonl").write_text('{"site": "a.com", "seconds": 412}\n{"site": "d.com", "seconds": 1500, "capped": true}\n')
            Path(d, "reads-1.json").write_text(json.dumps({"sites": [{"site": "c.com", "checks": checks(replay="ok_but_wrong")}]}))
            result = hard_sites.report(listed, *hard_sites.gather(d))
        self.assertEqual(result["counts"], {"right": 1, "wrong": 1, "needs a browser": 0, "walled": 1, "unknown": 1})
        self.assertEqual({r["site"]: r["seconds"] for r in result["rows"]}["a.com"], 412)
        self.assertIn("time cap", {r["site"]: r["why"] for r in result["rows"]}["d.com"])
        self.assertIn("1 right, 1 wrong, 0 need a browser, 1 walled, 1 unknown, of 4", hard_sites.markdown(result))

    def test_the_run_fails_only_when_no_site_ran(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(hard_sites.main(["report", "--list", str(LIST), "--reads", d]), 1)
            Path(d, "reads-0.json").write_text(json.dumps({"sites": [{"site": "ebay.de", "checks": checks(first="blocked")}]}))
            self.assertEqual(hard_sites.main(["report", "--list", str(LIST), "--reads", d, "--json", str(Path(d, "r.json"))]), 0)
            self.assertEqual(json.loads(Path(d, "r.json").read_text())["counts"]["walled"], 1)


if __name__ == "__main__":
    unittest.main()
