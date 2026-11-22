"""The daily watch on the root's expiry (REL-05) goes red on its own: the timestamp nodes need keeps being signed whatever
it says, and it runs beside no key.

    python3 -m unittest discover -s .github/scripts/test -p 'test_*.py'
"""

import pathlib
import unittest

import yaml

UPDATES = pathlib.Path(__file__).resolve().parent.parent.parent / "workflows" / "updates.yml"
ROOT = UPDATES.parents[1]
WORKFLOWS = UPDATES.parent


class RootWatch(unittest.TestCase):
    def setUp(self):
        self.jobs = yaml.safe_load(UPDATES.read_text())["jobs"]

    def test_the_daily_run_checks_the_root(self):
        job = self.jobs["root"]
        self.assertTrue(any("updates.mjs root-check" in s.get("run", "") for s in job["steps"]))
        self.assertIn("schedule", job["if"], "a halt run by hand isn't turned red by it")

    def test_a_root_near_its_end_stops_no_signing(self):
        self.assertNotIn("needs", self.jobs["root"])
        for name, job in self.jobs.items():
            self.assertNotIn("root", job.get("needs", []), name)

    def test_it_holds_no_key_and_no_environment(self):
        self.assertNotIn("environment", self.jobs["root"])
        self.assertNotIn("secrets.", yaml.safe_dump(self.jobs["root"]))

    def test_every_pull_request_checks_root_transition_metadata(self):
        ci = yaml.safe_load((WORKFLOWS / "ci.yml").read_text())
        triggers = ci.get(True, ci.get("on", {}))
        self.assertIn("pull_request", triggers)
        steps = ci["jobs"]["papers"]["steps"]
        self.assertTrue(any("updates.mjs root-check" in step.get("run", "") and "--main-updates" in step.get("run", "") for step in steps))
        self.assertTrue(any(step.get("with", {}).get("ref") == "main" and step.get("with", {}).get("path") == "trusted-main" for step in steps))

    def test_release_checks_root_transition_metadata_before_update_signing(self):
        release = yaml.safe_load((WORKFLOWS / "release.yml").read_text())
        steps = release["jobs"]["sign-updates"]["steps"]
        check = next(i for i, step in enumerate(steps) if "updates.mjs root-check" in step.get("run", ""))
        self.assertIn("--main-updates", steps[check]["run"])
        sign = next(i for i, step in enumerate(steps) if "updates.mjs release" in step.get("run", ""))
        self.assertLess(check, sign)

    def test_ci_runs_root_check_and_this_folder_for_every_pull_request(self):
        ci = yaml.safe_load((WORKFLOWS / "ci.yml").read_text())
        triggers = ci.get(True, ci.get("on", {}))
        self.assertIn("pull_request", triggers)
        self.assertNotIn("paths", triggers["pull_request"] or {})
        steps = ci["jobs"]["papers"]["steps"]
        runs = [step.get("run", "") for step in steps]
        self.assertTrue(any("unittest discover -s .github/scripts/test -p 'test_*.py'" in run for run in runs))
        self.assertTrue(any("node --test .github/scripts/test/*.test.mjs" in run for run in runs))
        self.assertTrue(any("check_signing_jobs.py" in run for run in runs))
        self.assertTrue(any("updates.mjs root-check" in step.get("run", "") and "--main-updates" in step.get("run", "") for step in steps))


if __name__ == "__main__":
    unittest.main()
