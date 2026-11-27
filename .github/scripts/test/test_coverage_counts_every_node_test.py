"""coverage.yml's node job: one report counts every node test, the unit tests and the Anvil ones alike.

The measured runs build the node under cargo llvm-cov in target/llvm-cov-target and write their profiles there. Until
27 November 2026 the Anvil step ran `eval "$(cargo llvm-cov show-env)"` first, which points cargo llvm-cov at target/:
the node was built a second time there, and the report, run under the same exports, read only the Anvil tests'
profiles. No unit test of the node was counted (a line only a unit test runs read 0, on staging too), so the ratchet
refused any change whose lines only unit tests run. This holds the step to the measured build: no show-env, the Anvil
tests run on the binary cargo llvm-cov built, and their profiles go beside that build's.
"""
from pathlib import Path
import unittest

import yaml

COVERAGE = Path(__file__).parents[2] / "workflows/coverage.yml"


def measured_step():
    jobs = yaml.safe_load(COVERAGE.read_text(encoding="utf-8"))["jobs"]
    for job in jobs.values():
        for step in job.get("steps", []):
            run = step.get("run", "")
            if step.get("name") == "Tests, measured" and "anvil_tests.py" in run:
                # its commands only: a comment may name what the step no longer does
                return "\n".join(l for l in run.splitlines() if not l.lstrip().startswith("#"))
    raise AssertionError("coverage.yml has no node step named 'Tests, measured' that runs the Anvil tests")


class EveryNodeTestIsCounted(unittest.TestCase):
    def test_the_report_reads_the_measured_build_not_a_second_one(self):
        run = measured_step()
        self.assertNotIn("show-env", run, "show-env points the build and the report at target/, away from the measured runs")
        self.assertNotIn("--no-run", run, "the Anvil tests' binary is the measured build's, not one built again")

    def test_the_anvil_tests_run_on_the_measured_binary_and_profile_beside_it(self):
        run = measured_step()
        self.assertRegex(run, r'anvil_bin=\$\(.*cargo llvm-cov -p unbrowse-node-app --bin unbrowse-node .*--no-report -- --list')
        self.assertRegex(run, r'LLVM_PROFILE_FILE="\$PWD/target/llvm-cov-target/[^"]*%p[^"]*\.profraw"\s*\\\s*\n\s*python3 -I \.\./\.github/scripts/anvil_tests\.py --run')
        report = run.index("cargo llvm-cov report")
        self.assertLess(run.index("anvil_tests.py --run"), report, "the report comes after every measured test")


if __name__ == "__main__":
    unittest.main()
