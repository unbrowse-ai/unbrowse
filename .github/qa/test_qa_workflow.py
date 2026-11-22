"""qa.yml runs its model jobs on every push to staging and main (UNB-235).

A push has no `inputs`, so `inputs.model` is null there, and GitHub's `==` turns null and false both into 0: the
condition `inputs.model != false` was false on every push, and Claude QA, Skill triggers and the QA report were skipped
while the run still showed green (staging run 44710075088). This evaluates each job's `if:` the way GitHub does, for a
push, the nightly schedule and a dispatch with the model switch on and off.
"""
import math
import re
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows/qa.yml"
TOKEN = re.compile(r"\s*(&&|\|\||==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)")


def job_conditions(text):
    """{job id: its `if:` expression}, read from the jobs block without a YAML library (the check's venv has none)."""
    conditions, job = {}, None
    for line in text.split("\njobs:\n", 1)[1].splitlines():
        if re.match(r"^  [A-Za-z_][\w-]*:\s*$", line):
            job = line.strip()[:-1]
        elif job and re.match(r"^    if: ", line):
            conditions[job] = line.split("if: ", 1)[1].strip()
    return conditions


def number(value):
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, str):
        try:
            return float(value.strip()) if value.strip() else 0
        except ValueError:
            return math.nan
    return value


def equal(a, b):
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    if type(a) is type(b):
        return a == b
    return number(a) == number(b)


def truthy(value):
    return not (value is None or value is False or value == "" or value == 0 or (isinstance(value, float) and math.isnan(value)))


def evaluate(expression, context):
    """GitHub's expression rules for what qa.yml's conditions use: names, strings, booleans, null, == != ! && ||."""
    tokens, at = [], 0
    while at < len(expression.rstrip()):
        match = TOKEN.match(expression, at)
        if not match:
            raise ValueError(f"cannot read {expression[at:]!r}")
        tokens.append(match.group(1))
        at = match.end()
    tokens.append(None)
    position = [0]

    def peek():
        return tokens[position[0]]

    def take():
        position[0] += 1
        return tokens[position[0] - 1]

    def primary():
        token = take()
        if token == "(":
            value = either()
            assert take() == ")", expression
            return value
        if token == "!":
            return not truthy(primary())
        if token.startswith("'"):
            return token[1:-1].replace("''", "'")
        if token in ("true", "false"):
            return token == "true"
        if token == "null":
            return None
        value = context
        for part in token.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        return value

    def comparison():
        value = primary()
        while peek() in ("==", "!="):
            operator, right = take(), primary()
            value = equal(value, right) if operator == "==" else not equal(value, right)
        return value

    def both():
        value = comparison()
        while peek() == "&&":
            take()
            right = comparison()
            value = right if truthy(value) else value
        return value

    def either():
        value = both()
        while peek() == "||":
            take()
            right = both()
            value = value if truthy(value) else right
        return value

    value = either()
    assert peek() is None, expression
    return truthy(value)


STAGING = "refs/heads/staging"
PUSH = {"github": {"event_name": "push", "ref": STAGING}}
PUSH_MAIN = {"github": {"event_name": "push", "ref": "refs/heads/main"}}
NIGHTLY = {"github": {"event_name": "schedule", "ref": STAGING}}
DISPATCH_ON = {"github": {"event_name": "workflow_dispatch", "ref": STAGING}, "inputs": {"model": True}}
DISPATCH_OFF = {"github": {"event_name": "workflow_dispatch", "ref": STAGING}, "inputs": {"model": False}}


def looked_up(context, hit):
    """`context` with the lookup job's answer: whether this tree already passed on its pull request (UNB-166)."""
    return {**context, "needs": {"passed": {"outputs": {"hit": hit}}}}


def needs_of(text, job):
    block = re.split(r"(?m)^  [A-Za-z_][\w-]*:\s*$", text.split(f"\n  {job}:\n", 1)[1], maxsplit=1)[0]
    line = re.search(r"(?m)^    needs: (.+)$", block)
    return [n.strip() for n in line.group(1).strip("[]").split(",")] if line else []


class QaWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.conditions = job_conditions(WORKFLOW.read_text())

    def test_the_evaluator_reads_null_as_false_the_way_github_does(self):
        # The fault this file guards: a push's missing input equals false, so `!= false` skips the job.
        self.assertFalse(evaluate("inputs.model != false", PUSH))
        self.assertTrue(evaluate("inputs.model != false", DISPATCH_ON))
        self.assertTrue(evaluate("github.event_name == 'PUSH'", PUSH))

    def test_the_model_jobs_run_on_every_push_and_the_nightly_run(self):
        for job in ("qa", "skills"):
            for name, context in (("push to staging", PUSH), ("push to main", PUSH_MAIN), ("nightly", NIGHTLY)):
                with self.subTest(job=job, event=name):
                    self.assertTrue(evaluate(self.conditions[job], context), f"{job} is skipped on a {name}: {self.conditions[job]}")

    def test_the_model_switch_turns_the_model_jobs_on_and_off_by_hand(self):
        for job in ("qa", "skills"):
            with self.subTest(job=job):
                self.assertTrue(evaluate(self.conditions[job], DISPATCH_ON))
                self.assertFalse(evaluate(self.conditions[job], DISPATCH_OFF))

    def test_the_mcp_check_runs_on_every_event(self):
        for context in (PUSH, PUSH_MAIN, NIGHTLY, DISPATCH_ON, DISPATCH_OFF):
            self.assertTrue(evaluate(self.conditions["check"], context))

    def test_a_push_whose_tree_passed_on_its_pull_request_skips_the_build_and_the_three_jobs_that_need_it(self):
        build = self.conditions["build"]
        self.assertTrue(evaluate(build, looked_up(PUSH, "false")))
        self.assertTrue(evaluate(build, looked_up(PUSH_MAIN, "false")))
        self.assertTrue(evaluate(build, looked_up(PUSH, "")), "a lookup that wrote nothing is no hit")
        self.assertFalse(evaluate(build, looked_up(PUSH, "true")))
        # A job with no status function in its `if` is skipped when a job it needs was skipped: these three need the
        # build, so they go with it, and the report goes with Claude QA (its `ran` output is then empty).
        text = WORKFLOW.read_text()
        self.assertEqual(needs_of(text, "build"), ["passed"])
        # check and qa also need the place job (#787), which has no `if` and so is never skipped.
        for job in ("check", "qa", "bank"):
            self.assertEqual([n for n in needs_of(text, job) if n != "place"], ["build"], job)
            self.assertNotRegex(self.conditions[job], r"always\(\)|cancelled\(\)|failure\(\)", f"{job} would run past a skipped build")
        self.assertNotIn("if:", text.split("\n  place:\n", 1)[1].split("\n    steps:\n", 1)[0])
        self.assertEqual(self.conditions["report"], "always() && needs.qa.outputs.ran == 'true'")
        self.assertFalse(evaluate("needs.qa.outputs.ran == 'true'", looked_up(PUSH, "true")))
        self.assertNotIn("passed", self.conditions)  # the lookup itself runs on every event

    def test_the_nightly_run_and_a_run_by_hand_run_everything_whatever_the_lookup_says(self):
        for name, context in (("nightly", NIGHTLY), ("by hand", DISPATCH_ON), ("by hand, no model", DISPATCH_OFF)):
            with self.subTest(event=name):
                self.assertTrue(evaluate(self.conditions["build"], looked_up(context, "true")))
                self.assertTrue(evaluate(self.conditions["check"], looked_up(context, "true")))

    def test_skill_triggers_and_journey_coverage_do_not_wait_for_the_lookup(self):
        # Skill triggers has its own record of what passed (its inputs' hash); journey coverage costs seconds.
        text = WORKFLOW.read_text()
        self.assertNotIn("passed", needs_of(text, "skills"))
        self.assertEqual(needs_of(text, "coverage"), [])
        self.assertNotIn("needs.passed", self.conditions["skills"])
        self.assertTrue(evaluate(self.conditions["skills"], looked_up(PUSH, "true")))

    def test_a_push_that_ran_nothing_posts_nothing_to_the_dashboard(self):
        dashboard = self.conditions["dashboard"].replace("always()", "true")
        self.assertFalse(evaluate(dashboard, looked_up(PUSH, "true")))
        self.assertTrue(evaluate(dashboard, looked_up(PUSH, "false")))
        self.assertTrue(evaluate(dashboard, looked_up(NIGHTLY, "true")))
        self.assertIn("passed", needs_of(WORKFLOW.read_text(), "dashboard"))


class OnePlaceJobTest(unittest.TestCase):
    """QA's place job hands out the Mac once for the whole run, the slice included (UNB-235): gate-bank.yml's own place
    job skips the run it is in, so it put the slice on the Mac beside Claude QA's shard 4 (dispatch 44948600956)."""

    def test_the_slice_is_placed_by_qa_and_handed_to_the_gate_bank(self):
        text = WORKFLOW.read_text()
        self.assertIn("place_jobs.py slice=mac ", text)
        self.assertIn("      slice: ${{ steps.place.outputs.slice }}\n", text)
        bank = text.split("\n  bank:\n", 1)[1].split("\n  report:\n", 1)[0]
        self.assertIn("runs_on: ${{ needs.place.outputs.slice }}", bank)
        self.assertIn("place", needs_of(text, "bank"))
        gate = WORKFLOW.with_name("gate-bank.yml").read_text().split("\n  place:\n", 1)[1].split("\n  bank:\n", 1)[0]
        self.assertIn("PLACED: ${{ inputs.runs_on }}", gate)
        self.assertIn('echo "bank=$PLACED" >> "$GITHUB_OUTPUT"', gate)
        self.assertIn("python3 -I .github/scripts/place_jobs.py bank=mac", gate)

    def test_only_the_nightly_run_uses_the_mac(self):
        # A push has 15 minutes; the Mac took 9 min 36 s to download the build on dispatch 44948600956.
        self.assertIn("MAC_POOL: ${{ github.event_name == 'schedule' && vars.MAC_RUNNER || '' }}", WORKFLOW.read_text())


def scrub_head(text):
    """The Scrub step's lines that pick up the agent's report, up to the cost: shell only, safe to run in a temp dir."""
    block = text.split("- name: Scrub the report", 1)[1].split("run: |\n", 1)[1]
    return block.split('if [ -n "$EXECUTION" ]', 1)[0].split("# What the run cost", 1)[0]


class ScrubReadsTheReportTest(unittest.TestCase):
    """PR #792's run passed all 27 checks but wrote both files into WORK (qa-work/), so the verdict read 'no verdict'."""

    def run_scrub(self, workflow, setup):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "ws"; out = Path(tmp) / "temp"
            (root / "qa-work").mkdir(parents=True); out.mkdir()
            setup(root)
            subprocess.run(["bash", "-e", "-c", scrub_head(workflow.read_text())], cwd=root, check=True,
                           env={"RUNNER_TEMP": str(out), "PATH": "/usr/bin:/bin"})
            return (out / "qa-out/qa-verdict.json").read_text(), (out / "qa-out/qa-report.md").read_text()

    def test_a_report_written_into_work_is_read(self):
        def setup(root):
            (root / "qa-work/qa-verdict.json").write_text('{"pass": true, "checks": [{"n": 1}]}')
            (root / "qa-work/qa-report.md").write_text("1 pass")
        for workflow in (WORKFLOW, WORKFLOW.with_name("pr-agent-checks.yml")):
            with self.subTest(workflow=workflow.name):
                verdict, report = self.run_scrub(workflow, setup)
                self.assertIn('"pass": true', verdict)
                self.assertEqual(report, "1 pass")

    def test_the_root_report_wins_and_a_planted_link_is_not_followed(self):
        def setup(root):
            (root / "secret.json").write_text('{"pass": true, "planted": 1}')
            (root / "qa-work/qa-verdict.json").symlink_to(root / "secret.json")
            (root / "qa-report.md").write_text("root report")
            (root / "qa-work/qa-report.md").write_text("work report")
        verdict, report = self.run_scrub(WORKFLOW, setup)
        self.assertNotIn("planted", verdict)
        self.assertIn('"pass": false', verdict)
        self.assertEqual(report, "root report")


if __name__ == "__main__":
    unittest.main()
