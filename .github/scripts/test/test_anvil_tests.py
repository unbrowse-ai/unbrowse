"""anvil_tests.py: coverage picks the node's tests that need Anvil, and no other ignored test."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import anvil_tests as at  # noqa: E402

SRC = """#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn a_coin_is_bought_on_the_chain() {}

    #[test]
    #[ignore = "needs the network"]
    fn a_live_site_answers() {}

    #[ignore = "needs Anvil"]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_claim_is_paid_once() {}

    #[test]
    fn a_plain_test() {}
}
"""

LISTING = """chain::tests::a_coin_is_bought_on_the_chain: test
chain::tests::a_live_site_answers: test
share::tests::a_claim_is_paid_once: test
chain::tests::a_claim_is_paid_once: test
chain::tests::a_coin_is_bought_on_the_chain: test

3 tests, 0 benchmarks
"""


class AnvilTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, "chain"))
        with open(os.path.join(self.root, "chain", "tests.rs"), "w") as f:
            f.write(SRC)
        with open(os.path.join(self.root, "notes.txt"), "w") as f:
            f.write('#[ignore = "needs Anvil"] fn not_rust() {}')

    def test_only_the_functions_marked_needs_anvil_are_named(self):
        self.assertEqual(at.anvil_fns([self.root]), {"a_coin_is_bought_on_the_chain", "a_claim_is_paid_once"})

    def test_a_listed_test_is_picked_by_its_last_name_once_and_in_order(self):
        names = at.anvil_fns([self.root])
        self.assertEqual(
            at.selected(LISTING, names),
            ["chain::tests::a_coin_is_bought_on_the_chain", "share::tests::a_claim_is_paid_once", "chain::tests::a_claim_is_paid_once"],
        )

    def test_a_test_that_needs_the_network_is_never_picked(self):
        self.assertNotIn("chain::tests::a_live_site_answers", at.selected(LISTING, at.anvil_fns([self.root])))

    def test_lines_that_are_not_tests_are_left_out(self):
        self.assertEqual(at.selected("3 tests, 0 benchmarks\nfoo: bench\n", {"foo"}), [])

    def test_run_parallel_executes_each_test_in_its_own_process_and_records_failures(self):
        import io
        import stat
        import time
        from contextlib import redirect_stdout

        binary = os.path.join(self.root, "fake-test-bin")
        with open(binary, "w", encoding="utf-8") as f:
            f.write(
                "#!/bin/sh\n"
                "sleep 0.25\n"
                "echo \"running $3 pid=$$\"\n"
                "if [ \"$3\" = bad_test ]; then echo 'test result: FAILED. 0 passed; 1 failed; 0 ignored'; exit 1; fi\n"
                "echo 'test result: ok. 1 passed; 0 failed; 0 ignored'\n"
            )
        os.chmod(binary, os.stat(binary).st_mode | stat.S_IEXEC)
        log = os.path.join(self.root, "out.log")
        tests = ["t1", "t2", "t3", "bad_test"]
        out = io.StringIO()
        started = time.monotonic()
        with redirect_stdout(out):
            failed = at.run_parallel(binary, tests, log, jobs=4)
        elapsed = time.monotonic() - started
        self.assertEqual(failed, ["bad_test"])
        self.assertIn("::warning::bad_test (needs Anvil) failed under coverage", out.getvalue())
        self.assertLess(elapsed, 0.85, f"4 tests of 0.25s ran in {elapsed:.2f}s (expected parallel)")
        with open(log, encoding="utf-8") as handle:
            body = handle.read()
        self.assertEqual(body.count("test result:"), 4)
        pids = {line.split("pid=")[1] for line in body.splitlines() if "pid=" in line}
        self.assertEqual(len(pids), 4, "each test must run in its own OS process")


if __name__ == "__main__":
    unittest.main()
