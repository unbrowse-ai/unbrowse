# Unbrowse (OpenClaw Plugin & Skill Ecosystem)

Unbrowse turns real browser traffic into reusable agent capabilities.

It is a two-part system:

- **Extension component** (`packages/plugin`): local capture and local replay.
- **Marketplace component** (`server` + `packages/web`): shared discovery, publish/search/install, and backend execution contracts.

This design keeps local control simple, while allowing shared capability growth.

## Why this matters

An OpenClaw agent that uses browser automation for every web action is slow and fragile.
Each action spends time on browser startup, rendering, DOM waits, and scraping.

Unbrowse changes the execution shape:

- first browse = capture network behavior from the page you already control
- subsequent runs = call captured API endpoints directly when possible

That is why teams use Unbrowse for speed-sensitive workflows (scraping-to-API behavior conversion):

- open a page and interact once to discover true API calls
- avoid repeating GUI-level loops for every later execution

In practical cases, direct endpoint execution can be tens to hundreds of times faster than repeated UI automation steps.

## The 100x story (pragmatic version)

### What browser automation typically does

- launch or coordinate a browser context
- load and render the page
- wait for script hydration and selectors
- find DOM controls
- click/type/submit/read UI text

### What Unbrowse does after learn phase

- run captured endpoint calls directly (`GET`, `POST`, etc.)
- reuse typed auth/session context and endpoint schemas
- execute in a deterministic HTTP workflow

This removes the browser rendering loop from every repeat run.
The result is large speed and reliability gains in action-heavy workflows.

## The Agentic Web model

Unbrowse assumes the web UI is an interface, not the source of truth.

- The true source is request/response behavior.
- The agent should act on that behavior directly after first observation.
- Reusability matters more than one-off, site-specific DOM logic.

In this model:

- observe once in the browser,
- capture underlying API graph,
- normalize into stable execution contracts,
- replay from those contracts when rerunning.

The practical shift is:

- legacy: open page, click, wait, read DOM, retry.
- agentic web: infer, execute, compose outcomes.

This framing is why this work matters:

- reliability: fewer selector and layout assumptions.
- speed: less browser startup/rendering overhead on repeated runs.
- capability compounding: one discovered service can be reused by many agents.
- local ergonomics: still starts as a private local skill.

We call the deeper framing `docs/AGENTIC_WEB.md`.

## Why we keep local first

Because private/local-first usage is the default expected path:

- skill discovery starts on your machine
- artifacts are local files in `~/.openclaw/skills/<service>/`
- replay can succeed without any published index
- optional publish is explicit, never implicit

If you do not publish, you do not need the marketplace.

## What actually runs where

### Extension

`packages/plugin` is responsible for:

- traffic capture from OpenClaw browser sessions and HAR/CDP sources
- endpoint inference and candidate normalization
- local artifact generation (`SKILL.md`, scripts, references, auth metadata)
- local replay orchestration (`unbrowse_replay` local mode)
- local merge of repeated captures

### Marketplace

`server` + `packages/web` are responsible for:

- publish/search/install route contracts
- merge/validation flow before skill is shared
- execution contract routing for installed, published endpoint IDs
- trace and status metadata for shared execution
- web-facing discoverability and contributor views

Marketplace internals are intentionally treated as a black box here.
We document route contracts and observable behavior, not ranking/execution internals.

### Marketplace as optional agentic growth layer

- local behavior stays useful even with no account or publish.
- publish converts local learning into discoverable, shared capabilities.
- backend execution routing (`/marketplace/endpoints/:endpointId/execute`) handles traceable cross-agent replay when configured.
- users get clear local/remote boundaries by command choice, not hidden switches.

Payments are not enabled yet, so this path is for capability sharing first, not settlement.

## End-to-end flow (single diagram)

```text
OpenClaw user action/tool call
 -> extension capture/replay tooling
 -> local skill artifacts in ~/.openclaw/skills/<service>/
 -> local replay (default)
 -> optional publish
 -> marketplace search/install
 -> optional backend execution contract path
 -> output + trace metadata returned
```

## Component-specific responsibilities

### Local flow (default)

Use these commands:

- `unbrowse_capture { "urls": ["https://example.com"] }`
- `unbrowse_browse`
- `unbrowse_learn { "harPath": "/absolute/path/traffic.har" }`
- `unbrowse_login` (for authenticated flows)

Outcomes:

- local service folder under `~/.openclaw/skills/<service>/`
- generated `SKILL.md`
- generated `scripts/`
- optional `references/`
- local `auth.json` when session context was captured

`unbrowse_replay` uses this path first.

### Shared flow (optional)

Use:

- `unbrowse_publish { "service": "example", "price": "0" }`
- `unbrowse_search { "query": "analytics", "install": "<skill-id>" }`

Outcomes:

- server-side validation and merge
- search/discovery visibility
- installability for other users
- backend replay for endpoint IDs via execution contracts (when mapped)

## Why skills are shared

Unbrowse creates the same kind of compounding behavior as shared code:

- one capture can benefit many agents
- repeated coverage improves success and confidence
- contributor contribution logic tracks novelty and compatibility

This is the central reason local learning and shared publish are both included.

## Merge behavior (important for contributors)

Merging is a core behavior, not a corner case.

- local merge handles repeated capture updates for the same service.
- server merge handles public publish-level updates and compatibility checks.

Expected merge signals:
- endpoint normalization and dedupe
- schema compatibility filtering
- conflict resolution policy and contribution ranking updates

If parser/inference/merge logic changes, treat this as user-visible behavior.
Update docs and tests for new merge expectations.

## Security boundary

- local session/auth material is for local execution first
- publish payloads are sanitized for sensitive values
- shared execution uses explicit contracts and boundary checks

## Payments status (explicit)

Payments are **not enabled** in this repository.

- Wallet/payment route declarations may exist.
- paid settlement and payout behavior are intentionally inactive in this stage.
- do not treat repository behavior as paid-by-default.

## Tool map

- `unbrowse_browse`
- `unbrowse_capture`
- `unbrowse_learn`
- `unbrowse_login`
- `unbrowse_replay`
- `unbrowse_search`
- `unbrowse_publish`
- `unbrowse_skills`
- `unbrowse_wallet` (currently inactive placeholder)
- `unbrowse_auth`, `unbrowse_do`, workflow helpers

## Quick start

```bash
openclaw plugins install @getfoundry/unbrowse-openclaw
openclaw gateway restart
```

```bash
unbrowse_capture { "urls": ["https://example.com"] }
unbrowse_replay { "service": "example" }
```

```bash
unbrowse_publish { "service": "example", "price": "0" }
unbrowse_search { "query": "example", "install": "<skill-id>" }
```

## Developer entry points

- Typecheck: `npm run typecheck`
- Plugin tests: `bun test`, `bun test:e2e`, `bun test:oct`
- Server: `pnpm test`, `pnpm dev`, `pnpm build`
- Web: `pnpm dev`, `pnpm build`, `pnpm preview`

## Next reads

1. `docs/ARCHITECTURE.md`
2. `docs/INTEGRATION_BOUNDARIES.md`
3. `docs/CONTRIBUTOR_PLAYBOOK.md`
4. `docs/QUICKSTART.md`
5. `server/src/server/routes/README.md`
6. `docs/AGENTIC_WEB.md`
