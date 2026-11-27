# CI agents and ChatGPT authentication

Every model-backed CI job runs OpenCode with GPT-6.2 Sol, High reasoning and Ultrafast. The workflows set
`AGENT_AUTH: chatgpt`. The selected ChatGPT account needs Ultrafast access. An unavailable or invalid OAuth grant
stops the model invocation. CI also runs deterministic checks that need no model credential.

| Job | What it does |
|---|---|
| [Code Review](../.github/workflows/opencode-review.yml) | Posts inline findings and the `Code review` check |
| [PR Steward](../.github/workflows/opencode-steward.yml) | Proposes fixes for failed checks and review findings |
| [Claude Approvals](../.github/workflows/opencode-approvals.yml) | Reads the repository's approval policy and reports who still needs to approve |

The reviewer can read the checkout. The steward can also edit `pr/**`. Both are denied shell and web access.
A credential-free [PR signal](../.github/workflows/pr-signal.yml) starts Code Review through `workflow_run`.
See `test_workflow_security.py` for the rules governing credential use in pull request checks.

## ChatGPT subscription for CI

OpenCode sends model requests directly to OpenAI with a delegated **Sign in with ChatGPT** access token. The
wrapper checks plan permission, audience and expiry. It keeps the bearer out of the inherited MCP environment.
[OpenAI’s ChatGPT plan inference docs](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

CI obtains a current grant for each OpenCode invocation from `OPENCODE_CHATGPT_CREDENTIAL_URL` using the step’s
`OPENCODE_CHATGPT_CREDENTIAL_KEY`. The Cloudflare Worker in `.github/ci-oauth` only handles credentials. One durable
session stores and rotates the refresh credential. It issues access tokens with a one-hour lifetime and starts
renewing with 20 minutes remaining. If an exchange fails, it can still hand out the current grant until expiry.
Long bank jobs can start new invocations after earlier grants expire. A step-scoped
`OPENCODE_CHATGPT_ACCESS_TOKEN` overrides the credential endpoint for a one-hour canary.

To provision the credential Worker, use the staging config and set `CI_ACCESS_KEY` and `OPENAI_OAUTH_SEED` as
Worker secrets. The seed contains `access`, `refresh`, `clientID`, `expiresAt` in milliseconds, and a unique
`generation` from a dedicated OpenCode ChatGPT login. Use a new generation when reauthorizing a revoked login.
Only the Worker holds the refresh credential. CI’s key can fetch a short-lived grant from `/v1/chatgpt-access`.

## When each one runs

**Code review.** After `pr-signal` completes: so on open, reopen, ready for review, every push, and a label change.
`OPENCODE_REVIEW` decides whether it actually reviews:

- `push` (default) — every push that changes the branch. `no-review` label: not this pull request.
- `manual` — only a dispatch, or a pull request carrying the `review` label (Claude Ship's `@claude review always`).
- `off` — only a dispatch.

A draft and a fork's pull request get no automatic review. A dispatch reviews a draft, which is Claude Ship's
`@claude review` on a draft:

```sh
gh workflow run opencode-review.yml --ref staging -f pr=12
```

It reads the diff against staging and the pull request's tree, and reports only findings it can defend. It never
approves, blocks or merges. Its check ends `neutral` always, with the table and the same last line Claude Code Review
writes (`<!-- bughunter-severity: {"nit":0,"normal":1,"pre_existing":0} -->`), so a script that reads Claude's can read
this one.

**PR Steward.** After CI, Coverage, the credential-free PR check, or Code review completes on a pull request from a
branch of this repository. `OPENCODE_STEWARD` decides:

- `on` (default) — a failed check, or a review with an Important finding.
- `manual` — only a person's dispatch: `gh workflow run opencode-steward.yml -f pr=12` (Claude Ship's `@claude steward`).
- `off` — never, not even a dispatch.

It refuses a draft, a fork, a pull request not into staging, one labelled `no-autofix` or `no-steward`, one whose head
moved since the run, one whose last commit is the steward's own, and one that already has two of its commits. It fixes
only what failed here and not on staging. `autofix.py guard` refuses a fix that changes what only a person changes
(workflows, the agent guide, the ledger, coverage exclusions, fixtures, generated files, lockfiles), switches a check
off, or takes assertions out of a test. A fix that passes is one commit, pushed without force, with an `Autofix-Run:`
trailer, a comment saying what it did, and CI and Coverage started on it.

**Claude Approvals.** On every pull request event, every review, and after Code review. No model is asked, so it is
cheap and exact: it reads `.claude/approvals.yml` from the default branch, matches the changed files, takes the
strictest verdict, and counts the approvals that count. `observe` reports; `enforce` fails the check while a seat is
empty, so making `Claude Approvals` a required check is what blocks a merge.

## What the agents may touch

The envelope is the one `pr-autofix.yml` established, kept line for line in `_opencode_agent_problems`
(`test_workflow_security.py`):

- **Only staging's code runs.** The work tree at the root is `staging`: the workflow, the scripts, the CLI, the agent's
  prompt. The pull request is checked out at `pr/` as data. Nothing under `pr/` is executed.
- **The agent's config is ours.** `.github/opencode/` is copied into a home of the runner's own, so the pull request's
  `opencode.json`, `.opencode/` and `AGENTS.md` configure nothing; the rules the agent reads are staging's `AGENTS.md`.
- **Review may only read.** `.github/opencode/opencode.json` starts from `* deny`, allows `read`, `glob`, `grep`, and
  denies `edit`, `shell`, `webfetch`, `websearch`, `subagent`, `skill`, `execute`, `.env` files, and everything outside
  the checkout. A deny is a deny: `--auto` does not override it.
- **Steward may edit only `pr/`.** Reading is the same; `edit` is allowed for `pr/*` and `pr/**` and nowhere else.
- **The key is on one step.** The step that runs the CLI. The install, the guard, the posting and the push hold no
  model key, and the agent holds no GitHub token.
- **A push is the guard's.** `autofix.py guard` runs before the commit, and the push step only runs on its yes; it is
  never forced, so a newer push by the author wins.
- **A conflict is a person's.** The steward reports that the branch conflicts with staging and does not merge it.

## Cost

`opencode run --format json` reports each step's cost; `code_review.py` adds them into the run's summary. A review of a
50-line Rust change measured $0.12 on `opencode/claude-sonnet-5-5` (2026-11-24, before Claude models were refused
under opencode; the cost on the default model is not measured yet). A review is one session, about 20
steps; a steward run about 40.

To spend less, set `OPENCODE_MODEL` to a cheaper model. To stop a runaway, turn the variable `off`; a workflow cannot
carry a per-run dollar cap, so the variable and the job timeout are the caps. Claude Ship's per-pull-request spend caps
do not exist here.

## What is not built

Said plainly, so nobody assumes it:

- **Comment commands.** `@claude review`, `@claude review always`, `@claude steward` and `@claude approve` need an
  `issue_comment` trigger, which this repository refuses every workflow. The equivalents are the `review` and
  `no-steward` labels and `gh workflow run`.
- **A review that reuses an earlier result** when a push changes no line ("no new changes"), and thread auto-resolution
  when a later review finds an issue fixed. Every push reviews the whole change again.
- **A policy checker for everything.** `approvals.py` evaluates paths, `verdict` (`claude`, `seats`), `if` on the
  facts and `claude/code_review`, and `override`. It refuses by name: `locals`/`use`, `reuse`, `findings`, nested
  policy files, teams, `max_age`, and classifiers other than `claude/code_review`. A refused policy is reported as
  **Cannot evaluate** and never passes.
- **An approval that GitHub counts as a person's.** `claude: approves` posts an approving review, but a bot's approval
  may not satisfy a branch rule that requires a human review. The `Claude Approvals` check is the gate to require.
- **A steward that resolves conflicts, approves, or merges.** It fixes, commits and comments. An authorized author uses the
  guarded GitHub CLI after the checks in AGENTS.md pass.

## Running one by hand

```sh
gh workflow run opencode-review.yml --ref staging -f pr=12
gh workflow run opencode-steward.yml --ref staging -f pr=12

# what Approvals would say, without posting a check or a comment
python3 -m pip install pyyaml
GH_TOKEN=$(gh auth token) python3 .github/scripts/approvals.py \
  --repo unbrowse-ai/unbrowse-core --pr 12 --policy .claude/approvals.yml --out /tmp/approvals --dry-run
```

The tests that hold this page: `.github/scripts/test/test_workflow_security.py`
(`test_the_steward_keeps_its_credential_off_the_pull_requests_code`, `test_the_opencode_checker_can_fail`,
`test_the_opencode_agents_can_only_do_what_their_job_needs`,
`test_opencode_is_installed_from_its_lockfile_and_proven_before_a_key`,
`test_no_workflow_answers_a_comment_with_a_model_credential`), `test_code_review.py`, `test_approvals.py`, and
`test_autofix.py` (`Steer`).
