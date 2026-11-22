"""Skill triggers are not asked of the model again when the same inputs already passed (UNB-166).

The verdict depends on the skills, the queries, the scripts, the locked CLI and the workflows that hold the sessions'
command line, and on the model. `skill_trigger.py --key` hashes git's record of all but the model; a run that passed
keeps an empty cache entry under that key. qa.yml and pr-agent-checks.yml look the key up before any session runs and
skip the sessions on a hit. The nightly run never looks, so a model that drifts is seen within a day; a pull request
looks but never saves, so nothing a pull request did is remembered; and the job that ran the sessions saves nothing
itself (a second job, with no secret and no checkout, does).

Read as text: the check's venv has no YAML library (test_qa_workflow.py).
"""
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import skill_trigger  # noqa: E402
from test_mac_runner import code, jobs  # noqa: E402
from test_qa_workflow import NIGHTLY, PUSH, evaluate  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
MISS = "steps.passed.outputs.cache-hit != 'true'"
KEY_STEP = 'key=$(python3 .github/qa/skill_trigger.py --key)\n          echo "key=$key" >> "$GITHUB_OUTPUT"'
SPENDS = re.compile(r"claude-cli|claude-credential\.sh|\"\$cli\" -p|skill_trigger\.py --(?:plan|score)|secrets\.")


def condition(step):
    found = re.search(r"(?m)^\s+(?:- )?if: (.*)$", step)
    return found.group(1).strip() if found else ""


def unguarded(steps):
    """The steps after the lookup that would still spend (install the CLI, hold the credential, run or score a
    session, give a verdict) on a hit: each must wait for a miss."""
    look = next(i for i, s in enumerate(steps) if "id: passed" in s)
    return [s.splitlines()[0].strip() for s in steps[look + 1 :] if (SPENDS.search(code(s)) or "name: Verdict" in s) and MISS not in condition(s)]


class Repo:
    """A git repository holding a file for each input, to change one at a time."""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp())
        self.git("init", "-q")
        for path in skill_trigger.INPUTS:
            self.write(path if "." in Path(path).name else path + "/a/SKILL.md", f"first {path}")
        self.commit()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", *args],
                              capture_output=True, text=True, check=True).stdout  # fmt: skip

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "x")
        return skill_trigger.inputs_key(self.root)


class Key(unittest.TestCase):
    def test_the_key_changes_with_every_input_and_with_nothing_else(self):
        repo = Repo()
        first = skill_trigger.inputs_key(repo.root)
        self.assertRegex(first, r"^passed-skill-triggers-[0-9a-f]{64}$")
        repo.write("unbrowse-node/src/main.rs", "fn main() {}")
        repo.write("docs/README.md", "words")
        self.assertEqual(repo.commit(), first, "a file that is no input leaves the key alone")
        seen = {first}
        for path in skill_trigger.INPUTS:
            repo.write(path if "." in Path(path).name else path + "/a/SKILL.md", f"second {path}")
            key = repo.commit()
            self.assertNotIn(key, seen, f"changing {path} changes the key")
            seen.add(key)
        repo.write("skills/new-skill/SKILL.md", "a new skill")
        self.assertNotIn(repo.commit(), seen, "a new skill changes the key")

    def test_a_missing_input_is_an_error_never_a_shorter_key(self):
        repo = Repo()
        repo.git("rm", "-q", ".github/qa/skill-evals.json")
        repo.git("commit", "-q", "-m", "gone")
        with self.assertRaises(RuntimeError):
            skill_trigger.inputs_key(repo.root)

    def test_every_input_is_in_this_repository_and_what_the_script_imports_is_an_input(self):
        self.assertRegex(skill_trigger.inputs_key(), r"^passed-skill-triggers-[0-9a-f]{64}$")
        source = (ROOT / ".github/qa/skill_trigger.py").read_text()
        for module in re.findall(r"(?m)^from (\w+) import ", source):
            if (ROOT / ".github/qa" / f"{module}.py").is_file():
                self.assertIn(f".github/qa/{module}.py", skill_trigger.INPUTS)
        for needed in ("skills", ".github/qa/skill-evals.json", ".github/tools/claude-cli", ".github/workflows/qa.yml", ".github/workflows/pr-agent-checks.yml"):
            self.assertIn(needed, skill_trigger.INPUTS)


class Workflows(unittest.TestCase):
    def setUp(self):
        self.qa = (WORKFLOWS / "qa.yml").read_text()
        self.pr = (WORKFLOWS / "pr-agent-checks.yml").read_text()

    def test_both_workflows_look_the_same_key_up_before_any_session(self):
        for name, text in (("qa.yml", self.qa), ("pr-agent-checks.yml", self.pr)):
            steps = jobs(text)["skills"]["steps"]
            with self.subTest(workflow=name):
                key = next(i for i, s in enumerate(steps) if "id: inputs" in s)
                look = next(i for i, s in enumerate(steps) if "id: passed" in s)
                self.assertIn(KEY_STEP, steps[key])
                self.assertEqual(look, key + 1)
                self.assertIn("uses: actions/cache/restore@", steps[look])
                self.assertIn("path: .skill-triggers-passed", steps[look])
                self.assertIn("key: ${{ steps.inputs.outputs.key }}", steps[look])
                self.assertIn("lookup-only: true", steps[look])
                self.assertNotIn("restore-keys", steps[look], "only an exact match is a pass")
                self.assertFalse(any(SPENDS.search(code(s)) for s in steps[1:key]), "nothing is spent before the lookup")
                self.assertEqual(unguarded(steps), [])

    def test_the_guard_check_can_fail(self):
        steps = jobs(self.qa)["skills"]["steps"]
        broken = [s.replace(" && " + MISS, "") if "name: Run skill trigger sessions" in s else s for s in steps]
        self.assertEqual(unguarded(broken), ["- name: Run skill trigger sessions"])
        broken = [s.replace(" && " + MISS, "") if "name: Verdict" in s else s for s in steps]
        self.assertEqual(unguarded(broken), ["- name: Verdict"])

    def test_the_nightly_run_asks_the_model_whatever_was_kept(self):
        steps = jobs(self.qa)["skills"]["steps"]
        look = condition(next(s for s in steps if "id: passed" in s))
        self.assertEqual(look, "steps.auth.outputs.ok == 'true' && github.event_name != 'schedule'")
        ok = {"steps": {"auth": {"outputs": {"ok": "true"}}}}
        self.assertFalse(evaluate(look, {**NIGHTLY, **ok}))
        self.assertTrue(evaluate(look, {**PUSH, **ok}))
        # A lookup that did not run left no hit: every session step runs.
        run = condition(next(s for s in steps if "name: Run skill trigger sessions" in s))
        self.assertTrue(evaluate(run, {**NIGHTLY, **ok}))
        self.assertFalse(evaluate(run, {**PUSH, "steps": {**ok["steps"], "passed": {"outputs": {"cache-hit": "true"}}}}))
        self.assertTrue(evaluate(run, {**PUSH, "steps": {**ok["steps"], "passed": {"outputs": {"cache-hit": ""}}}}))

    def test_a_pass_is_saved_by_a_job_that_ran_no_session_and_only_after_a_pass(self):
        found = jobs(self.qa)
        self.assertNotRegex("\n".join(found["skills"]["steps"]), r"actions/cache/save@|uses: actions/cache@")
        saver = found["skills-passed"]["steps"]
        body = "\n".join(saver)
        self.assertNotRegex(body, r"secrets\.|actions/checkout@|claude")
        self.assertIn("uses: actions/cache/save@", saver[-1])
        self.assertIn("path: .skill-triggers-passed", saver[-1])
        self.assertIn("key: ${{ needs.skills.outputs.key }}", saver[-1])
        block = self.qa.split("\n  skills-passed:\n", 1)[1].split("\n    steps:\n", 1)[0]
        self.assertIn("    needs: skills\n", block)
        cond = re.search(r"(?m)^    if: (.*)$", block).group(1)
        self.assertEqual(cond, "needs.skills.outputs.pass == 'true' && needs.skills.outputs.key != ''")
        passed = {"needs": {"skills": {"outputs": {"pass": "true", "key": "passed-skill-triggers-abc"}}}}
        self.assertTrue(evaluate(cond, passed))
        for pass_, key in (("false", "k"), ("", "k"), ("true", "")):
            self.assertFalse(evaluate(cond, {"needs": {"skills": {"outputs": {"pass": pass_, "key": key}}}}), (pass_, key))
        outputs = self.qa.split("\n  skills:\n", 1)[1].split("\n    steps:\n", 1)[0]
        self.assertIn("      key: ${{ steps.inputs.outputs.key }}\n      pass: ${{ steps.score.outputs.pass }}", outputs)

    def test_a_pull_request_looks_but_never_saves(self):
        self.assertNotRegex(self.pr, r"actions/cache/save@|uses: actions/cache@")
        self.assertNotIn("skills-passed", jobs(self.pr))


if __name__ == "__main__":
    unittest.main()
