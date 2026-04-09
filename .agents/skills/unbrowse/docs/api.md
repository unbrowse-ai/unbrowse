# API Reference

Read when: wiring a client against the local server, validating a route contract, or checking which surfaces are local-first vs marketplace-backed.

Prefer the CLI for real use. The HTTP routes below are the substrate the CLI wraps.

Public companion docs live at [docs.unbrowse.ai](https://docs.unbrowse.ai). The agent-facing CLI contract lives in [SKILL.md](/Users/lekt9/.codex/worktrees/c99f/unbrowse/SKILL.md).

## Base URLs

- Local server: `http://localhost:6969`
- Marketplace backend: `https://beta-api.unbrowse.ai`

The normal product path is local-first. CLI commands hit the local server, and the local server proxies marketplace-backed work when needed.

Backend payment policy can split discovery from detail. With `X402_SEARCH_ENABLED=false`, `/v1/search*` stays free for discovery while paid `/v1/skills/:id` manifests still return `402 Payment Required`.

## TypeScript SDK

The SDK lives in [`packages/sdk`](../packages/sdk/README.md). It is a thin wrapper over the same local server routes the CLI uses.

Install:

```bash
npm install @unbrowse/sdk
```

Basic resolve:

```ts
import { Unbrowse } from "@unbrowse/sdk";

const unbrowse = new Unbrowse();

const resolved = await unbrowse.resolve({
  intent: "get feed posts",
  url: "https://news.ycombinator.com",
});
```

Explicit execute:

```ts
const rerun = await unbrowse.execute(resolved, {
  projection: { raw: true },
});
```

Auth helpers:

```ts
await unbrowse.importAuth({
  url: "https://x.com/home",
  browser: "auto",
});

await unbrowse.login({
  url: "https://calendar.google.com",
});
```

## Primary routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Local server health/version surface |
| `POST` | `/v1/intent/resolve` | Canonical product entrypoint: search cached domain routes and optionally execute a trusted hit |
| `POST` | `/v1/skills/:id/execute` | Execute a chosen endpoint from a known skill |
| `GET` | `/v1/skills` | List skills visible from the current runtime |
| `GET` | `/v1/skills/:id` | Fetch one skill manifest |
| `POST` | `/v1/skills/:id/verify` | Verify endpoints on a skill |
| `POST` | `/v1/skills/:id/review` | Push reviewed endpoint descriptions/metadata |
| `POST` | `/v1/skills` | Publish a skill manifest |
| `POST` | `/v1/auth/login` | Headed login flow for a target site |
| `POST` | `/v1/auth/steal` | Import cookies from browser/Electron storage |
| `POST` | `/v1/feedback` | Feedback loop for skill/endpoint quality |
| `GET` | `/v1/stats/summary` | Marketplace summary stats |

## Canonical resolve flow

`POST /v1/intent/resolve` is the product-truth entrypoint. In the current repo it can:

- hit route cache
- hit domain cache / local snapshots
- hit marketplace-backed search
- return a deferred shortlist in `available_endpoints`
- include `workflow_dag` for the relevant operation subgraph, with per-operation / per-endpoint `prefetch_get_operations` hints for safe dependent GET reads
- execute immediately when the best route is already clear
- return a cache miss quickly when nothing trusted is cached yet

The CLI wrapper is:

```bash
unbrowse resolve --intent "..." --url "..." --pretty
```

The SDK mirrors the CLI by copying `url` into both `params.url` and `context.url`, so ranking and replay stay aligned with the canonical product path.

## Execute flow

Use execute when you already know the skill id and endpoint id:

```bash
unbrowse execute --skill <skill_id> --endpoint <endpoint_id> --pretty
```

Or from the SDK:

```ts
await unbrowse.execute("skill_123", {
  params: { symbol: "NVDA" },
  contextUrl: "https://finance.yahoo.com/quote/NVDA",
});
```

Useful post-processing flags supported by the current CLI:

- `--schema` — show schema/extraction hints without data
- `--path "data.items[]"` — drill into a nested path first
- `--extract "name,url,alias:deep.path"` — project fields without `jq`
- `--confirm-third-party-terms` — required for policy-sensitive mutations on flagged domains such as X write endpoints, in addition to `--confirm-unsafe`
- `--limit N` — cap array results

Execute is the explicit replay surface. Traversal-time browser tools (`go`, `snap`, `click`, `fill`, `submit`) only gather passive evidence. Linked replay contracts, parameter restrictions, enums, and derived auth/token hints are compiled and exposed later through publish/index artifacts.

## Auth

`POST /v1/auth/login` is the user-facing login path. It opens a visible browser flow, stores session state under `~/.unbrowse/profiles/<domain>/`, and lets later calls reuse that auth locally.

`POST /v1/auth/steal` is the lower-level cookie import path for browser/Electron stores. Use it when you need custom cookie DB or user-data-dir input instead of the normal interactive login flow.

## MCP contract inspection surface

The MCP server now exposes read-only publish-time workflow metadata in addition to tool calls.

- `workflow_publish://<skill>` — exported artifact summary for one indexed/published skill
- `workflow_contract://<skill>/<endpoint>` — sanitized replay contract with typed params, enums, prerequisite specs, x402/payment requirements, provenance hints, and next-state validators
- `workflow_dag://<skill>/<endpoint>` — dependency graph / common-var walk for one workflow edge
- `plan_workflow_execution` — prompt that tells the host model to inspect the contract and DAG before deciding between browser traversal and explicit replay

These MCP resources are publish-time outputs. They do not trigger live replay during browse traversal.

## Capture pipeline verbs

The checkpoint pipeline is explicit:

- `sync` — checkpoint current capture, keep the tab open, queue background `index -> publish`
- `close` — checkpoint current capture, queue background `index -> publish`, save auth, close tab
- `index` — recompute local graph/contracts/export only; no remote share
- `publish` — rerun local index, then perform explicit remote share/re-publish
- `settings` — inspect or update local auto-publish policy, blacklist, and prompt-list domains

Publish now shares the admitted root endpoints plus their DAG-linked callable closure for the same workflow component, so future agents can invoke an individual readable or mutable step directly instead of only the top-ranked route.

Workflow exports now move through:

- `captured` — raw local evidence exists
- `indexed` — local graph/contracts/export compiled
- `published` — remote share succeeded
- `blocked-validation` — local compile succeeded but remote publish/share blocked

Checkpoint and publish responses now also surface guidance fields:

- `pipeline` — whether local `index` / remote `publish` were actually queued
- `publish_policy` — why remote publish was allowed, blocked, or paused
- `next_step` — concrete follow-up hint such as `close`, `index`, or explicit `publish --confirm-publish`

Local publish policy lives in `~/.unbrowse/config.json` and is available over `GET/POST /v1/settings`.

- `auto_publish_checkpoints` — enable/disable automatic remote publish after `sync` / `close`
- `publish_domain_blacklist` — never auto-publish these domains; explicit `publish` requires confirmation
- `publish_domain_promptlist` — pause auto-publish and require confirmation for explicit `publish`

## Browse proxy contract

Browse routes are intentionally thin over Kuri now.

- `POST /v1/browse/go` opens a fresh Kuri tab/session unless you explicitly pass `session_id`.
- Reusing a live tab is opt-in: pass the same `session_id` for `go`, `snap`, `click`, `fill`, `submit`, `sync`, and `close`.
- Read calls like `snap`, `screenshot`, `text`, `markdown`, `cookies`, and `eval` no longer auto-reset or rebind to a replacement tab when the current session goes bad. They return the real session outcome instead.

## Browse-session dependency contract

For multi-step browser flows, downstream pages depend on upstream state. Treat `POST /v1/browse/submit` as the boundary that proves the dependency edge.

- Call `go`, `snap`, action tools, then `submit` for the real page transition.
- Regular traversal is browser-native and thin by default. `assist_site_state` and `same_origin_fetch_fallback` must be explicitly enabled; passive API observation stays for publish/index analysis, not normal page walking.
- Monitored requests discovered while traversing are not exposed as live replay steps yet. They become harness-visible only after publish/index compiles the workflow contract.
- After `submit`, trust the returned `url`, `session_id`, and transition metadata. Do not guess deep links if the session has not actually unlocked them yet.
- `sync` after important transitions so the current capture is checkpointed and the background `index -> publish` pipeline records the working request chain for future resolve/execute calls.
- If the server later returns `abandonedCart`, `session_expired`, or the wrong product/audience variant, restart from the last known good upstream step instead of forcing a downstream page.

## Mutations

Unsafe endpoint execution must be explicit.

- `dry_run: true` previews a mutation
- `confirm_unsafe: true` is required to actually perform it

CLI wrappers:

```bash
unbrowse execute --skill <skill_id> --endpoint <endpoint_id> --dry-run
unbrowse execute --skill <skill_id> --endpoint <endpoint_id> --confirm-unsafe
```

## Registration and ToS

Agent registration happens through the local runtime on first startup if no saved API key exists.

- config is persisted in `~/.unbrowse/config.json`
- interactive runs prompt for ToS acceptance and optional email-style identity
- headless runs can preseed with `UNBROWSE_NON_INTERACTIVE=1`, `UNBROWSE_TOS_ACCEPTED=1`, and `UNBROWSE_AGENT_EMAIL=...`

## Related docs

- [Quickstart](/Users/lekt9/.codex/worktrees/c99f/unbrowse/docs/guides/quickstart.md)
- [TypeScript SDK](../packages/sdk/README.md)
- [Codex eval harness](/Users/lekt9/.codex/worktrees/c99f/unbrowse/docs/codex-eval-harness.md)
