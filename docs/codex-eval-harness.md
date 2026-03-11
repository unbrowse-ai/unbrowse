# Codex Eval Harness

Purpose:
- run the real CLI path from inside the repo
- collect raw CLI evidence for the agent in this thread to inspect and judge
- leave an artifact Codex can inspect in the same workspace

Script:
- [evals/codex-harness.ts](/Users/lekt9/Projects/unbrowse/evals/codex-harness.ts)

Artifact:
- `evals/codex-harness-last-run.json`
- sidecar review queue: `evals/codex-harness-last-run.review-queue.json`

Refresh the local package first:
```bash
cd /Users/lekt9/Projects/unbrowse/packages/skill
npm pack

tmpdir="$(mktemp -d /tmp/unbrowse-codex-skill.XXXXXX)"
cd "$tmpdir"
npm init -y
npm install /Users/lekt9/Projects/unbrowse/packages/skill/unbrowse-*.tgz
./node_modules/.bin/unbrowse health --no-auto-start
```

Use the packaged `unbrowse` binary for install/runtime smoke checks.
Use `bun run eval:codex` for repo-path debugging and artifact inspection.

Run one case:
```bash
bun run eval:codex -- --intent "list my discord servers" --url "https://discord.com/channels/@me" --force-capture
```

Run one param-seeded case:
```bash
bun run eval:codex -- --intent "search hacker news" --url "https://hn.algolia.com/" --params '{"q":"openai"}'
```

Run a case file:
```bash
bun run eval:codex -- --cases evals/codex-cases.example.json --force-capture
```

Run the canonical product-success suite:
```bash
bun run eval:codex:product-success
```

Run the broader stress suite:
```bash
bun run eval:codex:stress
```

Notes:
- uses the actual CLI resolve path:
  - `resolve --raw`
- harness is collector-only:
  - every case stops at resolve
  - harness never auto-executes for scoring
  - the final verdict happens in-thread by the agent reviewing the artifact
- artifact stores collector status only:
  - `ready_for_review`
  - `fail`
  - `skip`
- artifact also writes a compact `review_queue` and sidecar `.review-queue.json`:
  - top ranked candidates only
  - signal tags like `schema`, `templated_url`, `api_like`, `structured_replay`, `document_replay`, `page_artifact_risk`
  - ready-to-run `cli` commands for each candidate
- once the agent picks an endpoint, run the suggested `agent_review.execute_candidates[*].cli`
- the same artifact also includes graph/DAG coverage:
  - fixture-backed operation selection checks
  - dependency-walk checks across multi-step chains like search -> detail and guilds -> channels -> messages
- auth cases require browser-imported cookies to already exist in the local vault
- canonical product-success suite lives in `evals/codex-cases.product-success.json`
- stress suite lives in `evals/codex-cases.stress.json`
- `eval:codex:public` is an alias to the product-success suite
- `eval:codex:agent-targets` is an alias to the stress suite
- product-success suite is intentionally task-shaped:
  - real result/detail pages, not random homepages
  - at least one param-seeded case
  - intended for product claims after agent review
  - GitHub
  - GitLab
  - Hacker News param-seeded search
  - Reddit
  - npm
  - PyPI
  - Docker Hub
- stress suite adds broader public agent-benchmark targets we want to support reliably:
  - ArXiv
  - Hugging Face
  - Allrecipes
  - Coursera
  - Cambridge Dictionary
  - Hacker News search
  - Jmail search
  - Stack Overflow
  - MDN
  - DEV Community
  - crates.io
  - RubyGems
  - pub.dev
  - Lobsters
- artifact includes:
  - resolve excerpt
  - deferred endpoint shortlist
  - selected endpoint order
  - `agent_review` execute hints
  - direct-result excerpt when resolve already returned structured data
  - supplied params + query source
  - graph selection/dependency-walk summary
  - local signal for shortlist/direct-result plausibility

Recommended Codex loop:
1. run the harness for one intent/url
2. inspect `evals/codex-harness-last-run.json`
   or the compact `evals/codex-harness-last-run.review-queue.json`
3. agent marks pass/fail/skip in-thread from the shortlist or direct result
4. if needed, pick an endpoint from `agent_review.execute_candidates`
5. run that execute command
6. patch the product
7. rerun the same case until the agent says it passes
