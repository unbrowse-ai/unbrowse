"""Claude QA's shards: every check given to one shard, and one verdict that fails on any gap (UNB-235)."""
import json
import os
import tempfile
import unittest
from pathlib import Path

import merge_shards as m

QA = Path(__file__).resolve().parent
WORKFLOWS = QA.parent / "workflows"
CHECKLIST = (QA / "checklist.md").read_text()


class PlanTest(unittest.TestCase):
    def test_every_check_is_given_to_exactly_one_shard_in_both_workflows(self):
        numbers = m.checklist_numbers(CHECKLIST)
        self.assertEqual(numbers, list(range(1, len(numbers) + 1)))
        self.assertGreaterEqual(len(numbers), 27)
        for name in ("qa.yml", "pr-agent-checks.yml"):
            with self.subTest(workflow=name):
                shards = m.plan((WORKFLOWS / name).read_text())
                self.assertGreaterEqual(len(shards), 3)
                self.assertEqual(m.plan_problems(shards, numbers), [])

    def test_both_workflows_shard_the_same_way(self):
        self.assertEqual(m.plan((WORKFLOWS / "qa.yml").read_text()), m.plan((WORKFLOWS / "pr-agent-checks.yml").read_text()))

    def test_no_window_check_uses_a_fresh_browser_session(self):
        # PR #975, run 45777818287: reusing check 6's tab hit its script safety guard.
        check = CHECKLIST.split("\n7. ", 1)[1].split("\n8. ", 1)[0]
        self.assertIn("fresh browser session `qa-no-window`", check)
        self.assertIn("In that session, call", check)
        self.assertIn("no Unbrowse window is open", check)
        self.assertIn('["snapshot", "-i"]', check)

    def test_a_check_that_leans_on_another_runs_in_its_shard(self):
        # checklist.md: 2, 3, 12 and 13 use check 1's route; 5 and 6 check 4's page; 11 check 10's session; 15 check
        # 14's goal; 26 checks 25's window. 27 opens a window of its own, so it can run beside 25 and 26: their shard
        # was the run's longest (6.0 minutes against 2.7 to 3.4 for the others, median of the 15 PRs before 22 Nov 2026).
        leans = {2: 1, 3: 1, 12: 1, 13: 1, 5: 4, 6: 5, 11: 10, 15: 14, 26: 25}
        owner = {n: s for s, checks in m.plan((WORKFLOWS / "qa.yml").read_text()).items() for n in checks}
        for n, on in leans.items():
            self.assertEqual(owner[n], owner[on], f"check {n} leans on check {on}")

    def test_a_gap_or_a_double_is_found(self):
        self.assertEqual(m.plan_problems({1: [1, 2], 2: [2]}, [1, 2, 3]),
                         ["check 2 is given to shard 1 and shard 2", "check 3 is given to no shard"])
        self.assertEqual(m.plan_problems({1: [1, 9]}, [1]), ["shard 1 is given check 9, which checklist.md doesn't have"])

    def test_the_plan_check_prints_its_marker_and_fails_on_a_gap(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "qa.yml"
            bad.write_text('      - shard: 1\n        checks: "1,2"\n')
            self.assertEqual(m.main(["--checklist", str(QA / "checklist.md"), "--plan", str(bad)]), 1)
        self.assertEqual(m.main(["--checklist", str(QA / "checklist.md"), "--plan", str(WORKFLOWS / "qa.yml")]), 0)


def shard(root, n, verdict, report="ok"):
    folder = root / f"qa-report-{n}"
    (folder / "shots" / "steps").mkdir(parents=True)
    if verdict is not None:
        (folder / "qa-verdict.json").write_text(json.dumps(verdict))
    (folder / "qa-report.md").write_text(report)
    (folder / "qa-cost.json").write_text('{"total_cost_usd": 1}')
    (folder / "shots" / f"check-0{n}.png").write_bytes(b"\x89PNG")
    (folder / "shots" / "steps" / f"s{n}-001-x.png").write_bytes(b"\x89PNG")
    return folder


class MergeTest(unittest.TestCase):
    SHARDS = {1: [1, 2], 2: [3]}

    def run_merge(self, build):
        with tempfile.TemporaryDirectory() as tmp:
            root, out = Path(tmp) / "in", Path(tmp) / "out"
            root.mkdir()
            build(root)
            found = {int(f.name.rsplit("-", 1)[1]): f for f in root.glob("qa-report-*")}
            verdict = m.merge(found, [1, 2, 3], self.SHARDS, out)
            files = sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file())
            return verdict, files, (out / "qa-report.md").read_text()

    def test_all_shards_passing_is_a_pass_with_every_check_in_order(self):
        def build(root):
            shard(root, 2, {"pass": True, "checks": [{"n": 3, "result": "pass"}]})
            shard(root, 1, {"pass": True, "checks": [{"n": 2, "result": "blocked"}, {"n": 1, "result": "pass"}]})
        verdict, files, report = self.run_merge(build)
        self.assertTrue(verdict["pass"], verdict["problems"])
        self.assertEqual([c["n"] for c in verdict["checks"]], [1, 2, 3])
        self.assertIn("shots/check-01.png", files)
        self.assertIn("shots/steps/s2-001-x.png", files)
        self.assertIn("qa-cost-1.json", files)
        self.assertIn("Shard 1: checks 1, 2", report)

    def test_a_missing_shard_a_missing_check_or_a_failed_check_fails(self):
        cases = {
            "no artifact": lambda root: shard(root, 1, {"pass": True, "checks": [{"n": 1, "result": "pass"}, {"n": 2, "result": "pass"}]}),
            "no verdict": lambda root: (shard(root, 1, None), shard(root, 2, {"pass": True, "checks": [{"n": 3, "result": "pass"}]})),
            "check left out": lambda root: (shard(root, 1, {"pass": True, "checks": [{"n": 1, "result": "pass"}]}),
                                            shard(root, 2, {"pass": True, "checks": [{"n": 3, "result": "pass"}]})),
            "a fail": lambda root: (shard(root, 1, {"pass": True, "checks": [{"n": 1, "result": "pass"}, {"n": 2, "result": "fail"}]}),
                                    shard(root, 2, {"pass": True, "checks": [{"n": 3, "result": "pass"}]})),
            "shard says fail": lambda root: (shard(root, 1, {"pass": False, "checks": [{"n": 1, "result": "pass"}, {"n": 2, "result": "pass"}]}),
                                             shard(root, 2, {"pass": True, "checks": [{"n": 3, "result": "pass"}]})),
            "answers another's check": lambda root: (shard(root, 1, {"pass": True, "checks": [{"n": 1, "result": "pass"}, {"n": 2, "result": "pass"}, {"n": 3, "result": "pass"}]}),
                                                     shard(root, 2, {"pass": True, "checks": [{"n": 3, "result": "fail"}]})),
        }
        for name, build in cases.items():
            with self.subTest(name):
                verdict, _, report = self.run_merge(build)
                self.assertFalse(verdict["pass"])
                self.assertEqual(len(verdict["checks"]), 3)
                self.assertIn("Across the shards", report)

    def test_a_planted_link_is_not_followed(self):
        def build(root):
            secret = root / "secret.json"
            secret.write_text('{"pass": true, "checks": [{"n": 1, "result": "pass"}, {"n": 2, "result": "pass"}]}')
            folder = shard(root, 1, None)
            os.symlink(secret, folder / "qa-verdict.json")
            shard(root, 2, {"pass": True, "checks": [{"n": 3, "result": "pass"}]})
        verdict, _, _ = self.run_merge(build)
        self.assertFalse(verdict["pass"])
        self.assertIn("shard 1 wrote no verdict", verdict["problems"])


if __name__ == "__main__":
    unittest.main()
