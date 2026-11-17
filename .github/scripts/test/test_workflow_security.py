from pathlib import Path
import re
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]


class WorkflowSecurityTest(unittest.TestCase):
    def test_no_job_with_id_token_or_a_secret_executes_a_file_from_an_artifact(self):
        workflows = [
            *sorted((ROOT / ".github/workflows").glob("*.y*ml")),
            *sorted((ROOT / "unbrowse-browser/.github/workflows").glob("*.y*ml")),
        ]
        for workflow_path in workflows:
            workflow = yaml.safe_load(workflow_path.read_text())
            for job_name, job in workflow.get("jobs", {}).items():
                body = str(job)
                permissions = job.get("permissions", workflow.get("permissions", {})) or {}
                permission_values = permissions.values() if isinstance(permissions, dict) else ()
                has_authority = bool(re.search(r"\$\{\{\s*secrets\.", body)) or any(
                    str(value).lower() == "write" for value in permission_values
                ) or str(permissions).lower() == "write-all"
                if not has_authority:
                    continue

                steps = job.get("steps", [])
                artifact_paths = []
                for step in steps:
                    if not isinstance(step, dict):
                        continue
                    if str(step.get("uses", "")).startswith("actions/checkout@"):
                        ref = str((step.get("with") or {}).get("ref", ""))
                        self.assertNotRegex(
                            ref,
                            r"(?i)pull_request|refs/pull/|github\.head_ref|event\.pull_request",
                            f"{workflow_path}:{job_name} checks out a PR-controlled ref",
                        )
                    if str(step.get("uses", "")).startswith("actions/download-artifact@"):
                        inputs = step.get("with") or {}
                        self.assertNotEqual(
                            inputs.get("name"),
                            "npm-cli",
                            f"{workflow_path}:{job_name} downloads an executable npm CLI",
                        )
                        path = str(inputs.get("path", ""))
                        if path:
                            artifact_paths.append(path.rstrip("/"))
                            self.assertNotRegex(
                                path,
                                r"(?i)(?:^|/)node_modules(?:/|$)|\.bin(?:/|$)",
                                f"{workflow_path}:{job_name} downloads executable dependencies",
                            )
                run_text = "\n".join(str(step.get("run", "")) for step in steps if isinstance(step, dict))
                self.assertNotRegex(
                    run_text,
                    r"(?im)^\s*(?:node|python(?:\d+)?|bash|sh)\s+(?:\"?\$?(?:GITHUB_WORKSPACE|RUNNER_TEMP)/)?(?:\./)?(?:dist|updates|release-artifacts)(?:/|\s)",
                    f"{workflow_path}:{job_name} executes a downloaded artifact",
                )
                for artifact_path in artifact_paths:
                    self.assertNotRegex(
                        run_text,
                        rf"(?im)^\s*(?:node|python(?:\d+)?|bash|sh)\s+(?:-[A-Za-z0-9]+\s+)*[\"']?(?:\$(?:GITHUB_WORKSPACE|RUNNER_TEMP)/)?(?:\./)?{re.escape(artifact_path)}/",
                        f"{workflow_path}:{job_name} executes a program from artifact path {artifact_path}",
                    )
                    self.assertNotRegex(
                        run_text,
                        rf"(?im)^\s*(?:\./|source\s+|\.\s+)[\"']?(?:\$(?:GITHUB_WORKSPACE|RUNNER_TEMP)/)?{re.escape(artifact_path)}/",
                        f"{workflow_path}:{job_name} sources or directly executes a downloaded artifact",
                    )

                # Downloaded artifacts may be verified or passed to a trusted publisher, but the publisher CLI must
                # be installed in this job from the trusted checkout's integrity-locked file with scripts disabled.
                if "npm publish" in run_text or "npm-publish.sh" in run_text:
                    self.assertIn("npm ci --ignore-scripts --prefix .github/tools/npm", run_text, f"{workflow_path}:{job_name}")
                    self.assertNotIn("npm-cli.js", run_text, f"{workflow_path}:{job_name}")

    def test_model_secrets_are_unavailable_to_pull_request_controlled_workflow_code(self):
        workflows = [*sorted((ROOT / ".github/workflows").glob("*.y*ml")), *sorted((ROOT / "unbrowse-browser/.github/workflows").glob("*.y*ml"))]
        for workflow in workflows:
            text = workflow.read_text()
            if not re.search(r"\$\{\{\s*secrets\.[A-Za-z0-9_]+", text):
                continue
            # Secret-bearing automation is post-merge/manual on staging; reject PR triggers and explicit PR checkouts.
            self.assertNotRegex(text, r"(?m)^\s*pull_request(?:_[a-z_]+)?:", str(workflow))
            self.assertNotRegex(text, r"(?i)pull_request\.head|refs/pull/|github\.event\.pull_request\.head")
        qa = (ROOT / ".github/workflows/qa.yml").read_text()
        # Nightly and by hand on staging: no push starts it, and no pull request.
        self.assertIn("schedule:", qa)
        self.assertNotRegex(qa, r"(?m)^  push:")
        self.assertNotIn("pull_request:", qa)
        # It posts on no pull request, so no job of it holds a permission to: its report goes in the run's summary.
        self.assertNotIn("pull-requests: write", qa)
        self.assertNotIn("gh pr comment", qa)
        header = "\n".join(line for line in qa.splitlines() if line.startswith("#"))
        self.assertNotRegex(header, r"built from the pull request|goes on the pull request|comment goes on")
        polish = (ROOT / ".github/workflows/sdk-polish.yml").read_text()
        self.assertIn("if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/staging'", polish)

    def test_no_step_with_a_model_secret_runs_pull_request_scripts_or_unlocked_installs(self):
        workflows = [
            *sorted((ROOT / ".github/workflows").glob("*.y*ml")),
            *sorted((ROOT / "unbrowse-browser/.github/workflows").glob("*.y*ml")),
        ]
        secret_names = ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")
        for workflow in workflows:
            for step in workflow.read_text().split("      - ")[1:]:
                if not any(f"secrets.{name}" in step for name in secret_names):
                    continue
                self.assertNotRegex(step, r"(?m)^\s*run:.*(?:test-banks/|\.github/qa/|npm install)", str(workflow))
                self.assertNotIn("npm install", step, str(workflow))
        qa = (ROOT / ".github/workflows/qa.yml").read_text()
        self.assertIn("npm ci --silent --ignore-scripts --prefix .github/tools/claude-cli", qa)
        self.assertIn("name: Run tool choice sessions", qa)
        model_step = qa.split("      - name: Run tool choice sessions\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("secrets.ANTHROPIC_API_KEY", model_step)
        self.assertNotIn("python3", model_step)
        self.assertNotIn("test-banks/", model_step)

    def test_no_model_credential_is_in_the_environment_of_an_install(self):
        # A package's install scripts, or the package manager itself, read the environment they run in. A model
        # credential sits only on the steps that use it, never on a workflow's or job's env (which every step reads),
        # never handed on through GITHUB_ENV, and never on a step that installs anything.
        installs = re.compile(
            r"\b(?:npm\s+(?:install|i|ci|exec|update)|npx|pnpm\s+(?:install|i|add|dlx)|yarn(?:\s+(?:install|add|dlx))?|bunx?(?:\s+(?:install|add|x))?|pip3?\s+install|python3?\s+-m\s+pip|pipx|uvx?|cargo\s+install|brew\s+install|apt(?:-get)?\s+install|curl|wget)\b"
        )
        model = re.compile(r"secrets\s*\.\s*(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN\w*)", re.IGNORECASE)
        workflows = [*sorted((ROOT / ".github/workflows").glob("*.y*ml")), *sorted((ROOT / "unbrowse-browser/.github/workflows").glob("*.y*ml"))]
        for path in workflows:
            doc = yaml.safe_load(path.read_text()) or {}
            self.assertNotRegex(yaml.safe_dump(doc.get("env") or {}), model, f"{path.name}: a model credential in the workflow's env")
            for name, job in (doc.get("jobs") or {}).items():
                where = f"{path.name}: job {name}"
                self.assertNotRegex(yaml.safe_dump(job.get("env") or {}), model, f"{where}: a model credential in the job's env")
                for step in job.get("steps", []):
                    if not isinstance(step, dict) or not model.search(yaml.safe_dump(step)):
                        continue
                    run = str(step.get("run", ""))
                    self.assertNotRegex(run, installs, f"{where}: a step holding a model credential installs something")
                    self.assertNotIn("GITHUB_ENV", run, f"{where}: a step holding a model credential writes the env later steps read")
                    self.assertNotRegex(run, r"(?m)^\s*(?:sh|bash)\s+(?!\.github/scripts/claude-credential\.sh\b)\S", f"{where}: a step holding a model credential runs a script")

    def test_the_credential_picker_installs_nothing_and_asks_with_the_locked_cli(self):
        # The picker runs where the tokens are: it may run only the CLI a secret-free step installed from the lockfile.
        picker = (ROOT / ".github/scripts/claude-credential.sh").read_text()
        code = "\n".join(line for line in picker.splitlines() if not line.lstrip().startswith("#"))
        self.assertNotRegex(code, r"\b(?:npm|pnpm|npx|yarn|pip)\s+(?:install|i|add|exec|dlx)\b")
        for workflow in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            text = workflow.read_text()
            steps = text.split("      - ")[1:]
            for n, step in enumerate(steps):
                if "claude-credential.sh" not in step:
                    continue
                self.assertIn("CLAUDE_BIN: ${{ github.workspace }}/.github/tools/claude-cli/node_modules/.bin/claude", step, str(workflow))
                before = steps[:n]
                installs = [s for s in before if "npm ci --silent --ignore-scripts --prefix .github/tools/claude-cli" in s]
                self.assertTrue(installs, f"{workflow}: the locked CLI is installed before the picker runs")
                self.assertTrue(all("secrets." not in s for s in installs), f"{workflow}: the CLI is installed with no secret")

    def test_sdk_polish_dependency_scripts_cannot_read_write_credentials(self):
        workflow = (ROOT / ".github/workflows/sdk-polish.yml").read_text()
        polish = workflow.split("  polish:\n", 1)[1]
        self.assertIn("permissions: {}", workflow)
        self.assertIn("persist-credentials: false", polish)
        self.assertNotRegex(polish, r"(?m)^\s*run:.*\b(?:npm|pnpm|pip|cargo)\s+(?:ci|install|add)\b")
        self.assertNotIn("npm ci", polish)
        self.assertIn("Do not install dependencies", polish)

    def test_release_secret_jobs_use_immutable_action_refs(self):
        from importlib.util import spec_from_file_location

        path = ROOT / ".github/scripts/check-pinned-actions.py"
        spec = spec_from_file_location("check_pinned_actions", path)
        module = __import__("importlib.util").util.module_from_spec(spec)
        spec.loader.exec_module(module)
        workflows = [
            *sorted((ROOT / ".github/workflows").glob("*.y*ml")),
            *sorted((ROOT / "unbrowse-browser/.github/workflows").glob("*.y*ml")),
        ]
        errors = [error for workflow in workflows for error in module.check(workflow)]
        self.assertEqual(errors, [])

    def test_targets_quorum_has_a_protected_co_signing_path(self):
        source = (ROOT / "unbrowse-node/app/src/update.rs").read_text()
        match = re.search(r"const OFFLINE_TARGETS_KEYS: &\[&str\] = &\[(.*?)\];", source, re.S)
        self.assertIsNotNone(match)
        # The built-in target role is 2-of-N whenever populated; keep both release paths wired even before keys exist.
        if re.findall(r'"([0-9a-f]{64})"', match.group(1)):
            self.assertIn("threshold: 2", source[source.index("fn builtin_root_with_roles_and_roles"):])
        for path, signer, packer in (
            (ROOT / ".github/workflows/updates.yml", "sign", "package"),
            (ROOT / ".github/workflows/release.yml", "sign-updates", "pack-updates"),
        ):
            workflow = yaml.safe_load(path.read_text())
            jobs = workflow["jobs"]
            cosign_name = "cosign" if signer == "sign" else "cosign-updates"
            self.assertIn(cosign_name, jobs, str(path))
            cosign = jobs[cosign_name]
            self.assertEqual(cosign.get("environment"), "targets-cosign", str(path))
            self.assertIn("needs." + signer + ".outputs.cosign_required == 'true'", cosign.get("if", ""), str(path))
            body = str(cosign)
            self.assertIn("UNBROWSE_TARGETS_KEY_2", body, str(path))
            self.assertIn("updates.mjs co-sign", body, str(path))
            self.assertIn("actions/download-artifact@", body, str(path))
            self.assertIn("actions/upload-artifact@", body, str(path))
            checkout = next(step for step in cosign["steps"] if str(step.get("uses", "")).startswith("actions/checkout@"))
            self.assertEqual(checkout.get("with", {}).get("ref"), "main", f"{path}:{cosign_name} uses the trusted verifier ref")
            consumer = jobs[packer]
            self.assertIn(cosign_name, consumer.get("needs", []), str(path))
            self.assertIn("updates-cosigned", str(consumer), str(path))

    def test_claude_secret_workflows_require_trusted_authors(self):
        claude = (ROOT / ".github/workflows/claude.yml").read_text()
        review = (ROOT / ".github/workflows/claude-review.yml").read_text()
        self.assertIn("github.ref == 'refs/heads/staging'", claude)
        self.assertNotIn("pull_request_review_comment:", claude)
        self.assertNotIn("issue_comment:", claude)
        self.assertIn("branches: [staging]", review)
        self.assertIn("persist-credentials: false", claude)
        self.assertIn("persist-credentials: false", review)

    def test_qa_does_not_run_secret_bearing_pr_code_from_untrusted_forks(self):
        qa = (ROOT / ".github/workflows/qa.yml").read_text()
        self.assertNotIn("github.event.pull_request.author_association", qa)
        self.assertIn("github.ref == 'refs/heads/staging'", qa)

    def test_release_builds_do_not_restore_shared_caches(self):
        release_workflows = [
            ROOT / ".github/workflows/release.yml",
            ROOT / "unbrowse-browser/.github/workflows/release.yml",
        ]
        for path in release_workflows:
            text = path.read_text()
            self.assertNotIn("actions/cache/restore", text, str(path))
            self.assertNotIn("Swatinem/rust-cache", text, str(path))

    def test_a_job_with_an_agent_saves_its_cache_before_anything_but_the_build_runs(self):
        # An agent given Write, or a node reading the web, can change the work tree. A cache saved at the job's end (as
        # rust-cache and actions/cache do in their post step) would carry that into the next run, which builds and runs
        # it beside the model secrets. So such a job restores and saves explicitly, and saves right after its build.
        workflows = [*sorted((ROOT / ".github/workflows").glob("*.y*ml")), *sorted((ROOT / "unbrowse-browser/.github/workflows").glob("*.y*ml"))]
        checked = 0
        for path in workflows:
            for name, job in (yaml.safe_load(path.read_text()).get("jobs") or {}).items():
                steps = [s for s in job.get("steps", []) if isinstance(s, dict)]
                if not any(str(s.get("uses", "")).startswith("anthropics/claude-code-action@") for s in steps):
                    continue
                where = f"{path.name}: job {name}"
                for step in steps:
                    uses = str(step.get("uses", ""))
                    self.assertFalse(uses.startswith("Swatinem/rust-cache@"), f"{where} saves its build folders after the agent ran")
                    self.assertFalse(uses.startswith("actions/cache@"), f"{where} saves a cache after the agent ran")
                for i, step in enumerate(steps):
                    if not str(step.get("uses", "")).startswith("actions/cache/save@"):
                        continue
                    checked += 1
                    self.assertGreater(i, 0, where)
                    self.assertIn("cargo build", str(steps[i - 1].get("run", "")), f"{where} saves a cache other than right after its build")
        self.assertGreaterEqual(checked, 2, "bank and QA save their build caches")

    def test_bank_does_not_run_secret_bearing_agent_on_pull_request_code(self):
        bank = (ROOT / ".github/workflows/bank.yml").read_text()
        self.assertNotIn("pull_request:", bank)
        self.assertIn("if: github.ref == 'refs/heads/staging'", bank)


if __name__ == "__main__":
    unittest.main()
