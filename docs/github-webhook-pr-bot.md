# GitHub Webhook PR Bot

Read when: setting up the GitHub webhook receiver for PR agent review and repair.

## Endpoint

Production webhook URL:

- `https://beta-api.unbrowse.ai/v1/webhooks/github`

## GitHub webhook config

Create a repository webhook with:

- content type: `application/json`
- secret: same value as backend secret `GITHUB_WEBHOOK_SECRET`
- events: `Pull requests`, `Check suites`

`ping` is also handled automatically by the same endpoint.

## Backend secrets

Required:

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_PR_BOT_TOKEN`

Optional:

- `GITHUB_PR_BOT_LABEL`
- `GITHUB_WEBHOOK_ALLOWED_REPOS`
- `GITHUB_PR_AGENT_WORKFLOW`
- `GITHUB_PR_AGENT_WORKFLOW_REF`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Defaults:

- label: `codex:auto-maintain`
- workflow: `pr-agent.yml`
- workflow ref: `main`

## Behavior

For internal, non-draft, labeled PRs:

- pull request activity dispatches a self-hosted GitHub Actions workflow
- failed `check_suite` events on the current PR head dispatch the workflow again
- the workflow runs Codex on the PR branch, reviews comments/checks, can merge base into head, fix code, run tests/evals, and push repairs back to the PR branch

The webhook receiver no longer blindly enables auto-merge. It hands off to the agent workflow.

## Repo prerequisites

- `GITHUB_PR_BOT_TOKEN` must have repo/workflow write access sufficient to dispatch workflows
- the repository must contain `.github/workflows/pr-agent.yml` on the configured workflow ref
- the repository must have an available self-hosted GitHub Actions runner with `codex`, `bun`, `node`, and `gh`

## Telegram

The backend worker cron runs every 6 hours UTC and flushes queued PR alerts to Telegram when both Telegram secrets are set.
