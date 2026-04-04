# GitHub Webhook PR Bot

Read when: setting up the GitHub webhook receiver for PR maintenance.

## Endpoint

Production webhook URL:

- `https://beta-api.unbrowse.ai/v1/webhooks/github`

## GitHub webhook config

Create a repository webhook with:

- content type: `application/json`
- secret: same value as backend secret `GITHUB_WEBHOOK_SECRET`
- events: `Pull requests`

`ping` is also handled automatically by the same endpoint.

## Backend secrets

Required:

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_PR_BOT_TOKEN`

Optional:

- `GITHUB_PR_BOT_LABEL`
- `GITHUB_PR_BOT_MERGE_METHOD`
- `GITHUB_WEBHOOK_ALLOWED_REPOS`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Defaults:

- label: `codex:auto-maintain`
- merge method: `SQUASH`

## Behavior

For internal, non-draft, labeled PRs:

- if behind base: request branch update
- if clean/blocked/has-hooks/unstable: enable GitHub auto-merge
- if dirty: leave a sticky conflict comment and queue a Telegram digest item

This bot does not invent merge-conflict resolutions. If you want generated-file conflict handling, add a narrow resolver on top.

## Repo prerequisites

- GitHub repository auto-merge must be enabled
- `GITHUB_PR_BOT_TOKEN` must have repo write access sufficient to read PRs, comment, update branches, and enable auto-merge

## Telegram

The backend worker cron runs every 6 hours UTC and flushes queued PR alerts to Telegram when both Telegram secrets are set.
