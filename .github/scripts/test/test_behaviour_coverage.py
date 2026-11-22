"""behaviour_coverage.py: what it counts, what it leaves out, and what it refuses."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import behaviour_coverage as bc  # noqa: E402

SRC = """fn serve() {
    let a = 1;
    let b = 2;
}

#[cfg(test)]
mod tests {
    #[test]
    fn t() {}
}
"""


def tree(lcov_hits):
    root = tempfile.mkdtemp()
    os.makedirs(os.path.join(root, "unbrowse-node/app/src/api"))
    with open(os.path.join(root, "unbrowse-node/app/src/api/goal.rs"), "w") as f:
        f.write(SRC)
    lcov = os.path.join(root, "b.lcov")
    with open(lcov, "w") as f:
        f.write("SF:/runner/work/x/unbrowse-node/app/src/api/goal.rs\n")
        for n, c in lcov_hits.items():
            f.write(f"DA:{n},{c}\n")
        f.write("end_of_record\nSF:/runner/work/x/unbrowse-node/app/src/other.rs\nDA:1,0\nend_of_record\n")
    return root, lcov


CONFIG = {"paths": ["unbrowse-node/app/src/api/goal.rs"], "tests": ["api::tests::a"], "changed_floor": 80}
DIFF = """diff --git a/unbrowse-node/app/src/api/goal.rs b/unbrowse-node/app/src/api/goal.rs
--- a/unbrowse-node/app/src/api/goal.rs
+++ b/unbrowse-node/app/src/api/goal.rs
@@ -2,0 +2,2 @@
+    let a = 1;
+    let b = 2;
"""


class BehaviourCoverage(unittest.TestCase):
    def test_in_file_unit_tests_are_not_the_serving_path(self):
        self.assertEqual(bc.test_module_start(SRC), 6)
        root, lcov = tree({1: 1, 2: 1, 3: 0, 9: 0})
        hits = bc.read_lcov(lcov, root, CONFIG["paths"])
        self.assertEqual(hits, {"unbrowse-node/app/src/api/goal.rs": {1: True, 2: True, 3: False}})

    def test_a_change_no_behaviour_test_runs_is_refused_by_line(self):
        root, lcov = tree({1: 1, 2: 1, 3: 0})
        hits = bc.read_lcov(lcov, root, CONFIG["paths"])
        problems, report = bc.judge(CONFIG, hits, root, "test api::tests::a ... ok\n", bc.parse_diff(DIFF))
        self.assertEqual(report["changed"]["covered"], 1)
        self.assertEqual(report["changed"]["total"], 2)
        self.assertEqual(len(problems), 1)
        self.assertIn("goal.rs: 3", problems[0])

    def test_a_change_the_behaviour_suite_runs_passes(self):
        root, lcov = tree({1: 1, 2: 1, 3: 4})
        hits = bc.read_lcov(lcov, root, CONFIG["paths"])
        problems, _ = bc.judge(CONFIG, hits, root, "test api::tests::a ... ok\n", bc.parse_diff(DIFF))
        self.assertEqual(problems, [])

    def test_a_listed_test_that_did_not_pass_is_refused(self):
        root, lcov = tree({1: 1})
        hits = bc.read_lcov(lcov, root, CONFIG["paths"])
        problems, _ = bc.judge(CONFIG, hits, root, "test api::tests::a ... FAILED\n")
        self.assertTrue(any("api::tests::a did not pass" in p for p in problems), problems)

    def test_nothing_ran_is_unmeasured_never_a_pass(self):
        root, lcov = tree({1: 0, 2: 0})
        hits = bc.read_lcov(lcov, root, CONFIG["paths"])
        problems, _ = bc.judge(CONFIG, hits, root)
        self.assertTrue(any(p.startswith("UNMEASURED") for p in problems), problems)
        problems, _ = bc.judge(CONFIG, {}, root)
        self.assertTrue(any(p.startswith("UNMEASURED") for p in problems), problems)

    def test_a_path_that_names_no_file_is_refused(self):
        root, lcov = tree({1: 1})
        cfg = dict(CONFIG, paths=CONFIG["paths"] + ["unbrowse-node/app/src/gone.rs"])
        problems, _ = bc.judge(cfg, bc.read_lcov(lcov, root, cfg["paths"]), root)
        self.assertTrue(any("gone.rs" in p for p in problems), problems)

    def test_the_repositorys_config_names_files_that_exist(self):
        repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        cfg = bc.json.load(open(os.path.join(repo, ".github", "behaviour.json")))
        for p in cfg["paths"]:
            self.assertTrue(bc.glob.glob(os.path.join(repo, p)), p)
        self.assertEqual(len(cfg["tests"]), len(set(cfg["tests"])), "a test listed twice")


if __name__ == "__main__":
    unittest.main()
