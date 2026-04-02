# Codex Eval Harness

Purpose:
- run the real CLI path from inside the repo
- collect raw CLI evidence for the agent in this thread to inspect and judge
- leave an artifact Codex can inspect in the same workspace

Script:
- [evals/codex-harness.ts](/Users/lekt9/Projects/unbrowse/evals/codex-harness.ts)
- [evals/codex-autonomous-harness.ts](/Users/lekt9/Projects/unbrowse/evals/codex-autonomous-harness.ts)
- [evals/codex-campaign-runner.ts](/Users/lekt9/Projects/unbrowse/evals/codex-campaign-runner.ts)

Artifact:
- `evals/codex-harness-last-run.json`
- sidecar review queue: `evals/codex-harness-last-run.review-queue.json`
- autonomous artifact: `evals/codex-autonomous-last-run.json`

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

This now uses the autonomous harness, not the manual review queue.

Run the autonomous repair loop:
```bash
bun run eval:codex:autonomous -- --cases evals/codex-cases.example.json --max-rounds 6 --max-candidates 4
```

Build the merged bulk-seed corpus from the shipped real-site suites:
```bash
bun run build:codex:campaign-seed
```

Run a resumable campaign in shards:
```bash
bun run eval:codex:campaign -- \
  --cases evals/codex-cases.bulk-seed.json \
  --artifact-dir evals/campaigns/public-seed \
  --shard-size 10 \
  --resume \
  --max-rounds 4 \
  --max-candidates 4
```

Run the auth corpus:
```bash
bun run eval:codex:auth
```

Run only the scripted demo auth cases:
```bash
bun run eval:codex:auth:demos
```

Run auth convergence across suite passes:
```bash
bun run eval:codex:auth -- --suite scripted-demo --suite-rounds 2
```

Run explicit cold-vs-warm benchmark mode:
```bash
bun run eval:codex:autonomous:benchmark -- --cases evals/codex-cases.example.json
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
- autonomous harness is for brute-force convergence:
  - resolve -> shortlist execute -> local truth judge
  - if fail, escalate to force-capture
  - if still fail, follow deeper `trigger_url` pages
  - if still fail, stop with explicit terminal taxonomy: `blocked`, `skip`, or `fail`
  - optional per-case DAG assertions via `dag.target_operation_id` or `dag.target_endpoint_id`
  - every round records `trace_context` and `repair_memory` so retries can be inspected against known bindings, available DAG operations, prior endpoint failures, and prior repair choices
  - benchmark mode runs each case twice:
    - `cold`: force capture / first-run path
    - `warm`: reuse path without forced capture
  - benchmark artifacts record per-round `source`, latency, and token telemetry when available, plus per-case cold/warm deltas
- campaign runner is for scale:
  - slices a case file into shard case-files
  - runs the autonomous harness shard-by-shard
  - supports `--resume` against existing shard artifacts
  - writes `campaign-state.json` and `campaign-merged.json`
  - avoids the broken “1k sites in one process” pattern
- auth cases require browser-imported cookies to already exist in the local vault
- auth corpus lives in `evals/codex-cases.auth-popular.json`
- auth runner uses repo-native Unbrowse flows only:
  - `cookie_reuse`: reuse or import browser cookies into the vault
  - `scripted_demo`: run scripted login steps for stable demo sites, store cookies, then call the autonomous harness
  - `interactive_login`: optional manual login if `--interactive-login` is passed
  - `scripted_login_profile_only`: if a demo site reaches the authenticated success URL but does not persist reusable cookies, the runner still reuses the saved browser profile instead of hard-failing bootstrap
- auth runner also loops at the suite level:
  - reruns only unsatisfied cases for `--suite-rounds N`
  - stores both `best_results` and raw `attempts` in the top-level artifact
  - workflow speed budgets are judged on warm-path timings when the workflow config includes latency budgets, while raw cold timings stay in the artifact for regression/debugging
- auth runner writes a top-level artifact:
  - `evals/codex-auth-eval-last-run.json`
  - per-case autonomous artifacts:
    - `evals/codex-auth-site.<case-id>.json`
- current corpus mixes:
  - popularity-backed logged-in consumer sites from Similarweb's U.S. ranking
  - scripted demo login sites that should pass without user credentials
- AgentMail-style registration/OTP bootstrap is reserved as a future strategy; current runner records that case type as unsupported instead of pretending it passed
- canonical product-success suite lives in `evals/codex-cases.product-success.json`
- stress suite lives in `evals/codex-cases.stress.json`
- merged bulk-seed corpus lives in `evals/codex-cases.bulk-seed.json`
- `eval:codex:public` is an alias to the autonomous product-success suite
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

Autonomous case shape:
```json
{
  "id": "notes-create",
  "intent": "create note",
  "url": "https://practice.expandtesting.com/notes/app",
  "auth": {
    "domain": "practice.expandtesting.com",
    "persona": "qa-user",
    "role": "editor",
    "session": "primary"
  },
  "params": { "title": "hello", "description": "world" },
  "expected_fields": ["id", "title", "description"],
  "validate": {
    "entity_type": "document",
    "min_rows": 1,
    "side_effect": "created",
    "echo_params": ["title", "description"],
    "terminal_ok": ["pass"]
  },
  "dag": { "target_operation_id": "notes-create", "require_path": true },
  "repair": { "max_rounds": 6, "max_candidates": 4, "max_follow_urls": 3 }
}
```

Validation fields:
- `entity_type`: assert the resolved payload is the right thing, not just a 200
- `min_rows`: assert enough rows/items returned for search/list intents
- `side_effect`: assert mutation shape such as `created`, `updated`, `deleted`, `sent`
- `echo_params`: assert response/output reflects the supplied workflow inputs
- `terminal_ok`: allow expected non-pass terminals like `blocked` for hostile sites
