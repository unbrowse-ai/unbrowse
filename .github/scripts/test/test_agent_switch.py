"""Verify subscription-only model routing across CI workflows."""
import pathlib
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]
WORKFLOWS = ROOT / ".github/workflows"

OPENCODE_PIN = "@opencode/cli@2."
AUTH_MODE = "chatgpt"
CREDENTIALS = ("OPENCODE_CHATGPT_ACCESS_TOKEN", "OPENCODE_CHATGPT_CREDENTIAL_KEY")


def load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text())


def steps_of(doc: dict):
    """Each step with its job and the env the runner would give it, the workflow's first."""
    wf_env = doc.get("env") or {}
    for job_name, job in (doc.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        job_env = job.get("env") or {}
        for step in job.get("steps") or []:
            if not isinstance(step, dict):
                continue
            env = {**wf_env, **job_env, **(step.get("env") or {})}
            yield job_name, step, env


class TheSwitchReachesEveryModelStep(unittest.TestCase):
    def test_ci_model_jobs_cannot_select_api_key_billing(self):
        for path in sorted(WORKFLOWS.glob("*.yml")):
            source = path.read_text()
            with self.subTest(workflow=path.name):
                self.assertNotRegex(source, r"vars\.AGENT_(AUTH|CLI|MODEL)\b")
                self.assertNotRegex(source, r"secrets\.(OPENCODE_API_KEY|OPENAI_API_KEY|ORCAROUTER_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN\w*)\b")
                self.assertNotRegex(source, r"(?m)^\s*(?:OPENCODE_API_KEY|OPENAI_API_KEY|ORCAROUTER_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN\w*):")

    def test_no_step_asks_a_model_around_the_wrapper(self):
        """A step that runs Claude's own action asks Claude whatever the switch says: the Bank's Writes did, and died on
        a Claude credential with no use left (45325366642: is_error after 427 ms, one turn) while every wrapped step ran
        on opencode. Every model step goes through agent_cli.py."""
        around = [f"{path.name}: job {job}, step {step.get('name') or step.get('id')!r}"
                  for path in sorted(WORKFLOWS.glob("*.yml"))
                  for job, step, _ in steps_of(yaml.safe_load(path.read_text()) or {})
                  if str(step.get("uses", "")).startswith("anthropics/claude-code-action@")]
        self.assertEqual(around, [], "every model job must run through .github/scripts/agent_cli.py")

    def test_model_jobs_install_opencode_without_a_provider_switch(self):
        asking = 0
        for path in sorted(WORKFLOWS.glob("*.yml")):
            doc = load(path.name)
            for job, body in doc.get("jobs", {}).items():
                steps = body.get("steps") or []
                runs = [str(step.get("run") or "") for step in steps]
                if "agent_cli.py" not in "\n".join(runs) and "agent_cli.py" not in str((body.get("env") or {}).get("CLAUDE_BIN")):
                    continue
                asking += 1
                installs = [step for step, run in zip(steps, runs)
                            if OPENCODE_PIN in run or (".github/tools/opencode" in run and "npm" in run)]
                where = f"{path.name}: job {job}"
                self.assertTrue(installs, f"{where} does not install OpenCode")
                self.assertTrue(all("AGENT_" not in str(step.get("if") or "") for step in installs), where)
                self.assertNotIn(".github/tools/claude-cli", "\n".join(runs), where)
        self.assertGreater(asking, 0)

    def test_code_review_checks_out_trusted_staging_in_full_before_planning(self):
        steps = load("opencode-review.yml")["jobs"]["review"]["steps"]
        checkouts = [s for s in steps if s.get("uses", "").startswith("actions/checkout@")]
        self.assertEqual(len(checkouts), 2)
        checkout, pull_request = checkouts
        self.assertEqual(checkout["with"]["ref"], "staging")
        self.assertNotIn("sparse-checkout", checkout["with"])
        self.assertFalse(checkout["with"]["persist-credentials"])
        self.assertEqual(pull_request["with"]["path"], "pr")
        plan = next(s for s in steps if s.get("id") == "plan")
        self.assertLess(steps.index(checkout), steps.index(plan))
        self.assertLess(steps.index(plan), steps.index(pull_request))

    def test_all_model_steps_receive_only_a_step_scoped_oauth_grant(self):
        asking = 0
        for path in sorted(WORKFLOWS.glob("*.yml")):
            doc = load(path.name)
            for secret in CREDENTIALS:
                self.assertNotIn(secret, doc.get("env") or {}, path.name)
            for job in (doc.get("jobs") or {}).values():
                for secret in CREDENTIALS:
                    self.assertNotIn(secret, job.get("env") or {}, path.name)
            for job, step, env in steps_of(doc):
                run = str(step.get("run") or "")
                invokes_bank_cli = any(line.strip().startswith(('1200 "$CLAUDE_BIN"', '300 "$CLAUDE_BIN"'))
                                       for line in run.splitlines())
                if "agent_cli.py" not in run.replace("agent_cli.py --which-model", "") and not invokes_bank_cli:
                    continue
                asking += 1
                self.assertEqual(env.get("AGENT_AUTH"), AUTH_MODE, (path.name, job))
                for secret in CREDENTIALS:
                    self.assertEqual((step.get("env") or {}).get(secret), f"${{{{ secrets.{secret} }}}}",
                                     (path.name, job, step.get("name")))
                self.assertEqual(env.get("OPENCODE_CHATGPT_CREDENTIAL_URL"),
                                 "${{ vars.OPENCODE_CHATGPT_CREDENTIAL_URL }}", (path.name, job))
        self.assertGreater(asking, 0)

    def test_every_opencode_install_is_the_cli_the_wrapper_targets(self):
        """The wrapper answers opencode 2.x's events and passes its `--archived`: a 1.x npm package rejects the flag
        (help text, exit 1), so the pin and the wrapper move together."""
        for path in sorted(WORKFLOWS.glob("*.yml")):
            for job, step, env in steps_of(yaml.safe_load(path.read_text()) or {}):
                run = str(step.get("run") or "")
                if "npm i" not in run and "npm ci" not in run:
                    continue
                self.assertNotIn("opencode-ai@", run,
                                 f"{path.name}: job {job} installs an opencode 1.x package; the wrapper passes 2.x's --archived")

    def test_the_gate_banks_runs_exec_the_wrapper(self):
        """The bank's `.args` files are Claude argv, exec'd against CLAUDE_BIN by hand: that has to be the wrapper,
        which runs OpenCode and translates its events to the stream run_gate.py reads. The bank
        is run from two places — gate-bank.yml's job and pr-agent-checks.yml's own slice copy — and both exec it."""
        runners = 0
        for path in sorted(WORKFLOWS.glob("*.yml")):
            for job, body in load(path.name).get("jobs", {}).items():
                claude_bin = (body.get("env") or {}).get("CLAUDE_BIN")
                if not claude_bin:
                    continue
                runners += 1
                self.assertIn("agent_cli.py", str(claude_bin), f"{path.name}: job {job} bypasses the wrapper")
        self.assertGreater(runners, 0, "no job execs a CLAUDE_BIN any more; say why, not silence")

    def test_a_model_session_keeps_the_words_of_one_that_dies(self):
        """A session's stderr is the only place a CLI that died says why: 'Credit balance is too low' lived in the
        QA artifacts, and the parallel session steps threw their stderr away, so a dead session left no words."""
        for path in sorted(WORKFLOWS.glob("*.yml")):
            for job, step, env in steps_of(yaml.safe_load(path.read_text()) or {}):
                run = str(step.get("run") or "")
                if "agent_cli.py" not in run and '"$cli" -p' not in run:
                    continue
                self.assertNotIn("2>/dev/null", run,
                                 f"{path.name}: job {job}, step {step.get('name')!r} throws away the model CLI's words")

    def test_callers_forward_the_oauth_inputs_the_bank_declares(self):
        doc = load("gate-bank.yml")
        triggers = doc.get("on") if isinstance(doc.get("on"), dict) else (doc.get(True) or {})
        declared = ((triggers.get("workflow_call") or {}).get("secrets") or {})
        self.assertTrue(set(CREDENTIALS) <= declared.keys(), "gate-bank.yml must declare both OAuth inputs")
        callers = 0
        for path in sorted(WORKFLOWS.glob("*.yml")):
            for job_name, job in (yaml.safe_load(path.read_text()) or {}).get("jobs", {}).items():
                if not isinstance(job, dict) or "gate-bank.yml" not in str(job.get("uses") or ""):
                    continue
                callers += 1
                for secret in CREDENTIALS:
                    self.assertEqual((job.get("secrets") or {}).get(secret), f"${{{{ secrets.{secret} }}}}",
                                     f"{path.name}: job {job_name} calls the bank without {secret}")
        self.assertGreater(callers, 0, "nothing calls the bank any more; if that changed, say why")


if __name__ == "__main__":
    unittest.main()
