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
| `POST` | `/v1/intent/resolve` | Canonical product entrypoint: search, capture, defer, or execute |
| `POST` | `/v1/skills/:id/execute` | Execute a chosen endpoint from a known skill |
| `GET` | `/v1/skills` | List skills visible from the current runtime |
| `GET` | `/v1/skills/:id` | Fetch one skill manifest |
| `POST` | `/v1/skills/:id/verify` | Verify endpoints on a skill |
| `POST` | `/v1/skills/:id/review` | Push reviewed endpoint descriptions/metadata |
| `POST` | `/v1/skills` | Publish a skill manifest |
| `POST` | `/v1/auth/login` | Headed login flow for a target site |
| `POST` | `/v1/auth/steal` | Import cookies from browser/Electron storage |
| `POST` | `/v1/search` | Global semantic search across skills |
| `POST` | `/v1/search/domain` | Domain-scoped semantic search |
| `POST` | `/v1/feedback` | Feedback loop for skill/endpoint quality |
| `GET` | `/v1/stats/summary` | Marketplace summary stats |

## Canonical resolve flow

`POST /v1/intent/resolve` is the product-truth entrypoint. In the current repo it can:

- hit route cache
- hit domain cache / local snapshots
- hit marketplace-backed search
- try a lightweight first-pass browser action
- fall back to live capture
- return a deferred shortlist in `available_endpoints`
- execute immediately when the best route is already clear

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

## Browse-session dependency contract

For multi-step browser flows, downstream pages depend on upstream state. Treat `POST /v1/browse/submit` as the boundary that proves the dependency edge.

- Call `go`, `snap`, action tools, then `submit` for the real page transition.
- Regular traversal is browser-native by default. `same_origin_fetch_fallback` must be explicitly enabled; passive API observation stays for publish/index analysis, not normal page walking.
- Monitored requests discovered while traversing are not exposed as live replay steps yet. They become harness-visible only after publish/index compiles the workflow contract.
- After `submit`, trust the returned `url`, `session_id`, and transition metadata. Do not guess deep links if the session has not actually unlocked them yet.
- `sync` after important transitions so the route graph records the working request chain and future resolve/execute calls can inherit it.
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
