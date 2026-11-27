"""The agent guide says push, then watch the run (UNB-235, Lewis 19 Nov 2026), and no longer forbids CI as a first run.
The pushing session watches every run its push started, fixes a red one from the runner's logs, never reports done on
a red or unwatched run, and leaves the full suites to CI (Lewis 22 Nov 2026, hub programme 5c79a6). Root CLAUDE.md and
AGENTS.md are one file, byte for byte."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]


class AgentGuide(unittest.TestCase):
    def setUp(self):
        self.guide = (ROOT / "AGENTS.md").read_text()
        self.section = self.guide.split("## Push, then watch the run", 1)[1].split("\n## ", 1)[0]
        self.rules = {line.split("**")[1]: line for line in self.section.splitlines() if line.startswith("- **")}

    def rule(self, start):
        found = [name for name in self.rules if name.startswith(start)]
        self.assertEqual(len(found), 1, f"one rule starting {start!r} in 'Push, then watch the run'")
        bullet = self.section.split(self.rules[found[0]], 1)[1].split("\n- ", 1)[0]
        return " ".join((self.rules[found[0]] + bullet).split())

    def test_root_claude_md_and_agents_md_are_one_file_byte_for_byte(self):
        self.assertEqual((ROOT / "CLAUDE.md").read_bytes(), (ROOT / "AGENTS.md").read_bytes())

    def test_the_rule_that_lived_only_in_claude_md_is_in_the_one_guide(self):
        self.assertIn("## Fixes are general, never hard-coded", self.guide)
        self.assertIn("## The meta pattern: propose from the walk, let the site verify", self.guide)

    def test_push_then_watch_gives_the_commands(self):
        for command in ("gh run list --commit", "gh run watch", "--exit-status", "gh run view", "--log-failed",
                        "gh run download", "gh run rerun", "gh workflow run qa.yml --ref",
                        ".github/scripts/watch_runs.py"):
            self.assertIn(command, self.section)
        self.assertTrue((ROOT / ".github/scripts/watch_runs.py").is_file())

    def test_every_run_the_push_started_is_watched_to_its_end(self):
        rule = self.rule("After every push, watch every run that push started")
        for words in ("to its end", "in the same session", "pull request", "another workflow starts", "RUNS_GREEN",
                      "RUNS_RED"):
            self.assertIn(words, rule)

    def test_a_red_run_is_fixed_from_the_runners_logs_and_watched_again(self):
        rule = self.rule("A red run is fixed in the same session")
        for words in ("--log-failed", "artifacts", "screenshots", "report", "fix it, push", "watch the new runs",
                      "until every run", "do not re-run the suite on your machine"):
            self.assertIn(words, rule)

    def test_a_cause_it_cannot_fix_names_the_step_and_marks_the_ticket_blocked_with_the_log_line(self):
        rule = self.rule("Stop only on a cause you cannot fix")
        for words in ("workflow, job and step", "the reason", "quote the log line", "Blocked", "`Blocked:`"):
            self.assertIn(words, rule)

    def test_done_is_never_reported_on_a_red_or_unwatched_run(self):
        rule = self.rule("Never report done on a red or unwatched run")
        for words in ("every run on the last pushed commit", "its id", "conclusion", "cancelled run is not green"):
            self.assertIn(words, rule)

    def test_the_host_runs_only_the_fast_unit_check_and_ci_runs_the_full_suites(self):
        rule = self.rule("Testing runs in CI, not on your machine")
        self.assertIn("only the fast unit check", rule)
        self.assertIn("cargo test -p <crate> <filter>", rule)
        never = rule.split("Never run the full suites on the host", 1)[1]
        for suite in ("cargo test --workspace", "clippy", "end-to-end", "QA run", "task gate", "coverage"):
            self.assertIn(suite, never)
        self.assertIn("CI runs every one of them", rule)

    def test_the_replaced_rules_are_not_rules_any_more(self):
        rules = [line for line in self.guide.splitlines() if re.match(r"\s*- \*\*", line)]
        for line in rules:
            self.assertNotIn("CI is a gate, never the first run", line)
            self.assertNotIn("No pull request before the change has run", line)
        flat = " ".join(self.guide.split())
        self.assertNotIn("Don't push to find out", flat)
        self.assertNotIn("On your own machine, when you can, build the node", flat)

    def test_no_change_waits_for_a_countersign(self):
        # Lewis, 24 Nov 2026: "remove the need for countersign" (docs/REQUIREMENTS.md).
        import json
        guide = (ROOT / "CLAUDE.md").read_text()
        self.assertNotIn("needs Lewis's countersign", guide)
        self.assertNotIn("countersigns it", guide)
        policy = json.loads((ROOT / ".github/self-merge.json").read_text())
        self.assertNotIn("countersign_paths_extra", policy)

    def test_authorized_agent_merges_use_the_github_guard_on_the_verified_head(self):
        merge = self.guide.split("## Self-merging PRs", 1)[1].split("\n## ", 1)[0]
        self.assertIn("gh pr checks", merge)
        self.assertIn("gh pr merge", merge)
        self.assertIn("--match-head-commit", merge)
        self.assertIn("every check", merge)
        self.assertIn("independent review", merge)
        self.assertIn("independent PASS", merge)
        self.assertIn("Agents do not approve PRs", merge)
        self.assertIn("Missing or unreadable evidence blocks the merge", merge)
        self.assertNotIn("pr-gate", merge)


if __name__ == "__main__":
    unittest.main()
