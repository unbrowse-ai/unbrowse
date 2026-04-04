# Unbrowse Codex Eval

Use this when you need to bench Unbrowse through the real CLI/orchestrator path, with GPT judging every case, and when you need to separate public sites from plaintext-auth-eligible sites.

## Refresh local package first

Always rebuild and install the local npm package before testing so the packaged CLI matches the repo:

```bash
cd /Users/lekt9/Projects/unbrowse/packages/skill
npm pack

tmpdir="$(mktemp -d /tmp/unbrowse-codex-skill.XXXXXX)"
cd "$tmpdir"
npm init -y
npm install /Users/lekt9/Projects/unbrowse/packages/skill/unbrowse-*.tgz
./node_modules/.bin/unbrowse health --no-auto-start
```

Use the installed `./node_modules/.bin/unbrowse` binary for packaging/runtime smoke checks.
Use the repo harness below when debugging product behavior, ranking, capture, or judge flow.

Default eval mode is GPT-judge required:
- harness runs `resolve`
- deferred cases auto-run top execute candidates
- final verdict comes from the eval judge module
- expected fields and auth API-source rules are hard gates
- if GPT judge is unavailable, `llm_required` fails the case

Judge env:
- `UNBROWSE_EVAL_JUDGE_MODE=llm_required|llm_preferred|local`
- `UNBROWSE_EVAL_JUDGE_MODEL=<model>`
- falls back to `UNBROWSE_AGENT_JUDGE_MODEL`

## Run

Single case:
```bash
bun run eval:codex -- --intent "list my discord servers" --url "https://discord.com/channels/@me" --force-capture
```

Param-seeded case:
```bash
bun run eval:codex -- --intent "search hacker news" --url "https://hn.algolia.com/" --params '{"q":"openai"}'
```

Case file:
```bash
bun run eval:codex -- --cases evals/codex-cases.example.json --force-capture
```

Canonical product-success suite:
```bash
bun run eval:codex:product-success
```

Broader stress suite:
```bash
bun run eval:codex:stress
```

Top-1000 discovery split:
```bash
bun run eval:top-sites:discover -- --limit 1000
```

## Read

- artifact: `evals/codex-harness-last-run.json`
- compact review queue: `evals/codex-harness-last-run.review-queue.json`
- harness doc: `docs/codex-eval-harness.md`
- top-sites discovery: `evals/top-sites-discovery.json`
- public target bucket: `evals/top-sites-public-targets.json`
- strict plaintext-auth bucket: `evals/top-sites-auth-targets.json`
- rejected auth bucket: `evals/top-sites-auth-rejected.json`
- buckets are second-pass verified:
  - public rejects auth redirects and challenge pages
  - auth requires first-party login + register pages with plaintext password forms
- `eval:codex:public` is an alias for the product-success suite
- `eval:codex:agent-targets` is an alias for the stress suite

## What To Look For

- wrong deferred endpoint order
- review queue candidate signals:
  - `schema`
  - `templated_url`
  - `concrete_url`
  - `trigger_url`
  - `api_like`
  - `structured_replay`
  - `document_replay`
  - `page_artifact_risk`
- page artifact outranking real APIs
- `agent_review.execute_candidates` missing the right endpoint
- execute failures after the agent picks an endpoint
- query/template params not being populated by the agent path
- graph/DAG selection or dependency walks failing in the artifact's `graph` section
- GPT pass/fail drift vs local signal
- missing auth cookies
- public suite drift on GitHub, npm, PyPI, GitLab, or Docker Hub
- product-success drift on GitHub, GitLab, npm, PyPI, MDN, Hacker News, Reddit, or Docker Hub
- stress-target failures on ArXiv, Hugging Face, Allrecipes, Coursera, Cambridge Dictionary, Jmail, or other long-tail sites
- long-tail public failures on Stack Overflow, MDN, DEV, crates.io, RubyGems, pub.dev, or Lobsters
- top-sites auth candidates that are SSO-only, challenge-blocked, or only expose login without register
- raw auth-link guesses that collapse into pricing, newsletter, event, or third-party identity pages

## Workflow

1. run the harness on one failing intent/url
2. inspect the artifact
3. inspect GPT verdict + local reason + matched/missing fields
4. if needed, replay one `agent_review.execute_candidates[*].cli`
5. patch ranking/capture/execute/judge rules
6. rerun the same case
7. only then broaden to suites
8. for top-sites discovery, only promote auth targets from `plaintext_login_and_register`
