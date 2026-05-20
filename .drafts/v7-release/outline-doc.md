# unbrowse v7.0.0 release: server-side intelligence, paid LLM gateway, $1-on-signup agent subsidy

> Internal release announcement. Target Outline collection: a new
> "Major releases" collection under docs.getfoundry.app.
> Publish flow: scripts/publish_to_outline.sh team-foundry, --dry-run
> until human confirms with --yes.

## TL;DR

v7.0.0 cuts the unbrowse release on a bench you can run, not just a number
you have to trust. Four pieces of intelligence (ranker, LLM augmentation,
DAG edge confidence, reliability scoring) moved server-side. Three payment
rails (signup sponsor budget, opt-in residential proxy on 429, LLM gateway
markup) settle through Faremeter Flex on Solana USDC. The corpus that
produced the gate comes from 76 Reddit threads, open in the repo.

## What is new

### Server-authoritative intelligence

The npm bundle no longer ships the tuning weights for any of unbrowse's
load-bearing intelligence. Each move below leaves a degraded local
fallback so an offline resolve still returns a shortlist.

- `POST /v1/search/rank` runs the 900-line evidence-derived ranker
  server-side. Auth-gated, returns ranked candidates plus per-signal
  evidence. The weight table never reaches the client. Service:
  `backend/src/services/rank.ts:rankEndpointsServer`. Client dispatcher:
  `src/ranking/index.ts:rankEndpointsServerFirst`. PR #531.
- `POST /v1/graph/augment-semantic` runs the LLM augmentation prompt
  server-side. Service: `backend/src/services/semantic-augment.ts`.
  Client: `src/graph/agent-augment.ts`. Best-effort; augment failure
  yields `{endpoints: []}` and the client falls back to local
  heuristics. PR #529.
- `POST /v1/graph/confidence` runs cross-user online-learned DAG edge
  confidences. Service: `backend/src/services/graph-confidence.ts`.
  Per-domain-per-edge aggregates in statsKV; clients see only the
  projection. PR #530.
- `POST /v1/stats/reflect` runs population-level reliability +
  staleness aggregate. Service: `backend/src/services/scoring.ts`.
  Client adopts the authoritative `reliability_score` +
  `verification_status` + `stale` into the local snapshot. PR #528.

### Payment rails (paired with the subsidy)

Settlement seam: Faremeter Flex over Solana USDC.
`backend/src/services/sponsor-flex.ts` (Solana RPC) plus
`backend/src/middleware/sponsor.ts` (Flex rail).

Wallet delegation boundary, surfaced verbatim on the public
`/how-unbrowse-pays` page: unbrowse owns intent, amount, recipient,
memo; lobster.cash owns provisioning, signing, broadcast.

Three rails live as of v7.0.0:

1. **Sponsor middleware.** Every paid execute first checks a per-agent
   signup budget and a per-platform daily safety cap. The platform
   wallet sponsors the first $1 of execution for every new agent on
   signup; once that dollar is spent the agent falls through to its
   own x402 wallet. A platform-wide $50/day cap sits on top as a
   runaway guard. State keys (unchanged from v6.x):
   `sponsor:agent:<id>:<UTC-date>`, `sponsor:global:<UTC-date>`,
   `sponsor:ledger:<id>`. Surfaced via
   `GET /v1/account/sponsor-status` and
   `GET /v1/admin/sponsor-ledger`. Implementation note: the underlying
   counter at `backend/src/middleware/sponsor.ts:sponsorCapDailyUsd`
   is still date-bucketed; the operational positioning is "one
   budgeted day on us per agent, then they pay their own way." If we
   want the cap to be lifetime instead of per-day, that is a one-line
   change to the KV key shape; flag before tag if you want it.
2. **Opt-in paid residential-proxy fallback on 429.** Local execute
   detects 429; agent opts in; server bills around $0.01/call via
   x402. Egress stays local (Cloudflare Workers cannot CONNECT-tunnel
   through an arbitrary residential proxy); billing sits where the
   meter lives. Off by default. PR #535.
3. **LLM gateway with 50% markup.** `POST /v1/llm/:provider/messages`
   accepts a Stripe x402 envelope, proxies to xgate.run, bills 50%
   above raw provider cost. Wave-2 ship: unified payment surface so
   the same key pays for paid routes AND the Anthropic / OpenAI calls
   upstream of them. The gateway margin funds the sponsor subsidy on
   the execute side.

Marketplace cut stays at 10%. Per-execute reuse fees still pay the
indexer in USDC on Solana via the lobster.cash binding set up during
`npx unbrowse setup`.

### Internal bench-gate, open in the repo

`harness/probes/corpus-gate.txt`: typed probes
(`intent | context_url | lane | probe_id`). Locked at 58; running
superset at 66.

`harness/probes/GATE_JUDGE.md`: agent-judged rubric. Lanes: public,
anchor, hostile, auth-gated. Verdicts are an agent reading the
artifact bundle (resolve shortlist, pick, execute response, page
snapshot) in-thread. The harness never decides "pass". It only emits
evidence.

`scripts/mcp-gate-parallel-collect.ts`: deterministic parallel
collector, no LLM. Drives real `unbrowse_resolve` and
`unbrowse_execute` through the MCP surface, not a curl shortcut.
Concurrency 4-6 validated; the per-probe `iso_self_check` is the
in-run falsifier.

New `docs/BENCHMARK.md` (shipping with v7.0.0) walks the
reddit-to-corpus methodology, the typed-probe contract, the lane
taxonomy, the agent-judges-not-regex discipline, and the PR template
for outside contributors.

### Reddit-to-corpus methodology

Two evidence-build waves: 12 subreddits, 16 query pairs, 76 unique
threads. Wave-2 reranked our positioning hypotheses
(x402_monetization jumped from last to second-strongest after the
sharper query pair). Every claim on the landing page now traces to a
`t3_` thread id at `frontend/docs/POSITIONING.md`. Same trace shape
applies to every new claim that lands; PR #523 set the precedent.

Wave-3 was a codebase audit against the Reddit-driven copy: 8
corrections + 4 found-but-missed pieces landed (F1 USDC settlement
chain corrected from Base to Solana; U7 Crossmint payout restored; U8
"capture is free, agents pay on reuse" reframe).

### Auth + automation safety

- `auth_walled` signal at capture admission, ranker demotion for stale
  auth-gated endpoints. PRs #517, #518.
- Three-surface login hint with kuri keychain awareness when resolve
  hides stale endpoints. PRs #519, #520.
- `POST /v1/browse/go` never pops a visible Chrome window in
  automated/agent context (MCP_SERVER_MODE=1, UNBROWSE_NONINTERACTIVE=1,
  or non-TTY stdout). PR #533. Returns `auth_required` + actionable
  `auth_hint` handoff with zero screen spam.
- Per-session kuri isolation default-on; raises safe browse concurrency
  from 4 to 8. PR #526.

### Bench-gate dev loop

- `scripts/mcp-hot-proxy.ts`: stdio MCP proxy with chokidar watcher;
  source edit triggers child SIGTERM + respawn + replay initialize +
  resume tools/list, no `/mcp` reconnect needed. Closed-loop gate-fix
  loop runs without losing the session. PR #538.
- `UNBROWSE_GATE_STOP_ON_FAIL=1`: early-stop primitive, writes
  `.stop-marker` on first structural fail, exit 2. PR (PR-1bcf8463).
- `UNBROWSE_GATE_SKIP_EMPTY_SNAPSHOT=1`: skip browser-infra failure
  classes (empty_snapshot, go_failed) that are orthogonal to
  substrate fixes.
- Per-probe timeout with `crashed_during_collect` marker so the
  collector never hangs on a stuck probe. PR #544.
- Agent-judged bench-corpus refresh script (`harness/probes/`),
  agent-driven and never auto-mutates. PR #450.
- Telemetry corpus feeder: `GET /v1/telemetry/recent-failures`
  (admin-gated) + `harness/probes/auto-corpus-feeder.py` proposes new
  probes from real wild failures. Agent reviews diff and cherry-picks
  via PR; never auto-merges.

### Publish-side hardening

`backend/src/services/publish-sanitize.ts` server-enforces secret
redaction on `POST /v1/skills`. The pre-existing validator only
dropped credential-NAMED headers; secrets in `query`, `body`, and
`semantic.example_request` flowed through. v7.0.0 re-runs the
identical redaction core server-authoritatively before
`publishSkill`. `backend/tests/sanitize-parity.test.ts` pins
client/server parity. PR-081022cf.

### Frontend

Evidence-driven landing rewrite from 76 Reddit threads. Three-wave
build (Reddit pull, sharper queries, codebase audit) produced a
landing page where every claim cites a `t3_` id. New components:
UniversalProofBand, ZeroSetupBand, BenchmarkTable, EarnSection,
ObjectionFaq, AntiIcpBlock. FAQ JSON-LD reflects the rewritten
objection set. PR #523.

`/account` cascading 401 fix: the API-key rotation kill-switch was
producing six cascaded error banners. New `AuthInvalidBanner` short-
circuits all six sections with one CTA + `/login?reason=key_rotated`
auto-redirect after 1800ms. PR #557. Same wave gated
`GET /v1/ops` to admin only (was leaking signed-in user PII; masked
by the kill-switch until v7.0.0).

X handle alignment: `@getFoundry` to `@unbrowse` across 21 frontend
files (meta tags, footer, privacy/terms). PR #556.

## What did NOT make it

These are queued in callable harnesses for the next minor release:

- Windows x86-64 Kuri binary (harness `build-kuri-for-windows`).
- Replace proven-recipe-replay with full DAG recompute at runtime
  (harness `replace-proven-recipe-replay`). The 16-site per-domain
  registry deletion in Phase 8.3 already removed the static side;
  runtime DAG recompute is the remaining piece.
- Port Scrapling's interactive Cloudflare Turnstile solver (harness
  `port-scrapling-s-interactive-cloudflare-turnstil`).

## Operational notes

- Pre-commit hook fails on merge commits when `submodules/kuri/` is
  empty (`prepare-pack.mjs` throws "Broken Kuri source checkout").
  For merge commits where the submodule is not relevant, use
  `git commit --no-verify`. For non-merge commits, run
  `bash scripts/ensure-submodules.sh` first.
- `EndpointDescriptor` and `SkillManifest` live in three files
  (`backend/src/types.ts`, `src/types/skill.ts`,
  `frontend/src/lib/api.ts`); all must stay in sync.
- `/health` reports `runtime_git_sha` (the actual running code SHA,
  with `-dirty` suffix for uncommitted changes). The baked-at-release
  `git_sha` stays as release provenance. PR-c6e7f492.

## How to verify

```bash
git fetch --tags
git checkout v7.0.0
npx unbrowse setup
unbrowse resolve "search pubmed for cancer immunotherapy papers"
unbrowse execute <endpoint_id> --raw
```

First execute is on the sponsor tier (a new agent's first $1 of
execution is on us, no x402 wallet needed for it). Run
`unbrowse_account_sponsor_status` to see the cap state.
To run the gate locally:

```bash
bash scripts/verify-mcp-audit.sh
UNBROWSE_GATE_CONCURRENCY=4 bun scripts/mcp-gate-parallel-collect.ts
```

The artifact bundle per probe lands in `.bench-gate/run-*/`. The
judge reads each bundle in-thread per
`harness/probes/GATE_JUDGE.md`.

## Links

- Release tag: v7.0.0 (proposed; cut alongside this announcement)
- Open corpus: `harness/probes/corpus-gate.txt`
- Judge rubric: `harness/probes/GATE_JUDGE.md`
- Methodology doc (shipping with v7.0.0): `docs/BENCHMARK.md`
- Positioning trace: `frontend/docs/POSITIONING.md`
- Paper: arxiv 2604.00694 (3.6x mean, 5.4x median across 94 domains)
- Public X Article: <ARTICLE_URL>

## Author note

The release model in one line: build the corpus from real user
complaints, type every probe, let the agent judge the artifact, and
make the corpus pass before cutting the tag. The bench is the
contract; the prose is downstream of it.
