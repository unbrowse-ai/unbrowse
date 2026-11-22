"""journey_coverage.py: the repository's journeys are all covered, and each way a journey can lose its QA step is caught."""
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import journey_coverage as jc  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


class Repo:
    """A copy of the files the check reads, to break one at a time."""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp())
        for rel in (".github/qa/journeys.json", ".github/qa/checklist.md", ".github/qa/mcp-journey.json",
                    "test-banks/gate/bank.json", "test-banks/gate/slice.json"):  # fmt: skip
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / rel, self.root / rel)
        shutil.copytree(ROOT / ".github/workflows", self.root / ".github/workflows")
        self.qa = self.root / ".github/qa"

    def journeys(self):
        return json.loads((self.qa / "journeys.json").read_text())

    def save(self, doc):
        (self.qa / "journeys.json").write_text(json.dumps(doc))

    def problems(self):
        return jc.coverage(self.root, self.qa)[1]


class CoverageTest(unittest.TestCase):
    def test_every_journey_in_the_repository_has_a_qa_step_or_a_waiver(self):
        rows, problems = jc.coverage()
        self.assertEqual(problems, [])
        self.assertGreaterEqual(len(rows), 40)
        self.assertEqual(jc.main(["check"]), 0)

    def test_every_surface_is_walked(self):
        rows, _ = jc.coverage()
        walked = {r["surface"] for r in rows if r["walked_by"]}
        self.assertLessEqual({"mcp", "cli", "window", "skill", "install", "bank"}, walked)

    def test_a_journey_no_step_names_fails(self):
        repo = Repo()
        doc = repo.journeys()
        doc["journeys"].append({"id": "qa-new-promise", "surface": "mcp", "promise": "something new", "source": ["here"]})
        repo.save(doc)
        self.assertTrue(any("qa-new-promise has no QA step" in p for p in repo.problems()))

    def test_dropping_a_checks_journeys_line_fails(self):
        repo = Repo()
        text = (repo.qa / "checklist.md").read_text().replace("    Journeys: second-value-is-a-call.\n", "")
        (repo.qa / "checklist.md").write_text(text)
        problems = repo.problems()
        self.assertTrue(any("check 14 names no journey" in p for p in problems), problems)
        self.assertTrue(any("second-value-is-a-call has no QA step" in p for p in problems), problems)

    def test_a_step_naming_an_unknown_journey_fails(self):
        repo = Repo()
        plan = json.loads((repo.qa / "mcp-journey.json").read_text())
        plan["steps"][0]["journeys"] = ["qa-no-such-journey"]
        (repo.qa / "mcp-journey.json").write_text(json.dumps(plan))
        self.assertTrue(any("qa-no-such-journey" in p for p in repo.problems()))

    def test_a_thin_waiver_or_a_waived_journey_that_is_walked_fails(self):
        repo = Repo()
        doc = repo.journeys()
        for j in doc["journeys"]:
            if j["id"] == "route-healing":
                j["waived"] = "hard"
            if j["id"] == "learn-then-call":
                j["waived"] = "a waiver long enough to read but the journey is walked anyway"
        repo.save(doc)
        problems = repo.problems()
        self.assertTrue(any("route-healing: a waiver of 4 characters" in p for p in problems), problems)
        self.assertTrue(any("learn-then-call is waived and also walked" in p for p in problems), problems)

    def test_a_job_or_bank_task_that_does_not_exist_fails(self):
        repo = Repo()
        doc = repo.journeys()
        for j in doc["journeys"]:
            if j["id"] == "skill-chosen-when-it-should-be":
                j["runs_in"] = ["qa.yml#no-such-job"]
            if j["id"] == "bank-filtered-listing":
                j["bank"] = ["qa:no-such-task"]
            if j["id"] == "sdk-do-from-code":
                j["runs_in"] = ["release.yml#sdks"]  # a release, never a push to staging
        repo.save(doc)
        problems = repo.problems()
        self.assertTrue(any("qa.yml#no-such-job names a job that doesn't exist" in p for p in problems), problems)
        self.assertTrue(any("qa:no-such-task isn't in" in p for p in problems), problems)
        self.assertTrue(any("release.yml doesn't run on a push to staging" in p for p in problems), problems)

    def test_a_job_of_a_nightly_workflow_walks_its_journey_nightly(self):
        # bank.yml takes no push (UNB-166): its journey is walked every night, and the report says "nightly", never
        # "pass", for a run that did not read the sites.
        rows, problems = jc.coverage()
        self.assertEqual(problems, [])
        hard = next(r for r in rows if r["id"] == "hard-sites-answer")
        self.assertEqual(hard["walked_by"], ["job bank.yml#hard-sites (nightly)"])
        self.assertTrue(hard["nightly_only"])
        md, tally = jc.journey_report([hard], jc.step_results(None, None, [], {}))
        self.assertEqual(tally["nightly"], 1)
        self.assertEqual(tally["pass"], 0)

    def test_bank_runs_nightly_and_by_hand_never_on_a_push(self):
        on = (ROOT / ".github/workflows/bank.yml").read_text().split("\non:\n", 1)[1].split("\n\n", 1)[0]
        triggers = re.findall(r"(?m)^  ([a-z_]+):", on)
        self.assertEqual(triggers, ["schedule", "workflow_dispatch"])
        self.assertEqual(jc.workflow_jobs(ROOT / ".github/workflows/bank.yml")[1:], (False, True))

    def test_a_workflow_that_runs_neither_on_a_push_nor_nightly_walks_nothing(self):
        repo = Repo()
        bank = repo.root / ".github/workflows/bank.yml"
        bank.write_text(re.sub(r"(?m)^  schedule:\n    - cron: .*\n", "", bank.read_text()))
        self.assertTrue(any("bank.yml doesn't run on a push to staging, nor every night" in p for p in repo.problems()))

    def test_the_check_exits_red_with_its_marker(self):
        repo = Repo()
        doc = repo.journeys()
        doc["journeys"].append({"id": "qa-uncovered", "surface": "cli", "promise": "x", "source": ["y"]})
        repo.save(doc)
        rows, problems = jc.coverage(repo.root, repo.qa)
        self.assertIn("**Journey coverage: fail.**", jc.coverage_md(rows, problems))


class ReportTest(unittest.TestCase):
    def test_a_journey_fails_when_any_step_failed_and_waivers_are_counted_apart(self):
        rows = [
            {"id": "a", "surface": "mcp", "walked_by": ["check 1", "mcp do-learns"], "waived": None},
            {"id": "b", "surface": "cli", "walked_by": ["check 2"], "waived": None},
            {"id": "c", "surface": "bank", "walked_by": ["bank t1", "bank t2 (nightly)"], "waived": None},
            {"id": "d", "surface": "window", "walked_by": ["check 3"], "waived": None},
            {"id": "e", "surface": "network", "walked_by": [], "waived": "needs peers on the network and funded payments"},
            {"id": "f", "surface": "skill", "walked_by": ["job qa.yml#skills"], "waived": None},
        ]
        got = jc.step_results(
            {"checks": [{"n": 1, "result": "pass"}, {"n": 2, "result": "fail", "note": "exit 1"}, {"n": 3, "result": "blocked"}]},
            {"steps": [{"part": "journey", "id": "do-learns", "pass": True, "shot": "04-do-learns.png"}]},
            [{"id": "t1", "outcome": "right"}],
            {"qa.yml#skills": "success"},
        )
        md, tally = jc.journey_report(rows, got)
        self.assertEqual(tally["pass"], 3)  # a, c (its slice task right; the nightly one waits for the night), f
        self.assertEqual(tally["fail"], 1)
        self.assertEqual(tally["blocked"], 1)
        self.assertEqual(tally["waived"], 1)
        self.assertIn("| b | cli | **fail** |", md)
        self.assertIn("[04-do-learns.png]", md)

    def test_a_step_with_no_result_is_not_run_never_pass(self):
        rows = [{"id": "a", "surface": "mcp", "walked_by": ["check 9"], "waived": None}]
        md, tally = jc.journey_report(rows, jc.step_results(None, None, [], {}))
        self.assertEqual(tally["not run"], 1)
        self.assertIn("no result in this run", md)


if __name__ == "__main__":
    unittest.main()
