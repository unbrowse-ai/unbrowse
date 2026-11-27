"""approvals.py: Claude Approvals' check without the Claude organization.

The check is only worth having if its arithmetic is boring and its refusals are loud: the seats each rule asks for, the
people a list admits, which verdict is strictest, and what a policy this checker cannot read turns into (Cannot
evaluate, never a pass).
"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import approvals  # noqa: E402

REPO_POLICY = pathlib.Path(__file__).resolve().parents[3] / ".claude/approvals.yml"

POLICY = """
version: 1
rules:
  - purpose: everyone
    paths: ["**"]
    verdict: { claude: comments, seats: 1 }
"""


def policy(text=POLICY):
    return approvals.load(text)


FACTS = {
    "pr/files_changed": 3, "pr/diff_lines": 120, "pr/base": "staging", "pr/opened_by": "lewis",
    "pr/authors": {"lewis"}, "pr/approved_by": set(), "claude/code_review": "pass",
}


def who(login, kind="human"):
    return {"login": login, "kind": kind}


class Patterns(unittest.TestCase):
    def test_a_double_star_crosses_folders_and_a_single_one_does_not(self):
        self.assertTrue(approvals.glob("**", "a/b/c.rs"))
        self.assertTrue(approvals.glob("**/*.rs", "a/b/c.rs"))
        self.assertTrue(approvals.glob("*.md", "README.md"))
        self.assertFalse(approvals.glob("*.md", "docs/README.md"))
        self.assertTrue(approvals.glob("docs/**", "docs/x/y.md"))
        self.assertTrue(approvals.glob("{AGENTS,CLAUDE}.md", "CLAUDE.md"))
        self.assertTrue(approvals.glob("a?c", "abc"))

    def test_an_exclusion_takes_a_file_out_of_one_rule_only(self):
        rule = {"paths": ["**", "!docs/**"]}
        self.assertTrue(approvals.matches(rule, "src/lib.rs"))
        self.assertFalse(approvals.matches(rule, "docs/README.md"))


class Loading(unittest.TestCase):
    def test_the_repository_s_own_policy_is_one_this_checker_reads(self):
        doc = approvals.load(REPO_POLICY.read_text())
        self.assertEqual(doc["version"], 1)
        self.assertGreaterEqual(len(doc["rules"]), 2)

    def test_what_it_does_not_evaluate_is_refused_by_name_never_ignored(self):
        cases = {
            "unknown key": "version: 1\nrules: []\nsurprise: 1\n",
            "locals": "version: 1\nlocals: {a: 1}\nrules: []\n",
            "use": "version: 1\nrules:\n  - {purpose: x, paths: ['**'], use: ['@a']}\n",
            "reuse": "version: 1\nrules:\n  - {purpose: x, paths: ['**'], reuse: false}\n",
            "findings": "version: 1\nrules:\n  - {purpose: x, paths: ['**'], findings: {resolution: humans}, verdict: {claude: comments, seats: 1}}\n",
            "a team": "version: 1\nrules:\n  - {purpose: x, paths: ['**'], verdict: {claude: comments, seats: [{count: 1, from: [acme/leads]}]}}\n",
            "a classifier": "version: 1\nrules:\n  - {purpose: x, paths: ['**'], advisory: [repo/risk], verdict: {claude: comments, seats: 1}}\n",
            "seats beside blocks": "version: 1\nrules:\n  - {purpose: x, paths: ['**'], verdict: {claude: blocks, seats: 1}}\n",
            "no seats": "version: 1\nrules:\n  - {purpose: x, paths: ['**'], verdict: {claude: comments}}\n",
            "a bad mode": "version: 1\nmode: maybe\nrules: [{purpose: x, paths: ['**'], verdict: {claude: comments, seats: 1}}]\n",
            "only exclusions": "version: 1\nrules:\n  - {purpose: x, paths: ['!docs/**'], verdict: {claude: comments, seats: 1}}\n",
        }
        for what, text in cases.items():
            with self.subTest(what):
                with self.assertRaises(approvals.Refuse):
                    approvals.load(text)


class Conditions(unittest.TestCase):
    def test_a_comparison_reads_a_fact(self):
        self.assertTrue(approvals.truth("pr/files_changed > 2", FACTS))
        self.assertFalse(approvals.truth("pr/files_changed > 3", FACTS))
        self.assertTrue(approvals.truth("pr/base = 'staging'", FACTS))
        self.assertTrue(approvals.truth("claude/code_review = pass", FACTS))

    def test_and_binds_tighter_than_or(self):
        self.assertTrue(approvals.truth("pr/files_changed > 99 OR pr/files_changed = 3 AND pr/diff_lines > 100", FACTS))
        self.assertFalse(approvals.truth("(pr/files_changed > 99 OR pr/files_changed = 3) AND pr/diff_lines > 500", FACTS))

    def test_a_list_needs_any_or_all_and_reads_empty(self):
        self.assertTrue(approvals.truth("ALL pr/authors = ['lewis']", FACTS))
        self.assertFalse(approvals.truth("ALL pr/authors = ['someone']", FACTS))
        self.assertTrue(approvals.truth("pr/approved_by = empty", FACTS))
        self.assertFalse(approvals.truth("pr/approved_by != empty", FACTS))
        with self.assertRaises(approvals.Refuse):
            approvals.truth("pr/authors = 'lewis'", FACTS)

    def test_a_fact_with_no_answer_fails_the_check_rather_than_passing(self):
        with self.assertRaises(approvals.NoAnswer):
            approvals.truth("claude/diff = same_intent", FACTS)


class Seats(unittest.TestCase):
    def test_a_rule_s_seats_are_counted_once_however_many_files_it_covers(self):
        result = approvals.decide(policy(), ["a.rs", "b.rs"], FACTS, [who("ana")], None)
        self.assertEqual((result["state"], result["required"], result["have"]), ("pass", 1, 1))

    def test_two_rules_each_ask_for_their_own_seats(self):
        two = policy("""
version: 1
rules:
  - {purpose: all, paths: ['**'], verdict: {claude: comments, seats: 1}}
  - {purpose: ci, paths: ['.github/**'], verdict: {claude: comments, seats: 1}}
""")
        # One person fills a seat in both rules ("one person can fill a seat in several sets"), so two rules of one
        # seat each are met by one approver, and the total still reads 2.
        result = approvals.decide(two, [".github/workflows/ci.yml"], FACTS, [who("ana")], None)
        self.assertEqual((result["state"], result["required"], result["have"]), ("pass", 2, 2))
        waiting = approvals.decide(two, [".github/workflows/ci.yml"], FACTS, [], None)
        self.assertEqual((waiting["state"], waiting["have"]), ("wait", 0))

    def test_the_author_fills_a_seat_that_admits_them_and_not_one_that_excludes_them(self):
        admits = approvals.decide(policy("""
version: 1
rules:
  - {purpose: all, paths: ['**'], verdict: {claude: comments, seats: 1}}
"""), ["a.rs"], FACTS, [], who("lewis"))
        self.assertEqual(admits["state"], "pass")
        excludes = approvals.decide(policy("""
version: 1
rules:
  - {purpose: all, paths: ['**'], verdict: {claude: comments, seats: [{count: 1, from: [humans, "!pr/authors"]}]}}
"""), ["a.rs"], FACTS, [], who("lewis"))
        self.assertEqual(excludes["state"], "wait")
        self.assertIn("a person other than the author", approvals.title(excludes))

    def test_an_override_on_claude_s_answer_lightens_the_rule(self):
        text = """
version: 1
rules:
  - purpose: all
    paths: ["**"]
    verdict: { claude: comments, seats: 2 }
    override:
      - { if: "claude/code_review = pass", verdict: { claude: approves, seats: 1 } }
"""
        # The author fills the lightened seat; Claude's answer is what allowed the lighter verdict at all.
        passed = approvals.decide(policy(text), ["a.rs"], FACTS, [], who("lewis"))
        self.assertEqual((passed["state"], passed["required"], passed["verdict"]["claude"]), ("pass", 1, "approves"))
        failed = approvals.decide(policy(text), ["a.rs"], dict(FACTS, **{"claude/code_review": "fail"}), [], None)
        self.assertEqual((failed["state"], failed["required"]), ("wait", 2))

    def test_blocks_outranks_a_satisfied_rule(self):
        text = """
version: 1
rules:
  - {purpose: all, paths: ['**'], verdict: {claude: comments, seats: 1}}
  - {purpose: never, paths: ['docs/**'], verdict: {claude: blocks}}
"""
        result = approvals.decide(policy(text), ["a.rs", "docs/x.md"], FACTS, [who("ana")], None)
        self.assertEqual((result["state"], approvals.conclusion(result)), ("blocked", "failure"))

    def test_a_file_no_rule_covers_and_a_rule_whose_if_is_false_are_said_apart(self):
        uncovered = approvals.decide(policy("""
version: 1
rules:
  - {purpose: docs, paths: ['docs/**'], verdict: {claude: comments, seats: 1}}
"""), ["src/lib.rs"], FACTS, [], None)
        self.assertEqual(uncovered["state"], "uncovered")
        false_if = approvals.decide(policy("""
version: 1
rules:
  - {purpose: big, paths: ['**'], if: "pr/files_changed > 99", verdict: {claude: comments, seats: 1}}
"""), ["src/lib.rs"], FACTS, [], None)
        self.assertEqual(false_if["state"], "no_rule")


class Coverage(unittest.TestCase):
    def test_a_file_no_rule_covers_beside_covered_ones_is_named_and_claude_may_not_approve(self):
        result = approvals.decide(policy("""
version: 1
rules:
  - {purpose: rust, paths: ['**/*.rs'], verdict: {claude: comments, seats: 1}}
"""), ["src/lib.rs", "README.md"], FACTS, [who("ana")], None)
        self.assertEqual((result["state"], result["uncovered"]), ("pass", ["README.md"]))
        self.assertIn("no rule covers", approvals.body(result, 1))

    def test_a_policy_file_below_the_root_is_refused_rather_than_half_read(self):
        self.assertEqual(approvals.nested_policy([".claude/approvals.yml", "src/lib.rs"]), None)
        self.assertEqual(approvals.nested_policy(["services/billing/.claude/approvals.yml"]),
                         "services/billing/.claude/approvals.yml")


class Reporting(unittest.TestCase):
    def test_observe_never_blocks_and_says_so_in_the_title(self):
        resting = policy(POLICY.replace("version: 1", "version: 1\nmode: observe"))
        result = approvals.decide(resting, ["a.rs"], FACTS, [], None)
        result["mode"] = "observe"
        self.assertEqual(approvals.conclusion(result), "neutral")
        self.assertTrue(approvals.title(result).startswith("(observe mode) Waiting on human review from any person (0/1)"))
        self.assertIn("(observe mode)", approvals.body(result, 1).splitlines()[0])

    def test_enforce_fails_a_change_that_is_still_waiting(self):
        result = approvals.decide(policy(), ["a.rs"], FACTS, [], None)
        result["mode"] = "enforce"
        self.assertEqual(approvals.conclusion(result), "failure")

    def test_a_covered_file_with_no_rule_that_applies_is_a_failure(self):
        result = {"state": "no_rule", "file": "src/lib.rs", "mode": "enforce"}
        self.assertEqual(approvals.conclusion(result), "failure")
        self.assertIn("No rule applies to src/lib.rs", approvals.title(result))


class Answers(unittest.TestCase):
    def test_code_review_s_answer_is_read_from_its_check_run(self):
        def gh(text):
            return type("G", (), {"api": lambda self, path: {"check_runs": [
                {"name": "Other", "output": {"text": "x"}},
                {"name": "Code review", "output": {"text": text}}]}})()
        self.assertEqual(approvals.review_answer(gh("| a |\n<!-- bughunter-severity: {\"nit\":2,\"normal\":0,\"pre_existing\":1} -->"), "r", "sha"), "pass")
        self.assertEqual(approvals.review_answer(gh("<!-- bughunter-severity: {\"normal\":1} -->"), "r", "sha"), "fail")
        self.assertIsNone(approvals.review_answer(gh("no line here"), "r", "sha"))
        self.assertIsNone(approvals.review_answer(gh(""), "r", "sha"))


class People(unittest.TestCase):
    def test_a_list_admits_and_excludes_by_name(self):
        self.assertTrue(approvals.admits("humans", who("ana"), FACTS))
        self.assertFalse(approvals.admits("humans", who("dependabot", "bot"), FACTS))
        self.assertTrue(approvals.admits("bots", who("dependabot", "bot"), FACTS))
        self.assertTrue(approvals.admits([humans := "humans", "!pr/authors"], who("lewis"), FACTS) is False)
        self.assertTrue(approvals.admits("bot:claude", who("claude", "bot"), FACTS))
        self.assertFalse(approvals.admits("nobody", who("ana"), FACTS))


if __name__ == "__main__":
    unittest.main()
