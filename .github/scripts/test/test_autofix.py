"""autofix.py: the steps around staging's fixer (staging-autofix.yml) decide when it is asked and refuse a fix that
loosens a check instead of fixing a cause. Its cases are the red runs of 22 November 2026 that were fixed by hand."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import autofix  # noqa: E402


def diff(path, removed=(), added=(), base=None):
    """A change to `path`: `base` is the file as it was (its lines), `removed` the line numbers taken out of it, `added`
    the new lines. Without a base, `removed` are lines of a file with nothing else in it."""
    if base is None:
        base, removed = list(removed), list(range(1, len(removed) + 1))
    text = "".join(f"@@ -{n},1 +{n},0 @@\n-{base[n - 1]}\n" for n in removed)
    if added:
        text += f"@@ -0,0 +1,{len(added)} @@\n" + "".join(f"+{l}\n" for l in added)
    return {path: {"base": "\n".join(base) + "\n", "diff": text}}


# Staging 62556a366's CI (run 45029295647), as `gh run view --json jobs` answers it.
JOBS = [
    {"name": "Short checks", "conclusion": "success", "steps": [{"name": "Requirements held by the source", "conclusion": "success"}]},
    {"name": "Node", "conclusion": "failure", "steps": [{"name": "Set up", "conclusion": "success"}, {"name": "Run cargo test --workspace --locked", "conclusion": "failure"}]},
    {"name": "Builds on Windows", "conclusion": "failure", "steps": [{"name": "The engine drives the runner's Chrome", "conclusion": "failure"}]},
    {"name": "Cancelled one", "conclusion": "cancelled", "steps": []},
    {"name": "Runner lost", "conclusion": "failure", "steps": []},
]


class Plan(unittest.TestCase):
    def test_each_failed_step_is_named_with_its_job(self):
        self.assertEqual(autofix.failures(JOBS), ["Node :: Run cargo test --workspace --locked", "Builds on Windows :: The engine drives the runner's Chrome", "Runner lost"])

    def fake(self, prs):
        calls = []

        def gh(args):
            calls.append(args)
            if args[:2] == ["run", "view"] and "--json" in args:
                return json.dumps({"workflowName": "CI", "headSha": "62556a36619fb400", "headBranch": "staging", "event": "push", "url": "https://example.invalid/r/1", "jobs": JOBS})
            if args[:2] == ["pr", "list"]:
                return json.dumps(prs)
            if args[:2] == ["run", "view"] and "--log-failed" in args:
                return "\x1b[31mNode\tRun cargo test\tsettings answered {...}: $: advanced is missing\x1b[0m\n"
            raise AssertionError(args)

        return gh, calls

    def test_a_red_run_is_handed_over_with_its_failed_log_and_a_branch_of_its_own(self):
        with tempfile.TemporaryDirectory() as d:
            gh, _ = self.fake([])
            r = autofix.plan(45029295647, d, "o/r", gh=gh)
            self.assertTrue(r["act"])
            self.assertEqual(r["branch"], "autofix/62556a366-45029295647")
            log = pathlib.Path(d, "failed.log").read_text()
            self.assertIn("advanced is missing", log)
            self.assertNotIn("\x1b[", log, "the agent reads the log without its colours")
            self.assertIn("CI / Node :: Run cargo test --workspace --locked", pathlib.Path(d, "run.md").read_text())

    def test_a_staging_that_stays_red_gets_one_fixer_not_one_per_push(self):
        sigs = ["CI / " + s for s in autofix.failures(JOBS)]
        open_pr = {"number": 9, "body": "".join(autofix.marker(s) for s in sigs)}
        with tempfile.TemporaryDirectory() as d:
            gh, calls = self.fake([open_pr])
            r = autofix.plan(1, d, "o/r", gh=gh)
            self.assertFalse(r["act"])
            self.assertIn("already works on", r["why"])
            self.assertFalse(any("--log-failed" in c for c in calls), "nothing is read for a failure in hand")
        # One failure in hand, another not: only the other is handed over.
        with tempfile.TemporaryDirectory() as d:
            gh, _ = self.fake([{"number": 9, "body": autofix.marker(sigs[0])}])
            r = autofix.plan(1, d, "o/r", gh=gh)
            self.assertEqual(r["signatures"], sigs[1:])

    def test_a_run_with_nothing_failed_hands_nothing_over(self):
        def gh(args):
            return json.dumps({"workflowName": "CI", "headSha": "a" * 40, "headBranch": "staging", "event": "push", "url": "u", "jobs": [JOBS[0]]})

        self.assertEqual(autofix.plan(1, "/nonexistent", "o/r", gh=gh), {"act": False, "why": "no failed job"})


PR_JOBS = [
    {"name": "Node lint (clippy)", "conclusion": "failure", "steps": [{"name": "Clippy", "conclusion": "failure"}]},
    {"name": "Builds on Windows", "conclusion": "failure", "steps": [{"name": "The engine drives the runner's Chrome", "conclusion": "failure"}]},
]


class PlanPr(unittest.TestCase):
    """The fixer on a pull request's branch: only where it is wanted, and only on what is the pull request's own."""

    def fake(self, pr=None, staging_last=("failure", JOBS), head="abc123"):
        base = {"number": 829, "state": "OPEN", "isDraft": False, "baseRefName": "staging", "headRefName": "feat/x", "headRefOid": head,
                "headRepository": {"name": "r"}, "headRepositoryOwner": {"login": "o"}, "labels": [], "commits": [{"messageBody": "feat: x"}]}
        base.update(pr or {})

        def gh(args):
            if args[:2] == ["run", "view"] and "--log-failed" in args:
                return "Node lint (clippy)\tClippy\terror: unused `axum::Json` that must be used\n"
            if args[:3] == ["run", "view", "7"]:
                return json.dumps({"workflowName": "CI", "headSha": "abc123", "headBranch": "feat/x", "event": "pull_request", "url": "https://example.invalid/r/7", "jobs": PR_JOBS})
            if args[:2] == ["pr", "view"]:
                return json.dumps(base)
            if args[:2] == ["run", "list"]:
                return json.dumps([{"databaseId": 99, "conclusion": staging_last[0]}])
            if args[:3] == ["run", "view", "99"]:
                return json.dumps({"jobs": staging_last[1]})
            raise AssertionError(args)

        return gh

    def test_its_own_failure_is_handed_over_and_staging_s_is_left_to_staging(self):
        with tempfile.TemporaryDirectory() as d:
            r = autofix.plan_pr(7, 829, d, "o/r", gh=self.fake())
            self.assertTrue(r["act"], r)
            # The Windows step fails on staging too (JOBS): only clippy is this pull request's.
            self.assertEqual(r["signatures"], ["CI / Node lint (clippy) :: Clippy"])
            self.assertEqual((r["branch"], r["pr"]), ("feat/x", 829))
            run_md = pathlib.Path(d, "run.md").read_text()
            self.assertIn("Also failing on staging", run_md)
            self.assertIn("that must be used", pathlib.Path(d, "failed.log").read_text())

    def test_a_failure_staging_shares_is_not_the_pull_request_s(self):
        r = autofix.plan_pr(7, 829, "/nonexistent", "o/r", gh=self.fake(staging_last=("failure", PR_JOBS)))
        self.assertFalse(r["act"])
        self.assertIn("staging fails the same way", r["why"])

    def test_it_stays_out_where_it_isn_t_wanted(self):
        cases = {
            "a draft": {"isDraft": True},
            "from another repository": {"headRepositoryOwner": {"login": "someone-else"}},
            "not into staging": {"baseRefName": "main"},
            "labelled no-autofix": {"labels": [{"name": "no-autofix"}]},
            "the pull request isn't open": {"state": "MERGED"},
            "a newer commit is on the branch": {"headRefOid": "def456"},
            "the last commit is the fixer's own": {"commits": [{"messageBody": "feat: x"}, {"messageBody": "fix\n\nAutofix-Run: 6"}]},
            "commits here already": {"commits": [{"messageBody": "Autofix-Run: 1"}, {"messageBody": "feat: y"}, {"messageBody": "Autofix-Run: 2"}, {"messageBody": "feat: z"}]},
        }
        for why, pr in cases.items():
            with self.subTest(why):
                r = autofix.plan_pr(7, 829, "/nonexistent", "o/r", gh=self.fake(pr))
                self.assertFalse(r["act"], why)
                self.assertIn(why, r["why"])


class Guard(unittest.TestCase):
    def test_the_fixes_made_by_hand_on_22_november_go_through(self):
        # #832: the format check for heard.json, and a test that reads the answers it used to drop.
        self.assertEqual(autofix.refusals(diff("unbrowse-node/app/src/formats.rs", added=['        Check { format: &f::HEARD, at: "heard.json", round: round::<crate::heard::Heard>, found: |v| v["apps"][0]["name"] == "claude-code" },'])), [])
        mcp = ["fn mcp() {}", "#[cfg(test)]", "mod stop_tests {", "    #[test]", "    fn heard() {", '        rt.block_on(mcp_answer(node.clone(), &headers, opens("claude-code")));', "    }", "}"]
        self.assertEqual(autofix.refusals(diff("unbrowse-node/app/src/api/mcp.rs", base=mcp, removed=[6],
            added=["        let answered = [", '            rt.block_on(mcp_answer(node.clone(), &headers, opens("claude-code"))).0,', "        ];", '        assert_eq!(answered, [StatusCode::OK; 3], "each is answered");'])), [])
        # #837: a serde attribute.
        self.assertEqual(autofix.refusals(diff("unbrowse-node/app/src/store.rs", removed=['    #[serde(default, skip_serializing_if = "Option::is_none")]'], added=["    #[serde(default)]"])), [])
        # A check in the node's own code, not its tests, may change like any code.
        code = ["fn save() {", "    check(&schema, &value)?;", "}", "#[cfg(test)]", "mod tests {}"]
        self.assertEqual(autofix.refusals(diff("unbrowse-node/app/src/store.rs", base=code, removed=[2], added=["    validate(&schema, &value)?;"])), [])

    def test_a_fix_that_loosens_a_check_is_refused(self):
        cases = {
            ".github/workflows/ci.yml": diff(".github/workflows/ci.yml", added=["      continue-on-error: true"]),
            "a fixture": diff("unbrowse-node/crates/files/fixtures/heard.json", added=['{"apps": []}']),
            "a generated file": diff("unbrowse-sdk/typescript/src/generated.ts", added=["x"]),
            "the agent guide": diff("AGENTS.md", added=["x"]),
            "the ledger": diff("docs/REQUIREMENTS.md", added=["x"]),
            "an ignored test": diff("unbrowse-node/app/src/heard.rs", added=["    #[ignore]"]),
            "an allow": diff("unbrowse-node/app/src/heard.rs", added=["#[allow(unused_must_use)]"]),
            "a skipped python test": diff("scripts/rules/test_release_gates.py", added=["    @unittest.skip('flaky')"]),
            # The miss that made this guard read where a line sits: staging 62556a366's red schema test, made green by
            # dropping its check instead of fixing the settings (commands.rs, inside `#[cfg(test)] mod tests`).
            "the schema test's check taken out": diff("unbrowse-node/app/src/commands.rs", base=[
                "pub fn owner() {}", "#[cfg(test)]", "mod tests {", "    #[test]", "    fn what_each_command_answers_is_what_its_schema_says() {",
                '            check(&(c.returns)(), &answer, &t).unwrap_or_else(|e| panic!("{name} answered {answer}: {e}"));', "    }", "}"], removed=[6]),
            "an assertion in a #[test] outside a test module": diff("unbrowse-node/app/src/heard.rs", base=[
                "fn a() {}", "#[test]", "fn heard() {", "    assert_eq!(x, 1);", "}"], removed=[4]),
            "a zig test's expectation": diff("unbrowse-node/window/src/screens/connect.zig", base=[
                "pub fn list() void {}", 'test "rows say what happened" {', '    try std.testing.expect(t.hasText("Connected"));', "}"], removed=[3]),
            "an expected value taken out of a python test": diff(".github/qa/test_build_once.py", removed=["        self.assertEqual(unpackers, users)"]),
        }
        for name, d in cases.items():
            with self.subTest(name):
                self.assertTrue(autofix.refusals(d), f"{name} went through")

    def test_the_guard_reads_a_real_work_tree_and_leaves_out_its_own_notes(self):
        with tempfile.TemporaryDirectory() as d:
            run = lambda *a: subprocess.run(a, cwd=d, check=True, capture_output=True)
            run("git", "init", "-q")
            pathlib.Path(d, "src").mkdir()
            pathlib.Path(d, "src/lib.rs").write_text("pub fn a() {}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {\n        assert_eq!(1, 1);\n    }\n}\n")
            run("git", "add", "-A")
            run("git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "base")
            pathlib.Path(d, ".autofix").mkdir()
            pathlib.Path(d, ".autofix/failed.log").write_text("the log")
            pathlib.Path(d, "src/fix.rs").write_text("fn fixed() {}\n")
            pathlib.Path(d, "src/lib.rs").write_text("pub fn a() {}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {\n    }\n}\n")
            here = os.getcwd()
            os.chdir(d)
            try:
                changes = autofix.changed("HEAD")
            finally:
                os.chdir(here)
            self.assertEqual(sorted(changes), ["src/fix.rs", "src/lib.rs"])
            self.assertIn("+fn fixed() {}", changes["src/fix.rs"]["diff"])
            self.assertEqual(autofix.refusals(changes), ["src/lib.rs: takes assertions out of a test (assert_eq!(1, 1);)"])

class Steer(unittest.TestCase):
    """PR Steward's asks that are not a failed run: a review's findings, and a person's dispatch."""

    def fake(self, **pr):
        base = {"number": 829, "state": "OPEN", "isDraft": False, "baseRefName": "staging", "headRefName": "feat/x",
                "headRefOid": "abc123", "headRepositoryOwner": {"login": "o"}, "headRepository": {"name": "r"},
                "labels": [], "commits": [], "mergeable": "MERGEABLE", "title": "a change"}
        base.update(pr)

        def gh(args):
            if args[:2] == ["pr", "view"]:
                return json.dumps(base)
            raise AssertionError(args)

        return gh

    def test_a_dispatch_writes_the_ask_the_agent_reads(self):
        with tempfile.TemporaryDirectory() as d:
            r = autofix.steer(829, d, "o/r", gh=self.fake())
            self.assertTrue(r["act"], r)
            self.assertEqual((r["branch"], r["pr"], r["sha"]), ("feat/x", 829, "abc123"))
            run = pathlib.Path(d, "run.md").read_text()
            self.assertIn("#829", run)
            self.assertIn("A person asked PR Steward", run)

    def test_a_conflict_is_reported_and_never_merged(self):
        with tempfile.TemporaryDirectory() as d:
            r = autofix.steer(829, d, "o/r", gh=self.fake(mergeable="CONFLICTING"))
            self.assertTrue(r["act"], r)
            run = pathlib.Path(d, "run.md").read_text()
            self.assertIn("conflicts with staging", run)
            self.assertIn("do not merge", run)

    def test_a_review_of_an_older_commit_is_not_worked_on(self):
        # The branch moved since the review read it, so the finding may be gone: the same rule a failed run is held to.
        with tempfile.TemporaryDirectory() as d:
            r = autofix.steer(829, d, "o/r", head="def456", gh=self.fake())
            self.assertFalse(r["act"])
            self.assertEqual(r["why"], "a newer commit is on the branch")

    def test_it_stays_out_where_the_fixer_stays_out(self):
        for why, pr in {"a draft": {"isDraft": True}, "labelled no-autofix": {"labels": [{"name": "no-steward"}]},
                        "not into staging": {"baseRefName": "main"}}.items():
            with self.subTest(why):
                r = autofix.steer(829, "/nonexistent", "o/r", gh=self.fake(**pr))
                self.assertFalse(r["act"], why)
                self.assertIn(why, r["why"])


if __name__ == "__main__":
    unittest.main()
