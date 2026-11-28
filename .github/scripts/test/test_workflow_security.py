from pathlib import Path
import re
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]
PR_AGENT_CHECKS = ROOT / ".github/workflows/pr-agent-checks.yml"
# Claude Ship's agents, run on OpenCode and GitHub Actions without the Claude organization (docs/CI-AGENTS.md). The two
# that hold a model credential work on a pull request's files, so each has its own envelope and its own rules below.
REVIEW = ROOT / ".github/workflows/opencode-review.yml"
STEWARD = ROOT / ".github/workflows/opencode-steward.yml"
APPROVALS = ROOT / ".github/workflows/opencode-approvals.yml"
OPENCODE_CONFIG = ROOT / ".github/opencode/opencode.json"
# The pull request check with no credential (UNB-235): every pull request, draft or ready, with nothing to steal.
PR_CHECK = ROOT / ".github/workflows/pr-check.yml"
# Every job of pr-agent-checks.yml but its verdict opens its `if` with this: a draft or a fork's pull request is false.
PR_GUARD = "github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository"


def _triggers(doc):
    # PyYAML reads the bare key `on` as the boolean True.
    on = (doc or {}).get("on", (doc or {}).get(True)) or {}
    if isinstance(on, str):
        return {on: None}
    if isinstance(on, list):
        return {name: None for name in on}
    return dict(on)


def _evaluate(expr, draft, same_repo):
    """A job's `if` for one pull request, every other operand at its most permissive (true).

    GitHub's && binds tighter than ||, as Python's and/or do; status functions (always(), success()) are true.
    """
    expr = expr.strip()
    if expr.startswith("${{") and expr.endswith("}}"):
        expr = expr[3:-2]
    expr = expr.replace("github.event.pull_request.draft", repr(draft))
    expr = expr.replace("github.event.pull_request.head.repo.full_name == github.repository", repr(same_repo))
    expr = re.sub(r"\b(?:always|success|failure|cancelled)\(\)", "True", expr)
    expr = re.sub(r"\b(?:needs|steps|inputs|github|env|vars)\.[\w.-]+\s*(?:==|!=)\s*'[^']*'", "True", expr)
    expr = re.sub(r"\b(?:needs|steps|inputs|github|env|vars)\.[\w.-]+", "True", expr)
    expr = expr.replace("&&", " and ").replace("||", " or ").replace("!=", " __ne__ ")
    expr = re.sub(r"!(?!=)", " not ", expr).replace(" __ne__ ", " != ").replace("false", "False").replace("true", "True")
    if not re.fullmatch(r"[\sA-Za-z()=!']*", expr) or re.search(r"[A-Za-z_]+", re.sub(r"\b(?:and|or|not|True|False)\b", "", expr)):
        raise AssertionError(f"an `if` this test can't read: {expr!r}")
    return eval(expr, {"__builtins__": {}})  # noqa: S307: only and/or/not/True/False/==/!= and brackets reach here


# UNB-166: agent jobs may run on Lewis's own machines (the local runner pool: [self-hosted, linux, x64] podman slots on
# the Steam Machine, [self-hosted, macOS, ARM64, lewis-mbp] on his Mac). A pool job's `if` opens with this, so a fork's
# pull request never reaches one; on a push or a dispatch it is true.
SAME_REPO_GUARD = "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)"
# A job reaches the pool only through its workflow's `place` job (.github/scripts/place_jobs.py), which hands out a free
# local runner and otherwise a Blacksmith machine. Such a job can be on the pool, so it is held to every pool rule.
# A placed job reads its place job's output, by name, or (a matrix of shards, UNB-235) by a name made of a prefix and
# each matrix row's value: `needs.place.outputs[format('qa{0}', matrix.shard)]` reads qa1, qa2, ...
PLACED = re.compile(r"^\$\{\{ fromJSON\(needs\.place\.outputs(?:\.(\w+)|\[format\('(\w+)\{0\}', matrix\.(\w+)\)\])\) \}\}$")
# Hosted machines: Sengi's, Blacksmith's and GitHub's. Every other job (build, unit, lint, coverage) runs on one of these.
HOSTED = re.compile(r"^(sengi-(basic|premium)-[248]-ubuntu-2404|blacksmith-\d+vcpu-(ubuntu-\d{4}(-arm)?|macos-[\w.]+|windows-\d{4})|ubuntu-[\d.]+(-arm)?|macos-[\d.]+|windows-\d{4})$")
# Environments holding the keys that sign what users install, or publish it.
SHIP_ENVIRONMENTS = {"release", "targets-cosign"}
# Workflows whose builds users install (release.yml: the programs, the installers and the Mac app; updates.yml: the
# metadata nodes update from; installers-device-test.yml: installs the installers on fresh machines before a release),
# held to the release rules: a fresh GitHub-hosted machine for every job, never the pool, and no shared cache.
SHIPS_TO_USERS = ("release.yml", "updates.yml", "installers-device-test.yml")


def _runners(job):
    """Every runs-on a job can take: its own, or each matrix row's `runner` when runs-on reads matrix.runner."""
    runs_on = job.get("runs-on")
    if isinstance(runs_on, str) and "matrix.runner" in runs_on:
        rows = ((job.get("strategy") or {}).get("matrix") or {}).get("include") or []
        return [row.get("runner") for row in rows]
    return [runs_on]


def _placed_outputs(job):
    """The place job outputs a placed job reads: one name, or one per matrix row. None when it isn't placed."""
    m = PLACED.match(str(job.get("runs-on")))
    if not m:
        return None
    if m.group(1):
        return [m.group(1)]
    rows = ((job.get("strategy") or {}).get("matrix") or {}).get("include") or []
    return [f"{m.group(2)}{row.get(m.group(3))}" for row in rows] or [None]


def _on_the_pool(runner):
    """A job that can run on one of Lewis's machines: placed there, or naming a self-hosted label."""
    return bool(PLACED.match(str(runner))) or "self-hosted" in (runner if isinstance(runner, list) else [str(runner)]) or "self-hosted" in str(runner)


def _opens_with(cond, guard):
    """`cond` is `guard`, or `guard && (one bracketed term)`: nothing can be or-ed past the guard."""
    cond = cond.strip()
    if cond.startswith("${{") and cond.endswith("}}"):
        cond = cond[3:-2].strip()
    if not cond.startswith(guard):
        return False
    rest = cond[len(guard):]
    if not rest:
        return True
    if not (rest.startswith(" && (") and rest.endswith(")")):
        return False
    depth = 0
    for i, ch in enumerate(rest[4:]):
        depth += {"(": 1, ")": -1}.get(ch, 0)
        if depth == 0 and i != len(rest) - 5:
            return False
    return True


def _runs_for_a_fork(cond):
    """A job's `if` on a fork's ready pull request, every other operand at its most permissive."""
    cond = cond.replace("github.event_name != 'pull_request'", "false").replace("github.event_name == 'pull_request'", "true")
    cond = re.sub(r"\b(?:startsWith|endsWith|contains)\([^()]*\)", "true", cond)
    return _evaluate(cond, False, False)


def _credential_free_problems(doc, text):
    """What lets pr-check.yml's code reach anything worth taking: a secret, an environment, a write permission, a saved
    cache, a talk with GitHub, a ref other than the merge commit, a read of the pull request's head, one of Lewis's
    machines. Empty when there is none."""
    problems = []
    if re.search(r"\$\{\{\s*secrets\.", text):
        problems.append("names a secret")
    if re.search(r"pull_request\.head|refs/pull/|github\.head_ref", text):
        problems.append("reads the pull request's head")
    if doc.get("permissions") != {}:
        problems.append("workflow permissions are not {}")
    for name, job in (doc.get("jobs") or {}).items():
        if "environment" in job:
            problems.append(f"{name}: names an environment")
        if "secrets" in job:
            problems.append(f"{name}: passes secrets")
        permissions = job.get("permissions", {})
        if not isinstance(permissions, dict) or set(permissions.items()) - {("contents", "read")}:
            problems.append(f"{name}: permissions beyond contents: read")
        for runner in _runners(job):
            if _on_the_pool(runner) or not HOSTED.match(str(runner)):
                problems.append(f"{name}: runs on {runner}, not a hosted machine")
        if re.search(r"\bgh\s+(?:pr|api|issue)\b|pull-requests:", str(job)):
            problems.append(f"{name}: talks to GitHub")
        for step in job.get("steps", []):
            uses = str(step.get("uses", ""))
            if uses.startswith(("actions/cache/save@", "actions/cache@")):
                problems.append(f"{name}: saves a cache")
            if uses.startswith("actions/checkout@") and "ref" in (step.get("with") or {}):
                problems.append(f"{name}: checks out a ref other than the merge commit")
            if uses.startswith("actions/checkout@") and (step.get("with") or {}).get("persist-credentials") is not False:
                problems.append(f"{name}: keeps the token on disk")
    return problems


BY_HAND = re.compile(r"^\s*github\.event_name\s*==\s*'workflow_dispatch'\s*(&&|$)")


def _by_hand_on_the_pool(job, runner):
    """A job only a person's dispatch runs, naming the pool's own labels: nothing automatic ever waits on it."""
    return isinstance(runner, list) and "self-hosted" in runner and bool(BY_HAND.match(str(job.get("if", ""))))


OPENCODE_INSTALL = re.compile(r"npm ci (?:--silent )?--ignore-scripts --prefix \.github/tools/opencode\b")
CLAUDE_INSTALL = re.compile(r"npm ci (?:--silent )?--ignore-scripts --prefix \.github/tools/claude-cli\b")


def _opencode_agent_problems(text, kind):
    """What lets an OpenCode agent's model key near anything the pull request controls, or lets its fix past a check.
    `kind` is `review` or `steward`; each rule is a line, and the workflow as it should be has none."""
    doc = yaml.safe_load(text) or {}
    problems = []
    env = f"opencode-{kind}"
    allowed = {"review": {"PR signal (no credential)"},
               "steward": {"CI", "Coverage", "PR check (no credential)", "Code review"}}[kind]
    triggers = _triggers(doc)
    if not set(triggers) <= {"workflow_run", "workflow_dispatch"}:
        problems.append(f"starts from {sorted(triggers)}, not workflow_run and a person's dispatch")
    run = triggers.get("workflow_run") or {}
    if not set(run.get("workflows") or []) <= allowed or run.get("types") != ["completed"]:
        problems.append("follows a workflow or event it shouldn't")
    if doc.get("permissions") != {}:
        problems.append("the workflow grants permissions to every job")
    guard = "github.event.workflow_run.head_repository.full_name == github.repository"
    for name, job in (doc.get("jobs") or {}).items():
        cond = " ".join(str(job.get("if", "")).split())
        if guard not in cond:
            problems.append(f"job {name}: its `if` doesn't hold it to a pull request from this repository")
        if any(k in yaml.safe_dump(job) for k in ("secrets.OPENCODE_API_KEY", "secrets.OPENCODE_CHATGPT_ACCESS_TOKEN", "secrets.OPENCODE_CHATGPT_CREDENTIAL_KEY", "secrets.CLAUDE_CODE_OAUTH_TOKEN", "secrets.ANTHROPIC_API_KEY")) \
                and job.get("environment") != env:
            problems.append(f"job {name}: the model key outside the {env} environment")
        steps = [s for s in (job.get("steps") or []) if isinstance(s, dict)]
        for st in steps:
            if not str(st.get("uses", "")).startswith("actions/checkout@"):
                continue
            w = st.get("with") or {}
            if str(w.get("persist-credentials")).lower() != "false":
                problems.append(f"job {name}: a checkout keeps its token")
            if w.get("path") is None and w.get("ref") not in (None, "staging"):
                problems.append(f"job {name}: the work tree at the root isn't staging's")
            if w.get("path") is not None and (w.get("path") != "pr" or "outputs.head" not in str(w.get("ref"))):
                problems.append(f"job {name}: the pull request is checked out somewhere other than pr/, or at another commit")
        for st in steps:
            run_text = str(st.get("run", ""))
            where = str(st.get("working-directory", ""))
            if re.search(r"(?:python3?|sh|bash|node)\s+(?:-\w+\s+)*(?:\.\./|\./)?pr/", run_text) or (
                    where == "pr" and re.search(r"(?m)^\s*(?:python3?|sh|bash|node|npm|npx|make|cargo|zig)\b", run_text)):
                problems.append(f"job {name}: step {st.get('name', st.get('id', '?'))} runs the pull request's code")
            if re.search(r"git\s+push\b[^\n]*(?:\s--force|\s-f\b|\s\+)", run_text):
                problems.append(f"job {name}: a push that can overwrite the author's")
            if "opencode run" in run_text:
                if f"--agent {kind}" not in run_text:
                    problems.append(f"job {name}: the agent isn't `{kind}`")
                if "--standalone" not in run_text:
                    problems.append(f"job {name}: the agent isn't in standalone mode")
                step_env = st.get("env") or {}
                if "runner.temp" not in str(step_env.get("HOME", "")):
                    problems.append(f"job {name}: the agent runs in the runner's own home")
                if any("github.token" in str(v) for v in step_env.values()):
                    problems.append(f"job {name}: the agent holds a GitHub token")
            through_switch = "agent_cli.py" in run_text and "--which-model" not in run_text
            if through_switch:
                # The agent through agent_cli.py (Claude Code, or opencode on the switch): its own home, no GitHub
                # token, no shell, no web, and edits only where its job needs them.
                step_env = st.get("env") or {}
                if "runner.temp" not in str(step_env.get("HOME", "")):
                    problems.append(f"job {name}: the agent runs in the runner's own home")
                if any("github.token" in str(v) for v in step_env.values()):
                    problems.append(f"job {name}: the agent holds a GitHub token")
                flags = dict(re.findall(r'--(tools|allowedTools|disallowedTools)\s+"?([^"\s]+)"?', run_text))
                tools = set(flags.get("tools", "").split(","))
                allowed = [x for x in flags.get("allowedTools", "").split(",") if x]
                denied = set(flags.get("disallowedTools", "").split(","))
                if not {"Bash", "WebFetch", "WebSearch"} <= denied or "Bash" in tools:
                    problems.append(f"job {name}: the agent may run a shell or fetch the web")
                edits = [x for x in allowed if x.split("(")[0] in ("Edit", "Write")]
                if kind == "review" and (tools & {"Edit", "Write", "NotebookEdit"} or edits):
                    problems.append(f"job {name}: the reviewer can edit")
                if kind == "steward" and (not edits or any(not re.fullmatch(r"(Edit|Write)\(pr/\*\*\)", x) for x in edits)):
                    problems.append(f"job {name}: the steward may edit outside pr/")
            keys = ("secrets.OPENCODE_API_KEY", "secrets.OPENCODE_CHATGPT_ACCESS_TOKEN", "secrets.OPENCODE_CHATGPT_CREDENTIAL_KEY", "secrets.CLAUDE_CODE_OAUTH_TOKEN", "secrets.ANTHROPIC_API_KEY")
            if any(k in str(st.get("env") or {}) for k in keys) and "opencode run" not in run_text \
                    and not through_switch and str(st.get("id")) not in ("auth", "credential"):
                problems.append(f"job {name}: step {st.get('name', st.get('id', '?'))} holds the model key")
        names = [str(s.get("id") or s.get("name", "")) for s in steps]
        pushes = [i for i, s in enumerate(steps) if "git push" in str(s.get("run", ""))]
        if pushes and ("guard" not in names[: pushes[0]] or "steps.guard.outputs.ok == 'true'" not in str(steps[pushes[0]].get("if", ""))):
            problems.append(f"job {name}: it pushes without the guard's yes")
        if kind == "review" and pushes:
            problems.append(f"job {name}: the reviewer can push")
    return problems


class WorkflowSecurityTest(unittest.TestCase):
    def test_no_job_with_id_token_or_a_secret_executes_a_file_from_an_artifact(self):
        workflows = [
            *sorted((ROOT / ".github/workflows").glob("*.y*ml")),
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
        workflows = [*sorted((ROOT / ".github/workflows").glob("*.y*ml"))]
        for workflow in workflows:
            text = workflow.read_text()
            # No workflow takes pull_request_target, which runs with secrets on a fork's pull request.
            self.assertNotIn("pull_request_target", _triggers(yaml.safe_load(text)), str(workflow))
            if not re.search(r"\$\{\{\s*secrets\.[A-Za-z0-9_]+", text):
                continue
            # The one pull request workflow that holds a secret is held to its own, stricter rules below
            # (test_pr_agent_checks_*): a ready pull request into staging from a branch of this repository (UNB-248).
            if workflow == PR_AGENT_CHECKS:
                continue
            # Secret-bearing automation is post-merge/manual on staging, or an OpenCode agent after a pull request's run
            # (held to `_opencode_agent_problems`); reject PR triggers and explicit PR checkouts.
            self.assertNotRegex(text, r"(?m)^\s*pull_request(?:_[a-z_]+)?:", str(workflow))
            self.assertNotRegex(text, r"(?i)pull_request\.head|refs/pull/|github\.event\.pull_request\.head")
        qa = (ROOT / ".github/workflows/qa.yml").read_text()
        # A push to staging or main (trusted code someone with write access put there), nightly, and by hand: never a
        # pull request, and no other branch's push.
        self.assertIn("schedule:", qa)
        self.assertRegex(qa, r"(?m)^  push:\n    branches: \[staging, main\]\n")
        self.assertNotIn("pull_request", qa.split("\njobs:")[0].split("\non:")[1])
        self.assertNotRegex(qa, r"(?m)^\s*pull_request(?:_target)?:")
        self.assertIn("cancel-in-progress: true", qa)
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
        ]
        secret_names = ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENCODE_API_KEY", "OPENCODE_CHATGPT_ACCESS_TOKEN", "OPENCODE_CHATGPT_CREDENTIAL_KEY")
        for workflow in workflows:
            for step in workflow.read_text().split("      - ")[1:]:
                if not any(f"secrets.{name}" in step for name in secret_names):
                    continue
                self.assertNotRegex(step, r"(?m)^\s*run:.*(?:test-banks/|\.github/qa/|npm install)", str(workflow))
                self.assertNotIn("npm install", step, str(workflow))
        qa = (ROOT / ".github/workflows/qa.yml").read_text()
        self.assertIn("name: Run tool choice sessions", qa)
        model_step = qa.split("      - name: Run tool choice sessions\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("secrets.OPENCODE_CHATGPT_CREDENTIAL_KEY", model_step)
        self.assertNotIn("python3", model_step)
        self.assertNotIn("test-banks/", model_step)

    def test_no_model_credential_is_in_the_environment_of_an_install(self):
        # A package's install scripts, or the package manager itself, read the environment they run in. A model
        # credential sits only on the steps that use it, never on a workflow's or job's env (which every step reads),
        # never handed on through GITHUB_ENV, and never on a step that installs anything.
        installs = re.compile(
            r"\b(?:npm\s+(?:install|i|ci|exec|update)|npx|pnpm\s+(?:install|i|add|dlx)|yarn(?:\s+(?:install|add|dlx))?|bunx?(?:\s+(?:install|add|x))?|pip3?\s+install|python3?\s+-m\s+pip|pipx|uvx?|cargo\s+install|brew\s+install|apt(?:-get)?\s+install|curl|wget)\b"
        )
        model = re.compile(r"secrets\s*\.\s*(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN\w*|OPENCODE_API_KEY|OPENCODE_CHATGPT_ACCESS_TOKEN|OPENCODE_CHATGPT_CREDENTIAL_KEY)", re.IGNORECASE)
        workflows = [*sorted((ROOT / ".github/workflows").glob("*.y*ml"))]
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
                installs = [s for s in before if CLAUDE_INSTALL.search(s)]
                self.assertTrue(installs, f"{workflow}: the locked CLI is installed before the picker runs")
                self.assertTrue(all("secrets." not in s for s in installs), f"{workflow}: the CLI is installed with no secret")

    def test_every_locked_cli_install_links_the_native_binary_and_runs_it(self):
        # With lifecycle scripts off, the CLI's bin is a stub that answers every ask with "claude native binary not
        # installed": three nights of QA and every agent job failed on it, read as refused tokens (UNB-235). The CLI's
        # own install.cjs, from the locked package, links the binary in; `--version` proves it runs before any secret.
        for workflow in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            for step in workflow.read_text().split("      - ")[1:]:
                if not CLAUDE_INSTALL.search(step):
                    continue
                self.assertIn("node .github/tools/claude-cli/node_modules/@anthropic-ai/claude-code/install.cjs", step, str(workflow))
                self.assertIn(".github/tools/claude-cli/node_modules/.bin/claude --version", step, str(workflow))
                self.assertNotIn("secrets.", step, str(workflow))

    def test_sdk_polish_dependency_scripts_cannot_read_write_credentials(self):
        workflow = (ROOT / ".github/workflows/sdk-polish.yml").read_text()
        polish = workflow.split("  polish:\n", 1)[1]
        self.assertIn("permissions: {}", workflow)
        self.assertIn("persist-credentials: false", polish)
        before, model = polish.split("      - name: Draft the hand-written SDK changes\n", 1)
        self.assertNotIn("secrets.", before)
        for line in before.splitlines():
            if "npm ci" in line:
                self.assertIn("npm ci --ignore-scripts --prefix .github/tools/", line)
        self.assertNotRegex(model, r"(?m)^\s*run:.*\b(?:npm|pnpm|pip|cargo)\s+(?:ci|install|add)\b")
        self.assertNotIn("npm ci", model)
        self.assertIn("Do not install dependencies", model)

    def test_release_secret_jobs_use_immutable_action_refs(self):
        from importlib.util import spec_from_file_location

        path = ROOT / ".github/scripts/check-pinned-actions.py"
        spec = spec_from_file_location("check_pinned_actions", path)
        module = __import__("importlib.util").util.module_from_spec(spec)
        spec.loader.exec_module(module)
        workflows = [
            *sorted((ROOT / ".github/workflows").glob("*.y*ml")),
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

    def test_no_workflow_answers_a_comment_with_a_model_credential(self):
        # claude.yml ("Claude Code", by hand on staging) is gone (UNB-166): 506 runs, every one skipped, none by hand.
        # No workflow holding a model credential answers a comment, an issue or a review. The one workflow that answers
        # a review is Claude Approvals, which is a check and names no secret at all.
        for path in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            text = path.read_text()
            triggers = set(_triggers(yaml.safe_load(text)))
            self.assertFalse({"issue_comment", "issues", "pull_request_review_comment"} & triggers, path.name)
            if "pull_request_review" in triggers:
                self.assertEqual(path, APPROVALS, f"{path.name} answers a review")
                self.assertNotRegex(text, r"\$\{\{\s*secrets\.", f"{path.name} answers a review and names a secret")
            if "secrets." in text:
                self.assertNotIn("pull_request_review", triggers, f"{path.name} holds a secret and answers a review")

    def test_the_steward_keeps_its_credential_off_the_pull_requests_code(self):
        self.assertEqual(_opencode_agent_problems(STEWARD.read_text(), "steward"), [])
        self.assertEqual(_opencode_agent_problems(REVIEW.read_text(), "review"), [])
        # Each environment is named by its own workflow and no other.
        for workflow, env in ((STEWARD, "opencode-steward"), (REVIEW, "opencode-review")):
            for other in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
                if other == workflow:
                    continue
                for name, job in (yaml.safe_load(other.read_text()).get("jobs") or {}).items():
                    named = (job.get("environment") or {}).get("name") if isinstance(job.get("environment"), dict) else job.get("environment")
                    self.assertNotIn(env, str(named or ""), f"{other.name}: job {name}")

    def test_the_opencode_checker_can_fail(self):
        guard = "github.event.workflow_run.head_repository.full_name == github.repository"
        broken = {
            "steward": (STEWARD, {
                "a pull_request trigger": ("on:\n  workflow_run:", "on:\n  pull_request:\n  workflow_run:"),
                "a fork let in": (guard, "true"),
                "the key outside its environment": ("    environment: opencode-steward\n", ""),
                "the root checked out at the pull request": ("          ref: staging\n", "          ref: ${{ steps.who.outputs.head_sha }}\n"),
                "the pull request somewhere else": ("          path: pr\n", "          path: prsrc\n"),
                "a shell for the agent": ("--tools Read,Grep,Glob,Edit,Write ", "--tools Read,Grep,Glob,Edit,Write,Bash "),
                "edits outside pr/": ("Edit(pr/**)", "Edit(**)"),
                "the web for the agent": ("--disallowedTools \"Bash,NotebookEdit,WebFetch,", "--disallowedTools \"Bash,NotebookEdit,"),
                "the agent in the runner's home": ("          HOME: ${{ runner.temp }}/opencode-home\n", ""),
                "the agent holding a GitHub token": ("          HOME: ${{ runner.temp }}/opencode-home\n",
                                                     "          HOME: ${{ runner.temp }}/opencode-home\n          GH_TOKEN: ${{ github.token }}\n"),
                "a forced push": ('git push "https', 'git push --force "https'),
                "a push without the guard": ("steps.plan.outputs.act == 'true' && steps.guard.outputs.ok == 'true'", "steps.plan.outputs.act == 'true'"),
                "a token kept": ("          path: pr\n          persist-credentials: false", "          path: pr\n          persist-credentials: true"),
            }),
            "review": (REVIEW, {
                "a pull_request trigger": ("on:\n  workflow_run:", "on:\n  pull_request:\n  workflow_run:"),
                "a fork let in": (guard, "true"),
                "the key outside its environment": ("    environment: opencode-review\n", ""),
                "the root checked out at the pull request": ("          ref: staging\n", "          ref: ${{ steps.plan.outputs.head }}\n"),
                "the pull request somewhere else": ("          path: pr\n", "          path: prsrc\n"),
                "an editing reviewer": ("--tools Read,Grep,Glob ", "--tools Read,Grep,Glob,Edit "),
                "a shell for the reviewer": ("--disallowedTools \"Bash,", "--disallowedTools \""),
                "the Claude key in another step": ("        run: |\n          python3 -I .github/scripts/code_review.py",
                                                   "          T: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n        run: |\n          python3 -I .github/scripts/code_review.py"),
                "the agent in the runner's home": ("          HOME: ${{ runner.temp }}/opencode-home\n", ""),
                "the agent holding a GitHub token": ("          HOME: ${{ runner.temp }}/opencode-home\n",
                                                     "          HOME: ${{ runner.temp }}/opencode-home\n          GH_TOKEN: ${{ github.token }}\n"),
            }),
        }
        for kind, (workflow, cases) in broken.items():
            text = workflow.read_text()
            for what, (find, replace) in cases.items():
                with self.subTest(f"{kind}: {what}"):
                    self.assertIn(find, text, f"{what}: the breakage didn't apply")
                    self.assertTrue(_opencode_agent_problems(text.replace(find, replace, 1), kind), f"{what} went unnoticed")

    def test_the_opencode_agents_can_only_do_what_their_job_needs(self):
        config = yaml.safe_load(OPENCODE_CONFIG.read_text())
        self.assertEqual(config.get("mcp", {}).get("servers"), {})
        rules = config["permissions"]
        self.assertEqual(rules[0], {"action": "*", "resource": "*", "effect": "deny"})
        for allow in ({"action": "read", "resource": "*", "effect": "allow"},
                      {"action": "glob", "resource": "*", "effect": "allow"},
                      {"action": "grep", "resource": "*", "effect": "allow"}):
            self.assertIn(allow, rules)
        # The reviewer edits nothing; the steward edits pr/ and nothing else.
        self.assertNotIn("permissions", config["agents"]["review"])
        edits = [r for r in config["agents"]["steward"]["permissions"] if r["action"] == "edit"]
        self.assertTrue(edits)
        self.assertTrue(all(r["resource"].startswith("pr/") and r["effect"] == "allow" for r in edits), edits)
        # Neither leaves the checkout, and a .env is refused whatever else allows it.
        self.assertIn({"action": "external_directory", "resource": "*", "effect": "deny"}, rules)
        self.assertIn({"action": "read", "resource": "*.env", "effect": "deny"}, rules)
        review = (ROOT / ".github/opencode/agents/review.md").read_text()
        steward = (ROOT / ".github/opencode/agents/steward.md").read_text()
        self.assertIn('"findings"', review)
        self.assertIn("only files under", steward)
        self.assertIn(".autofix/summary.md", steward)

    def test_opencode_is_installed_from_its_lockfile_and_proven_before_a_key(self):
        # As the Claude CLI is: the lockfile's own install script links the platform binary (--ignore-scripts leaves a
        # stub that answers every ask with "postinstall script was not run"), and --version proves it before any secret.
        for workflow in (REVIEW, STEWARD):
            text = workflow.read_text()
            install = [s for s in text.split("      - ") if OPENCODE_INSTALL.search(s)]
            self.assertEqual(len(install), 1, workflow.name)
            self.assertIn("node .github/tools/opencode/node_modules/@opencode/cli/postinstall.mjs", install[0])
            self.assertIn(".github/tools/opencode/node_modules/.bin/opencode --version", install[0])
            self.assertNotIn("secrets.", install[0])
        lock = (ROOT / ".github/tools/opencode/package-lock.json").read_text()
        self.assertIn('"@opencode/cli"', lock)

    def test_qa_does_not_run_secret_bearing_pr_code_from_untrusted_forks(self):
        qa = (ROOT / ".github/workflows/qa.yml").read_text()
        self.assertNotIn("github.event.pull_request.author_association", qa)
        self.assertIn("github.ref == 'refs/heads/staging'", qa)

    def test_shipped_window_builds_target_a_baseline_processor(self):
        # Zig builds for the build machine's own processor unless told otherwise: the Windows window from one runner died
        # with an illegal instruction (0xc000001d) on 3 of 9 fresh runners (21 Nov 2026). Every build users install says
        # -Dcpu=baseline.
        found = 0
        for name in SHIPS_TO_USERS:
            path = ROOT / ".github/workflows" / name
            for line in path.read_text().splitlines():
                if re.search(r"\bzig build\b", line) and "test" not in line:
                    found += 1
                    self.assertIn("-Dcpu=baseline", line, f"{name}: {line.strip()}")
        self.assertGreaterEqual(found, 2, "the shipped window builds (release.yml's Mac app and window) were found")

    def test_release_builds_do_not_restore_shared_caches(self):
        release_workflows = [
            ROOT / ".github/workflows/release.yml",
        ]
        for path in release_workflows:
            text = path.read_text()
            self.assertNotIn("actions/cache/restore", text, str(path))
            self.assertNotIn("Swatinem/rust-cache", text, str(path))

    def test_a_job_with_an_agent_saves_its_cache_before_anything_but_the_build_runs(self):
        # An agent given Write, or a node reading the web, can change the work tree. A cache saved at the job's end (as
        # rust-cache and actions/cache do in their post step) would carry that into the next run, which builds and runs
        # it beside the model secrets. So such a job restores and saves explicitly, and saves right after its build.
        # Since the node is built once per run (UNB-166), the agent jobs unpack that build and save no cache at all; a
        # job that builds for itself again is held to the save-right-after-the-build rule.
        workflows = [*sorted((ROOT / ".github/workflows").glob("*.y*ml"))]
        agents = 0
        for path in workflows:
            for name, job in (yaml.safe_load(path.read_text()).get("jobs") or {}).items():
                steps = [s for s in job.get("steps", []) if isinstance(s, dict)]
                # An agent runs through the action or the pinned CLI (Claude QA moved to the CLI: the action takes no push).
                if not any(str(s.get("uses", "")).startswith("anthropics/claude-code-action@") or ".github/tools/claude-cli/node_modules/.bin/claude\" -p" in str(s.get("run", "")) or "agent_cli.py -p" in str(s.get("run", "")) or "agent_cli.py\" -p" in str(s.get("run", "")) or "\"$cli\" -p" in str(s.get("run", "")) for s in steps):
                    continue
                where = f"{path.name}: job {name}"
                agents += 1
                for step in steps:
                    uses = str(step.get("uses", ""))
                    self.assertFalse(uses.startswith("Swatinem/rust-cache@"), f"{where} saves its build folders after the agent ran")
                    self.assertFalse(uses.startswith("actions/cache@"), f"{where} saves a cache after the agent ran")
                for i, step in enumerate(steps):
                    if not str(step.get("uses", "")).startswith("actions/cache/save@"):
                        continue
                    self.assertGreater(i, 0, where)
                    self.assertIn("cargo build", str(steps[i - 1].get("run", "")), f"{where} saves a cache other than right after its build")
        self.assertGreaterEqual(agents, 5, "the agent jobs were found: bank's writes, QA's and the pull request's QA and skill triggers")

    def test_bank_does_not_run_secret_bearing_agent_on_pull_request_code(self):
        bank = (ROOT / ".github/workflows/bank.yml").read_text()
        self.assertNotIn("pull_request:", bank)
        self.assertIn("if: github.ref == 'refs/heads/staging'", bank)

    def test_a_job_that_installs_a_pinned_tool_checks_out_its_lockfile(self):
        # `npm ci --prefix <dir>` with <dir> left out of a sparse checkout finds no lockfile and stops the job, which in
        # the release's npm job stopped the first real publish (UNB-158, run 44144861312).
        for path in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            for name, job in (yaml.safe_load(path.read_text()).get("jobs") or {}).items():
                steps = [s for s in job.get("steps", []) if isinstance(s, dict)]
                sparse = [str((s.get("with") or {}).get("sparse-checkout", "")) for s in steps
                          if str(s.get("uses", "")).startswith("actions/checkout@") and not (s.get("with") or {}).get("path")]
                if not sparse or not all(sparse):
                    continue
                listed = {line.strip().rstrip("/") for text in sparse for line in text.splitlines() if line.strip()}
                for step in steps:
                    for prefix in re.findall(r"npm ci\b[^\n]*?--prefix\s+(\S+)", str(step.get("run", ""))):
                        self.assertTrue(
                            any(prefix == p or prefix.startswith(p + "/") for p in listed),
                            f"{path.name}:{name} runs npm ci --prefix {prefix} but its sparse checkout leaves it out",
                        )

    # pr-agent-checks.yml (UNB-248): the agent QA and the gate slice on a pull request into staging, before it merges.
    # Lewis, 20 Nov 2026: on a ready pull request from a branch of this repository; a fork or a draft never gets the
    # Claude credential. Each rule below fails when that stops being true.

    def _pr_doc(self):
        return yaml.safe_load(PR_AGENT_CHECKS.read_text())

    def test_pr_agent_checks_start_only_on_a_pull_request_into_staging(self):
        doc = self._pr_doc()
        triggers = _triggers(doc)
        self.assertEqual(set(triggers), {"pull_request"}, "no other event (no push, dispatch, schedule or comment) starts it")
        pr = triggers["pull_request"] or {}
        self.assertEqual(pr.get("branches"), ["staging"])
        types = set(pr.get("types") or [])
        self.assertTrue(types, "an explicit list of activity types")
        self.assertLessEqual(types, {"opened", "reopened", "synchronize", "ready_for_review"})
        self.assertIn("ready_for_review", types)
        self.assertIn("synchronize", types)
        self.assertEqual(doc.get("permissions"), {})
        self.assertTrue(doc["concurrency"]["cancel-in-progress"])
        self.assertIn("github.event.pull_request.number", doc["concurrency"]["group"])

    def test_pr_agent_checks_no_fork_or_draft_reaches_a_job_but_the_verdict(self):
        jobs = self._pr_doc()["jobs"]
        self.assertIn("verdict", jobs)
        for name, job in jobs.items():
            if name == "verdict":
                continue
            cond = str(job.get("if", ""))
            # The guard opens the `if`, and anything after it is one bracketed term joined by &&: nothing can be or-ed
            # past it.
            self.assertTrue(cond.startswith(PR_GUARD), f"job {name}: its `if` opens with the fork and draft guard")
            rest = cond[len(PR_GUARD):]
            if rest:
                self.assertTrue(rest.startswith(" && (") and rest.endswith(")"), f"job {name}: {rest!r}")
                depth = 0
                for i, ch in enumerate(rest[4:]):
                    depth += {"(": 1, ")": -1}.get(ch, 0)
                    self.assertTrue(depth > 0 or i == len(rest) - 5, f"job {name}: the bracket closes before the end")
            for draft, same_repo in ((True, True), (False, False), (True, False)):
                self.assertFalse(_evaluate(cond, draft, same_repo), f"job {name} runs for draft={draft} same_repo={same_repo}")
            self.assertTrue(_evaluate(cond, False, True), f"job {name} never runs on a ready same-repo pull request")

    def test_pr_agent_checks_the_credential_is_only_in_its_environment(self):
        jobs = self._pr_doc()["jobs"]
        with_secret = set()
        for name, job in jobs.items():
            body = str(job)
            permissions = job.get("permissions", {})
            self.assertIsInstance(permissions, dict, f"job {name}: permissions listed, never write-all")
            self.assertNotIn("write", {str(v).lower() for v in permissions.values()}, f"job {name} holds a write permission")
            self.assertNotRegex(body, r"\bgh\s+(?:pr|api|issue)\b", f"job {name} talks to GitHub")
            if re.search(r"\$\{\{\s*secrets\.", body):
                with_secret.add(name)
                self.assertEqual(job.get("environment"), "pr-agent-checks", f"job {name} holds a secret outside the environment")
            for step in job.get("steps", []):
                if str(step.get("uses", "")).startswith("actions/checkout@"):
                    self.assertNotIn("ref", step.get("with") or {}, f"job {name} checks out a ref other than the merge commit")
                self.assertFalse(str(step.get("uses", "")).startswith(("actions/cache/save@", "actions/cache@")), f"job {name} saves a cache")
        self.assertEqual(with_secret, {"qa", "skills", "slice"}, "the model's jobs, and no other, hold the credential")
        # This test runs on the pull request's own workflows before any job holding the credential may start.
        security = jobs["security"]
        self.assertNotIn("secrets", str(security))
        self.assertNotIn("environment", security)
        self.assertIn("python3 -I .github/scripts/test/test_workflow_security.py", str(security["steps"]))
        for name in with_secret:
            needs = jobs[name].get("needs", [])
            self.assertIn("security", [needs] if isinstance(needs, str) else needs, f"job {name} starts before the security test passed")
        self.assertNotIn("secrets", str(jobs["build"]))
        self.assertNotIn("environment", jobs["build"])
        # The pull request's head is read for one thing only: which repository it came from.
        text = PR_AGENT_CHECKS.read_text()
        self.assertEqual(set(re.findall(r"pull_request\.head\.[\w.]+", text)), {"pull_request.head.repo.full_name"})
        self.assertNotRegex(text, r"refs/pull/|github\.head_ref")
        # No other workflow may use the environment, so only these guarded runs can reach what it holds.
        for workflow in [*sorted((ROOT / ".github/workflows").glob("*.y*ml"))]:
            if workflow == PR_AGENT_CHECKS:
                continue
            for name, job in (yaml.safe_load(workflow.read_text()).get("jobs") or {}).items():
                env = job.get("environment")
                env = env.get("name") if isinstance(env, dict) else env
                self.assertNotIn("pr-agent-checks", str(env or ""), f"{workflow.name}: job {name}")

    def test_pr_agent_checks_run_only_the_build_this_run_made(self):
        jobs = self._pr_doc()["jobs"]
        build = jobs["build"]
        self.assertIn("digest", build["outputs"])
        self.assertIn("shasum -a 256", str(build))
        for name, job in jobs.items():
            steps = job.get("steps", [])
            for i, step in enumerate(steps):
                if not str(step.get("uses", "")).startswith("actions/download-artifact@") or (step.get("with") or {}).get("name") != "pr-node-build":
                    continue
                self.assertIn("build", job.get("needs", []), f"job {name}")
                unpack = steps[i + 1]
                self.assertEqual(unpack.get("env", {}).get("DIGEST"), "${{ needs.build.outputs.digest }}", f"job {name}")
                run = str(unpack.get("run", ""))
                self.assertLess(run.index("shasum -a 256 -c"), run.index("tar -xf"), f"job {name} unpacks before checking the digest")
                for later in steps[:i]:
                    self.assertNotIn("node-build", str(later), f"job {name} touches the build before checking it")

    def test_pr_agent_checks_verdict_is_red_for_a_fork_a_draft_or_any_job_that_did_not_pass(self):
        # A job skipped by its `if` counts as passed to a required check, so the requirement is the verdict: it runs on
        # every event, holds nothing, and passes only when every other job ran and passed.
        jobs = self._pr_doc()["jobs"]
        verdict = jobs["verdict"]
        self.assertEqual(verdict["name"], "PR agent checks")
        self.assertEqual(verdict["if"], "always()")
        self.assertEqual(verdict.get("permissions"), {})
        self.assertNotIn("secrets", str(verdict))
        self.assertNotIn("environment", verdict)
        others = sorted(name for name in jobs if name != "verdict")
        self.assertEqual(sorted(verdict["needs"]), others)
        run = "\n".join(str(s.get("run", "")) for s in verdict["steps"])
        self.assertIn('if [ "$DRAFT" != false ]; then', run)
        self.assertIn('if [ "$SAME_REPO" != true ]; then', run)
        self.assertIn(f'length == {len(others)} and (to_entries | all(.value.result == "success"))', run)
        self.assertIn(f'length == {len(others)} and .scope.result == "success" and .security.result == "success"', run)
        env = verdict["steps"][0]["env"]
        self.assertEqual(env["DRAFT"], "${{ github.event.pull_request.draft }}")
        self.assertEqual(env["SAME_REPO"], "${{ github.event.pull_request.head.repo.full_name == github.repository }}")
        self.assertEqual(env["QA_SCOPE"], "${{ needs.scope.outputs.qa }}")
        self.assertEqual(env["RESULTS"], "${{ toJSON(needs) }}")

    def test_pr_agent_checks_a_missing_credential_fails_rather_than_passes(self):
        jobs = self._pr_doc()["jobs"]
        for name in ("qa", "skills"):
            steps = jobs[name]["steps"]
            auth = next(step for step in steps if step.get("name") == "Check the subscription OAuth grant")
            self.assertEqual(auth["run"], "python3 -I .github/scripts/agent_cli.py --check-subscription")
            self.assertNotIn("if", auth)
            self.assertFalse(auth.get("continue-on-error"))
            self.assertEqual(steps.index(auth), 1, f"{name}: check the grant immediately after checkout")

    def test_no_fork_pull_request_reaches_a_local_pool_slot(self):
        # UNB-166. The repository is private, forking is off and fork pull requests run no workflow (repo settings,
        # 21 Nov 2026); this is the layer the workflows themselves hold.
        wf = ROOT / ".github/workflows"
        checked = 0
        for path in sorted(wf.glob("*.y*ml")):
            doc = yaml.safe_load(path.read_text())
            triggers = _triggers(doc)
            self.assertNotIn("pull_request_target", triggers, path.name)
            if "pull_request" not in triggers:
                continue
            for name, job in (doc.get("jobs") or {}).items():
                runners = _runners(job)
                if not any(_on_the_pool(r) for r in runners):
                    continue
                checked += 1
                where = f"{path.name}:{name}"
                if not PLACED.match(str(job.get("runs-on"))):
                    self.assertNotIn("${{", str(job.get("runs-on")).replace("${{ matrix.runner }}", ""), f"{where}: a runs-on expression this test can't read")
                cond = str(job.get("if", ""))
                self.assertTrue(_opens_with(cond, SAME_REPO_GUARD) or _opens_with(cond, PR_GUARD), f"{where}: its `if` opens with the same-repository guard")
                self.assertFalse(_runs_for_a_fork(cond), f"{where} runs for a fork's pull request")
        # Three since pr-agent-checks.yml's copy of the MCP check went (22 Nov 2026): qa, skills and slice.
        self.assertGreaterEqual(checked, 3, "the pull-request workflows' pool jobs were found")

    def test_no_job_waits_on_a_local_runner_without_a_fallback(self):
        # A job named for a local runner waits for ever when that runner is asleep, offline or busy, and the run never
        # ends: 0 of 43 pull requests into staging went green on the pool (20 to 21 Nov 2026, UNB-166). Every job runs
        # on a hosted machine, or is placed by its workflow's `place` job, which falls back to Blacksmith.
        # One exception: a job only a person starts by hand (its `if` opens with the workflow_dispatch guard) may
        # name the pool's own labels. No pull request, push or deploy waits on it, so it holds nothing up, and a
        # benchmark that must read from a home connection is what it is for (UNB-260, Lewis, 22 Nov 2026: the top
        # 1,000 sites "on Lewis's own CI runners ... never on paid Blacksmith machines for the site reads").
        placed, by_hand = 0, 0
        for path in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            if path.name in SHIPS_TO_USERS:
                continue
            doc = yaml.safe_load(path.read_text())
            jobs = doc.get("jobs") or {}
            outputs = ((jobs.get("place") or {}).get("outputs")) or {}
            for name, job in jobs.items():
                where = f"{path.name}:{name}"
                for runner in _runners(job):
                    if runner is None and "uses" in job:
                        continue
                    names = _placed_outputs(job) if PLACED.match(str(runner)) else None
                    if names:
                        placed += 1
                        for out in names:
                            self.assertIn(out, outputs, f"{where}: its workflow's place job has no output for it")
                        needs = job.get("needs") or []
                        self.assertIn("place", [needs] if isinstance(needs, str) else needs, f"{where}: needs place")
                    elif _by_hand_on_the_pool(job, runner):
                        by_hand += 1
                    else:
                        self.assertRegex(str(runner), HOSTED, f"{where} runs on {runner}, which has no fallback")
            if "place" in jobs:
                place = jobs["place"]
                self.assertRegex(str(place.get("runs-on")), HOSTED, f"{path.name}: the place job runs on a hosted machine")
                self.assertEqual(place.get("permissions"), {"actions": "read", "contents": "read"}, f"{path.name}: place reads only")
        self.assertGreaterEqual(placed, 11, "the placed agent jobs were found")

    def test_only_a_job_started_by_hand_names_the_pool_without_a_fallback(self):
        bank = yaml.safe_load((ROOT / ".github/workflows/bank.yml").read_text())["jobs"]
        self.assertTrue(_by_hand_on_the_pool(bank["top-sites"], bank["top-sites"]["runs-on"]))
        for cond in ("always()", "github.ref == 'refs/heads/staging'", "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
                     "github.event_name != 'workflow_dispatch'"):
            self.assertFalse(_by_hand_on_the_pool({"if": cond}, ["self-hosted", "Linux", "X64", "steam-machine"]), cond)
        self.assertFalse(_by_hand_on_the_pool({"if": "github.event_name == 'workflow_dispatch'"}, "blacksmith-2vcpu-ubuntu-2404"))

    def test_every_agent_job_is_placed(self):
        # The agent and simulation jobs (a model, a simulated user, the task bank) are the ones that may use Lewis's
        # runners; build, unit, lint and coverage run on Blacksmith, side by side.
        agents = {
            "pr-agent-checks.yml": {"qa", "skills", "slice"},
            "qa.yml": {"check", "qa", "skills"},
            "bank.yml": {"hard-sites", "writes"},
            "gate-bank.yml": {"bank"},
            "opencode-review.yml": {"review"},
            "opencode-steward.yml": {"steward"},
            "sdk-polish.yml": {"polish"},
        }
        for name, ids in agents.items():
            jobs = yaml.safe_load((ROOT / ".github/workflows" / name).read_text())["jobs"]
            got = {j for j, job in jobs.items() if PLACED.match(str(job.get("runs-on")))}
            self.assertEqual(got, ids, name)

    def test_the_fork_guard_check_can_fail(self):
        # Positive controls for the test above.
        self.assertFalse(_opens_with("${{ !cancelled() }}", SAME_REPO_GUARD))
        self.assertFalse(_opens_with(SAME_REPO_GUARD + " || always()", SAME_REPO_GUARD))
        self.assertFalse(_opens_with(SAME_REPO_GUARD + " && (always()) || always()", SAME_REPO_GUARD))
        self.assertTrue(_opens_with("${{ " + SAME_REPO_GUARD + " && (!cancelled() && needs.scope.outputs.engine == 'true') }}", SAME_REPO_GUARD))
        self.assertTrue(_runs_for_a_fork("${{ always() }}"))
        self.assertTrue(_runs_for_a_fork("startsWith(github.base_ref, 'release/')"))
        self.assertFalse(_runs_for_a_fork(SAME_REPO_GUARD))
        self.assertTrue(_runs_for_a_fork("github.event_name == 'pull_request'"))
        self.assertTrue(_on_the_pool(["self-hosted", "linux", "x64"]))
        self.assertFalse(_on_the_pool("ubuntu-24.04"))
        self.assertTrue(_on_the_pool("${{ fromJSON(needs.place.outputs.qa) }}"))
        self.assertFalse(_on_the_pool("blacksmith-6vcpu-macos-latest"))
        self.assertNotRegex("${{ vars.MAC_RUNNER && fromJSON(vars.MAC_RUNNER) || 'blacksmith-6vcpu-macos-latest' }}", HOSTED)
        self.assertNotRegex("self-hosted", HOSTED)
        self.assertRegex("blacksmith-4vcpu-ubuntu-2204", HOSTED)
        self.assertRegex("ubuntu-22.04-arm", HOSTED)

    def test_nothing_built_signed_or_published_for_users_runs_on_the_local_pool(self):
        # UNB-166: the pool runs pull-request code and shares a cargo cache across jobs, so a release build, a signing
        # key or a publish never runs there; those jobs take a fresh GitHub-hosted machine.
        wf = ROOT / ".github/workflows"
        for path in sorted(wf.glob("*.y*ml")):
            doc = yaml.safe_load(path.read_text())
            for name, job in (doc.get("jobs") or {}).items():
                env = job.get("environment")
                env = env.get("name") if isinstance(env, dict) else env
                if path.name in SHIPS_TO_USERS or env in SHIP_ENVIRONMENTS:
                    for runner in _runners(job):
                        if runner is None and "uses" in job:
                            continue
                        self.assertFalse(_on_the_pool(runner), f"{path.name}:{name} runs on {runner}")

    # pr-check.yml (UNB-235): the checks that need no model, on every pull request into staging or main, draft or ready.
    # Its point is that it holds nothing: each rule below fails when it starts to.

    def test_pr_check_runs_on_every_pull_request_into_staging_or_main_draft_or_ready(self):
        doc = yaml.safe_load(PR_CHECK.read_text())
        triggers = _triggers(doc)
        self.assertEqual(set(triggers), {"pull_request"}, "no push, dispatch, schedule or comment starts it")
        pr = triggers["pull_request"] or {}
        self.assertEqual(pr.get("branches"), ["staging", "main"])
        self.assertEqual(set(pr.get("types") or []), {"opened", "reopened", "synchronize", "ready_for_review"})
        self.assertTrue(doc["concurrency"]["cancel-in-progress"])
        self.assertIn("github.event.pull_request.number", doc["concurrency"]["group"])
        jobs = doc["jobs"]
        self.assertEqual(set(jobs), {"scope", "check", "coverage", "verdict"})
        # A draft is the point: no job waits for ready, so nothing is held back for want of a credential.
        for name in ("scope", "coverage"):
            self.assertNotIn("if", jobs[name], f"job {name} is skipped for some pull requests")
        self.assertIn("needs.scope.result != 'success' || needs.scope.outputs.qa == 'true'", jobs["check"]["if"])
        self.assertNotIn("draft", jobs["check"]["if"])
        self.assertEqual(jobs["verdict"]["if"], "always()")
        self.assertEqual(jobs["verdict"]["needs"], ["scope", "check", "coverage"])
        run = jobs["verdict"]["steps"][-1]["run"]
        self.assertIn("length == 3", run)
        self.assertIn('all(.value.result == "success")', run)
        self.assertIn('.scope.result == "success" and .coverage.result == "success"', run)
        self.assertIn("PR_CHECK_OK", run.splitlines()[-1], "the marker prints last, after both results were read")

    def test_pr_check_holds_no_credential(self):
        text = PR_CHECK.read_text()
        self.assertEqual(_credential_free_problems(yaml.safe_load(text), text), [])

    def test_the_credential_free_checker_can_fail(self):
        text = PR_CHECK.read_text()
        planted = {
            "a secret": text.replace("SHA: ${{ github.sha }}", "SHA: ${{ secrets.ANTHROPIC_API_KEY }}"),
            "an environment": text.replace("    name: Journey coverage\n", "    name: Journey coverage\n    environment: pr-agent-checks\n", 1),
            "a write permission": text.replace("permissions:\n      contents: read", "permissions:\n      contents: write", 1),
            "a saved cache": text.replace("actions/cache/restore@", "actions/cache@", 1),
            "Lewis's machine": text.replace("runs-on: sengi-basic-2-ubuntu-2404", "runs-on: [self-hosted, linux, x64]", 1),
            "the head": text.replace("DRAFT: ${{ github.event.pull_request.draft }}", "DRAFT: ${{ github.event.pull_request.head.ref }}"),
            "a kept token": text.replace("persist-credentials: false", "persist-credentials: true", 1),
        }
        for what, bad in planted.items():
            self.assertNotEqual(bad, text, f"the {what} plant changed nothing")
            self.assertTrue(_credential_free_problems(yaml.safe_load(bad), bad), f"{what} went unnoticed")

    def test_linux_x64_runs_on_sengi_and_only_what_sengi_cannot_run_stays_on_blacksmith(self):
        # Lewis, 27 Nov 2026: "switch from blacksmith to sengi on unb core n public". Sengi runs Ubuntu 24.04 on x64
        # only, so a Blacksmith label is left only for macOS, Windows and arm64; the Linux fallback for an agent job
        # the pool cannot take is Sengi too. The pool is told apart by its runners' names (steam-machine-N): Sengi's
        # names are random, so the old "self-hosted and not blacksmith-" test would have read a Sengi job as the pool.
        import importlib.util
        spec = importlib.util.spec_from_file_location("place_jobs", ROOT / ".github/scripts/place_jobs.py")
        place_jobs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(place_jobs)
        self.assertTrue(place_jobs.FALLBACK["linux"].startswith("sengi-"), place_jobs.FALLBACK)
        linux_on_blacksmith, name_tests, sengi = [], [], 0
        for path in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            text = path.read_text()
            if "startsWith(runner.name, 'blacksmith-')" in text:
                name_tests.append(path.name)
            for name, job in (yaml.safe_load(text).get("jobs") or {}).items():
                for runner in _runners(job):
                    label = str(runner)
                    sengi += label.startswith("sengi-")
                    if label.startswith("blacksmith-") and not re.search(r"macos|windows|-arm$", label):
                        linux_on_blacksmith.append(f"{path.name}: {name}: {label}")
        self.assertEqual(linux_on_blacksmith, [], "a Linux x64 job is still on Blacksmith")
        self.assertEqual(name_tests, [], "a step tells the pool apart by a Blacksmith runner name")
        self.assertGreater(sengi, 0)

    def test_pr_check_runs_the_same_steps_as_the_checks_it_stands_for(self):
        # Copies drift; these can't. The MCP check builds as pr-agent-checks.yml's `build` does, step for step, and the
        # coverage is qa.yml's `coverage`. pr-agent-checks.yml no longer runs the MCP check a second time (22 Nov 2026):
        # this is the only copy a pull request runs, and qa.yml skips a push only when it passed (passed_on_pr.py).
        mine = yaml.safe_load(PR_CHECK.read_text())["jobs"]
        agent = yaml.safe_load(PR_AGENT_CHECKS.read_text())["jobs"]
        qa = yaml.safe_load((ROOT / ".github/workflows/qa.yml").read_text())["jobs"]
        steps = mine["check"]["steps"]
        names = [s.get("name") for s in steps]
        split = names.index("Name the browser this job built")
        build = agent["build"]["steps"]
        built = [s.get("name") for s in build].index("Build the window") + 1
        self.assertEqual(steps[:split], build[:built])
        self.assertNotIn("check", agent, "the MCP check runs once, in pr-check.yml")
        self.assertEqual(mine["coverage"]["steps"], qa["coverage"]["steps"])
        self.assertEqual(mine["coverage"]["runs-on"], qa["coverage"]["runs-on"])

    def test_the_guard_evaluator_can_fail(self):
        # Positive controls: an `if` that lets a fork or a draft through is caught.
        self.assertTrue(_evaluate(PR_GUARD + " || always()", True, False))
        self.assertTrue(_evaluate("always()", True, False))
        self.assertTrue(_evaluate("github.event.pull_request.draft == false || github.event.pull_request.head.repo.full_name == github.repository", True, True))
        self.assertFalse(_evaluate(PR_GUARD + " && (always() && needs.qa.outputs.ran == 'true')", False, False))
        with self.assertRaises(AssertionError):
            _evaluate("fromJSON(github.event.x)", False, True)

    def test_the_dashboard_key_is_held_by_one_step_and_never_reaches_a_pull_request(self):
        # UNB-250: runs post their numbers to the test dashboard with DASHBOARD_INGEST_KEY. One step holds it; it runs
        # this repository's collector from a trusted checkout, installs nothing, and posts no pull request's run.
        wf = ROOT / ".github/workflows"
        holders = sorted(p.name for p in wf.glob("*.y*ml") if "secrets.DASHBOARD_INGEST_KEY" in p.read_text())
        self.assertEqual(holders, ["dashboard-post.yml", "dashboard.yml", "gate-bank.yml", "qa.yml"])
        post = yaml.safe_load((wf / "dashboard-post.yml").read_text())
        self.assertEqual(list(_triggers(post)), ["workflow_call"])
        self.assertEqual(list(post["jobs"]), ["post"])
        job = post["jobs"]["post"]
        self.assertEqual(job["permissions"], {"actions": "read", "contents": "read"})
        checkouts = [s for s in job["steps"] if str(s.get("uses", "")).startswith("actions/checkout@")]
        self.assertEqual(len(checkouts), 1)
        self.assertNotIn("ref", checkouts[0].get("with") or {})
        self.assertIs((checkouts[0].get("with") or {}).get("persist-credentials"), False)
        keyed = [s for s in job["steps"] if "DASHBOARD_INGEST_KEY" in str(s)]
        self.assertEqual(len(keyed), 1)
        self.assertRegex(keyed[0]["run"], r"node unbrowse-dashboard/collect/collect\.mjs run ")
        self.assertNotRegex(keyed[0]["run"], r"\b(?:npm|npx|bun|pip|yarn|pnpm|curl|wget)\b")
        for line in keyed[0]["run"].splitlines():
            if "collect.mjs" in line:
                self.assertIn("--soft", line, "a dashboard that is down must not turn a run red")
        feed = yaml.safe_load((wf / "dashboard.yml").read_text())
        on = _triggers(feed)
        self.assertEqual(list(on), ["workflow_run"])
        self.assertEqual(on["workflow_run"]["branches"], ["staging", "main"])
        cond = feed["jobs"]["post"]["if"]
        self.assertNotIn("||", cond)
        self.assertIn("github.event.workflow_run.event != 'pull_request'", cond)
        self.assertIn("github.event.workflow_run.head_repository.full_name == github.repository", cond)
        for name in ("qa.yml", "gate-bank.yml"):
            doc = yaml.safe_load((wf / name).read_text())
            self.assertFalse(any(t.startswith("pull_request") for t in _triggers(doc)), name)
            self.assertEqual(doc["jobs"]["dashboard"]["uses"], "./.github/workflows/dashboard-post.yml", name)
            self.assertEqual(doc["jobs"]["dashboard"]["permissions"], {"actions": "read", "contents": "read"}, name)


if __name__ == "__main__":
    unittest.main()
