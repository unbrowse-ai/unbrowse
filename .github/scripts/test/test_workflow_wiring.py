"""What a workflow job is handed is what it uses: the scripts it runs and the secrets it reads.

Two ways a job runs with something missing and fails on it, both read from the workflow files themselves:

- a step runs a script from the repository before any checkout put it there: a job starts with an empty work tree
  (Code review 45318046756: "can't open file .github/scripts/review_plan.py");
- a called workflow reads a secret its `workflow_call` never declared, or its caller never passed: it reads as empty,
  with no error (QA 45316072080, the gate bank's slice: OPENCODE_API_KEY empty, nine tasks "error" in 0.7 s each).
"""
from __future__ import annotations

import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]
WORKFLOWS = ROOT / ".github" / "workflows"

# A script of the repository's that a step runs: `python3 .github/scripts/x.py`, `sh .github/qa/x.sh`,
# `"$GITHUB_WORKSPACE/.github/scripts/x.py"`. A path in a comment, an echo or a heredoc is not a run.
RUNS = re.compile(r"(?:^|[\s\"'/}])(\.github/(?:scripts|qa)/[\w./-]+\.(?:py|sh|mjs|js))")
GIVEN = {"GITHUB_TOKEN"}


def load(path: pathlib.Path) -> dict:
    doc = yaml.safe_load(path.read_text()) or {}
    # YAML reads a bare `on:` as True.
    if True in doc and "on" not in doc:
        doc["on"] = doc.pop(True)
    return doc


def run_lines(text: str) -> list[str]:
    lines = []
    for line in text.splitlines():
        code = line.split(" #", 1)[0].strip()
        if not code or code.startswith("#") or code.startswith("echo ") or code.startswith("printf "):
            continue
        lines.append(code)
    return lines


def scripts_run_before_a_checkout(doc: dict) -> list[str]:
    problems = []
    for name, job in (doc.get("jobs") or {}).items():
        if "uses" in job:
            continue
        whole = False
        sparse: set[str] = set()
        for step in job.get("steps") or []:
            if not isinstance(step, dict):
                continue
            uses = str(step.get("uses", ""))
            if uses.startswith("actions/checkout@"):
                w = step.get("with") or {}
                if w.get("path"):
                    continue
                paths = w.get("sparse-checkout")
                if paths:
                    sparse |= {p.strip() for p in str(paths).split() if p.strip()}
                else:
                    whole = True
                continue
            if whole or "run" not in step or step.get("working-directory"):
                continue
            for line in run_lines(str(step["run"])):
                for script in RUNS.findall(line):
                    if not any(script == p or script.startswith(p.rstrip("/") + "/") for p in sparse):
                        problems.append(f"job {name}: step {step.get('name') or step.get('id') or '?'} runs "
                                        f"{script} before a checkout put it there")
    return problems


def secrets_read(node) -> set[str]:
    return set(re.findall(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)", yaml.safe_dump(node)))


def called_secrets_unwired(called: dict[str, dict], callers: dict[str, dict]) -> list[str]:
    problems = []
    for file, doc in called.items():
        call = (doc.get("on") or {}).get("workflow_call") or {}
        declared = set((call.get("secrets") or {}).keys())
        missing = secrets_read(doc.get("jobs") or {}) - declared - GIVEN
        if missing:
            problems.append(f"{file}: reads {sorted(missing)} that its workflow_call doesn't declare")
        # A job held to the called workflow's own name (`github.workflow == 'Gate bank'`) never runs when it is called:
        # its secrets are not the caller's to pass.
        own = f"github.workflow == '{doc.get('name')}'"
        needed = declared & set().union(*[secrets_read(j) for j in (doc.get("jobs") or {}).values()
                                          if own not in " ".join(str(j.get("if", "")).split())] or [set()])
        for caller, cdoc in callers.items():
            for name, job in (cdoc.get("jobs") or {}).items():
                if str(job.get("uses", "")) != f"./.github/workflows/{file}":
                    continue
                given = job.get("secrets")
                if given == "inherit":
                    continue
                unpassed = needed - set((given or {}).keys()) - GIVEN
                if unpassed:
                    problems.append(f"{caller}: job {name} calls {file} without {sorted(unpassed)}")
    return problems


def summaries_that_fail_on_nothing_to_say(doc: dict) -> list[str]:
    """A `{ ...; } >> "$GITHUB_STEP_SUMMARY"` block whose last command is a bare `[ ... ] && ...`: with nothing to add,
    the test's 1 is the block's status, and under `bash -e` the step fails (Staging autofix 45328137535: "Summary",
    exit 1, when it was asked to do nothing and wrote no summary)."""
    problems = []
    for name, job in (doc.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            if not isinstance(step, dict) or "run" not in step:
                continue
            lines = str(step["run"]).splitlines()
            for i, line in enumerate(lines):
                if not re.match(r'\s*\}\s*>>\s*"?\$GITHUB_STEP_SUMMARY"?', line):
                    continue
                last = next((l.strip() for l in reversed(lines[:i]) if l.strip() and not l.strip().startswith("#")), "")
                if re.match(r"(?:\[|test\s).*&&", last):
                    problems.append(f"job {name}: step {step.get('name') or step.get('id') or '?'} ends its summary with `{last[:60]}`")
    return problems


def a_schedule_cancels_a_push(doc: dict) -> bool:
    """Whether a workflow's scheduled run and a push's run share one group that cancels in progress: the nightly run
    then kills the push's run of the same commit (QA 45328263663, cancelled at 05:01 by the schedule started at 05:00),
    and the push's verdict is never written."""
    on = doc.get("on") or {}
    if not ("push" in on and "schedule" in on):
        return False
    c = doc.get("concurrency")
    if not isinstance(c, dict) or not c.get("cancel-in-progress"):
        return False
    return "github.event_name" not in str(c.get("group", ""))


class TheSliceRunsEveryClient(unittest.TestCase):
    """The slice's clients step, run as GitHub runs it (`bash -e`) on two rounds: one cold client that fails must not
    stop its round. Fresh verifiers of #935 ran it and found it did: the rest of the round's cold asks and all of its
    warm asks were skipped and its node left running."""

    def run_step(self, workflow):
        import os, subprocess, tempfile, yaml
        doc = yaml.safe_load((WORKFLOWS / workflow).read_text())
        steps = {s.get("name"): s for job in doc["jobs"].values() for s in job.get("steps") or [] if isinstance(s, dict)}
        cold, warm = steps["The clients, cold"], steps["The clients, warm"]
        with tempfile.TemporaryDirectory() as d:
            runs, temp = os.path.join(d, "runs"), os.path.join(d, "temp")
            for r in (0, 1):
                os.makedirs(os.path.join(runs, f"round-{r}", "warm"))
                os.makedirs(os.path.join(temp, f"n{r}"))
                with open(os.path.join(temp, f"n{r}", "node.pid"), "w") as f:
                    f.write("999999")
                for k in range(2):
                    open(os.path.join(runs, f"round-{r}", f"{k:03}.args"), "wb").write(b"cold")
                    open(os.path.join(runs, f"round-{r}", "warm", f"{k:03}.args"), "wb").write(b"warm")
            # The client: says it ran, and the first cold one of round 0 fails as a killed or errored client does.
            fake = os.path.join(d, "claude")
            with open(fake, "w") as f:
                f.write('#!/bin/sh\necho ran >> "$0.log"\ncase "$PWD" in *) ;; esac\n'
                        '[ -e "$0.failed" ] || { touch "$0.failed"; exit 7; }\nexit 0\n')
            os.chmod(fake, 0o755)
            # gate-bank.yml names its run's folder and nodes on the step (RUNS, NODES: the first run, or the run again).
            env = dict(os.environ, GATE=d, RUNNER_TEMP=temp, CLAUDE_BIN=fake, RUNS=runs, NODES="n")
            first = subprocess.run(["bash", "-e", "-c", cold["run"]], env=env, capture_output=True, text=True, timeout=120)
            got = subprocess.run(["bash", "-e", "-c", warm["run"]], env=env, capture_output=True, text=True, timeout=120)
            got.returncode = first.returncode or got.returncode
            got.stdout, got.stderr = first.stdout + got.stdout, first.stderr + got.stderr
            ran = open(fake + ".log").read().count("ran") if os.path.exists(fake + ".log") else 0
            outs = sum(1 for r in (0, 1) for w in ("", "warm") for k in range(2)
                       if os.path.exists(os.path.join(runs, f"round-{r}", w, f"{k:03}.out")))
            return got, ran, outs

    def test_a_failing_cold_client_does_not_stop_its_round(self):
        for workflow in ("gate-bank.yml", "pr-agent-checks.yml"):
            with self.subTest(workflow=workflow):
                got, ran, outs = self.run_step(workflow)
                self.assertEqual(got.returncode, 0, got.stdout + got.stderr)
                self.assertEqual(ran, 8, f"every client of both rounds runs, cold and warm: {got.stdout}{got.stderr}")
                self.assertIn("round 0 done", got.stdout)
                self.assertIn("round 1 done", got.stdout)


class TheWarmRunsAreWrittenAfterTheColdWave(unittest.TestCase):
    """A warm client is handed the routes its cold ask saved, which exist only once that ask has run. The cold wave, a
    step with no credential that writes the warm runs from the cold asks' own output (`run_gate.py warm-args`), and
    the warm wave are three steps in that order, in every workflow that runs the gate's clients."""

    def test_every_clients_run_writes_its_warm_runs_between_the_waves_without_a_credential(self):
        import yaml
        seen = 0
        for workflow in ("gate-bank.yml", "pr-agent-checks.yml"):
            doc = yaml.safe_load((WORKFLOWS / workflow).read_text())
            for job in doc["jobs"].values():
                steps = [s for s in job.get("steps") or [] if isinstance(s, dict)]
                names = [str(s.get("name") or "") for s in steps]
                for i, name in enumerate(names):
                    if not name.startswith("The clients, cold"):
                        continue
                    seen += 1
                    with self.subTest(workflow=workflow, step=name):
                        suffix = name[len("The clients, cold"):]
                        write, warm = names.index("Write the warm runs" + suffix), names.index("The clients, warm" + suffix)
                        self.assertLess(i, write)
                        self.assertLess(write, warm)
                        step = steps[write]
                        self.assertIn("test-banks/gate/run_gate.py warm-args --dir", step["run"])
                        self.assertNotIn("secrets.", yaml.safe_dump(step), "the step that runs the script holds no credential")
                        self.assertEqual(step.get("if"), steps[i].get("if"), "it runs whenever the cold wave ran")
                        self.assertNotIn("kill", steps[i]["run"], "the round's node stays up for its warm wave")
                        self.assertIn("node.pid", steps[warm]["run"], "the warm wave stops each round's node")
        self.assertEqual(seen, 3, "the bank's run, the bank's run again and the pull request's slice")


class WhatAJobIsHandedIsWhatItUses(unittest.TestCase):
    def docs(self) -> dict[str, dict]:
        return {p.name: load(p) for p in sorted(WORKFLOWS.glob("*.y*ml"))}

    def test_no_step_runs_a_script_before_a_checkout_put_it_there(self):
        for file, doc in self.docs().items():
            with self.subTest(workflow=file):
                self.assertEqual(scripts_run_before_a_checkout(doc), [])

    def test_a_called_workflow_declares_every_secret_it_reads_and_its_callers_pass_them(self):
        docs = self.docs()
        called = {f: d for f, d in docs.items() if "workflow_call" in (d.get("on") or {})}
        self.assertIn("gate-bank.yml", called)
        self.assertEqual(called_secrets_unwired(called, docs), [])

    def test_a_summary_with_nothing_to_add_does_not_fail_its_step(self):
        for file, doc in self.docs().items():
            with self.subTest(workflow=file):
                self.assertEqual(summaries_that_fail_on_nothing_to_say(doc), [])
        broken = {"jobs": {"fix": {"steps": [{"name": "Summary", "run": '{\n  echo "Asked: $ACT"\n  [ -f .autofix/summary.md ] && { echo; cat .autofix/summary.md; }\n} >> "$GITHUB_STEP_SUMMARY"\n'}]}}}
        self.assertEqual(len(summaries_that_fail_on_nothing_to_say(broken)), 1, "the reader sees the shape that broke")

    def test_a_scheduled_run_never_cancels_a_pushs(self):
        for file, doc in self.docs().items():
            with self.subTest(workflow=file):
                self.assertFalse(a_schedule_cancels_a_push(doc), "the schedule's run would cancel the push's")
        shared = {"on": {"push": {}, "schedule": [{}]}, "concurrency": {"group": "qa-${{ github.ref }}", "cancel-in-progress": True}}
        self.assertTrue(a_schedule_cancels_a_push(shared), "the reader sees the shape that broke")

    def test_the_readers_catch_what_broke(self):
        """Both readers, on the two workflows as they were when each failed."""
        before_review = {"jobs": {"review": {"steps": [
            {"id": "auth", "run": "echo ok"},
            {"name": "The pull request to review", "run": "python3 -I .github/scripts/review_plan.py --run 1"},
            {"uses": "actions/checkout@x", "with": {"ref": "staging"}},
        ]}}}
        self.assertEqual(len(scripts_run_before_a_checkout(before_review)), 1)
        sparse_first = {"jobs": {"review": {"steps": [
            {"uses": "actions/checkout@x", "with": {"sparse-checkout": ".github/scripts/review_plan.py"}},
            {"run": "python3 -I .github/scripts/review_plan.py --run 1"},
            {"run": "python3 -I .github/scripts/code_review.py"},
        ]}}}
        self.assertEqual(len(scripts_run_before_a_checkout(sparse_first)), 1, "a sparse checkout holds only its paths")
        bank = {"on": {"workflow_call": {"secrets": {"ANTHROPIC_API_KEY": {"required": False}}}},
                "jobs": {"run": {"steps": [{"env": {"K": "${{ secrets.OPENCODE_API_KEY }}",
                                                    "A": "${{ secrets.ANTHROPIC_API_KEY }}"}}]}}}
        qa = {"jobs": {"slice": {"uses": "./.github/workflows/gate-bank.yml",
                                 "secrets": {"ANTHROPIC_API_KEY": "${{ secrets.ANTHROPIC_API_KEY }}"}}}}
        self.assertEqual(len(called_secrets_unwired({"gate-bank.yml": bank}, {"qa.yml": qa})), 1)
        bank["on"]["workflow_call"]["secrets"]["OPENCODE_API_KEY"] = {"required": False}
        self.assertEqual(len(called_secrets_unwired({"gate-bank.yml": bank}, {"qa.yml": qa})), 1,
                         "declared but not passed is still empty")


if __name__ == "__main__":
    unittest.main()
