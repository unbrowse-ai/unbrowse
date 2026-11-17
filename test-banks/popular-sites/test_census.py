import json
import tempfile
import unittest
from pathlib import Path

from run_bank import census, judge_site, made_lines


def line(site, rung, ok=True, **more):
    return {"at": 1, "route": f"route-{site}", "site": site, "ok": ok, "ms": 5, "rung": rung, "steps": [rung], "browser": rung >= 4, "model_requests": 0, **more}


class CensusTests(unittest.TestCase):
    def test_counts_calls_by_their_highest_rung(self):
        result = census([line("a.example", 0), line("a.example", 0), line("b.example", 3), line("c.example", 5), line("d.example", 4)])
        self.assertEqual(result["calls"], 5)
        self.assertEqual(result["by_rung"], {"0": 2, "1": 0, "2": 0, "3": 1, "4": 1, "5": 1})
        self.assertEqual(sum(result["by_rung"].values()), result["calls"])

    def test_a_call_answers_with_no_browser_only_below_the_page_rung_and_only_when_it_answered(self):
        result = census([line("a.example", 0), line("a.example", 3), line("a.example", 2, ok=False), line("b.example", 4), line("b.example", 5, ok=False)])
        self.assertEqual(result["answered"], 3)
        self.assertEqual(result["browserless_answered"], 2)
        self.assertEqual(len(result["browser_calls"]), 2)

    def test_a_sites_wrong_or_blocked_answers_are_not_answers(self):
        lines = [line("wrong.example", 0), line("blocked.example", 0), line("fine.example", 0)]
        result = census(lines, {"wrong.example": "ok_but_wrong", "blocked.example": "blocked", "fine.example": "pass"})
        self.assertEqual(result["answered"], 1)
        self.assertEqual(result["browserless_answered"], 1)
        self.assertEqual(result["calls"], 3)

    def test_a_route_on_a_host_of_the_site_takes_the_sites_outcome(self):
        lines = [line("www.shop.example", 0), line("api.shop.example", 0), line("shop.example", 0), line("notshop.example", 0), line("other.example", 0)]
        result = census(lines, {"shop.example": "blocked", "example": "pass"})
        self.assertEqual(result["answered"], 2, "the three hosts of the blocked site answered nothing; the longest name decides")

    def test_a_route_the_run_called_takes_its_sites_outcome_wherever_the_site_sent_it(self):
        # shop.example sends its visitors to shop.example.sg: the route's host names another site, the route is the same.
        lines = [line("www.shop.example.sg", 0), line("www.shop.example.sg", 0), line("www.other.example", 0)]
        lines[0]["route"] = lines[1]["route"] = "r-shop"
        result = census(lines, {"shop.example": "ok_but_wrong"}, {"r-shop": "ok_but_wrong"})
        self.assertEqual(result["answered"], 1, "only the call the run says nothing of is taken at its word")

    def test_a_site_the_node_could_not_do_answered_nothing_though_its_calls_said_ok(self):
        result = census([line("a.example", 0), line("b.example", 0), line("c.example", 0)], {"a.example": "fail", "b.example": "false_failure", "c.example": "pass_after_retry"})
        self.assertEqual((result["answered"], result["browserless_answered"]), (2, 2))

    def test_every_call_that_needed_a_browser_says_what_binds_it(self):
        lines = [line("door.example", 5, ok=False), line("login.example", 4), line("other.example", 5), line("said.example", 4, bound_by="entropy")]
        result = census(lines, {"door.example": "blocked", "login.example": "requires_account", "other.example": "pass"})
        self.assertEqual([c["bound_by"] for c in result["browser_calls"]], ["door", "person", "unplaced", "entropy"])
        self.assertEqual([c["case"] for c in result["browser_calls"]], ["door.example", "login.example", "other.example", "said.example"])

    def test_a_sites_outcome_is_read_from_its_checks(self):
        passed = [{"step": s, "outcome": "pass"} for s in ("first", "replay", "call_unrelated", "no_results", "recheck")]
        self.assertEqual(judge_site(passed), "pass")
        self.assertEqual(judge_site(passed[:-1] + [{"step": "recheck", "outcome": "blocked"}]), "blocked")

    def test_model_requests_are_added_up(self):
        self.assertEqual(census([line("a.example", 0, model_requests=2), line("a.example", 0)])["model_calls"], 2)

    def test_a_rung_outside_the_ladder_is_refused(self):
        with self.assertRaises(ValueError):
            census([line("a.example", 6)])

    def test_the_log_is_read_a_line_a_call(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(made_lines(home), [])
            Path(home, "made.jsonl").write_text(json.dumps(line("a.example", 0)) + "\n\n" + json.dumps(line("b.example", 5)) + "\n")
            self.assertEqual([l["site"] for l in made_lines(home)], ["a.example", "b.example"])


if __name__ == "__main__":
    unittest.main()
