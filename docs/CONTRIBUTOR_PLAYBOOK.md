# Contributor Playbook (Unbrowse)

Use this for any change that touches parser, merge, publish, execute, or UI-facing docs.

## First classification

Before coding, label the change:
1. Plugin-only: capture, parse, skill generation, replay scripts, and tool schemas.
2. Server-only: routes, repositories, execution, credentials, and validation services.
3. Shared boundary: publish/search/install/execute contracts across plugin and server.
4. Web-only: discovery, contributor views, analytics pages.

If the change is Shared boundary, treat it as contract-facing and update documentation in the same cycle.

## Local vs shared behavior to preserve

Default behavior is local.
`unbrowse_capture`, `unbrowse_browse`, and `unbrowse_learn` create local artifacts in `~/.openclaw/skills/<service>/`.
`unbrowse_replay` uses local artifacts first.

Publishing and install adds shared contract behavior.
It does not erase local execution.

Document both paths when changing behavior in either route.

## Minimum files to read before touching code

- `docs/ARCHITECTURE.md`
- `docs/INTEGRATION_BOUNDARIES.md`
- `docs/LLM_DEV_GUIDE.md`
- `server/src/server/routes/README.md`
- `server/src/server/routes/public.ts`
- `server/src/server/routes/marketplace.ts`

## Merge-sensitive changes

If you touch parser, inference, merge, or skill writing:
- `packages/plugin/src/har-parser.ts`
- `packages/plugin/src/skill-generator.ts`
- `packages/plugin/src/skill-package-writer.ts`
- `server/src/server/skill-merge.ts`

Then add:
- before/after merge expectation note
- at least one merge regression case
- at least one conflict test scenario

Conflict scenarios to test first:
- same endpoint appears twice with header drift
- same endpoint path with body optional-field changes
- auth requirement introduced/removed for existing endpoint

## Boundary-safe editing checklist

Plugin
- keep local auth local by default
- keep tool dependencies explicit in `deps.ts`
- verify local replay path for changed capture behavior

Server
- do not silently change route shape
- update route docs and expected errors together
- keep security filtering and merge scoring updates explicit in docs

Marketplace/black-box boundary
- only publish contract fields
- avoid documenting internals
- do not claim behavior for hidden ranking/execution internals

Web
- read response fields from server contracts directly
- keep fallbacks explicit when optional fields are missing

## Payments rule

Payments are not enabled in this repository.
Wallet tooling remains placeholder-only.
Do not write docs or tests as if settlement is live.

## Merge and publish pre-merge checklist

- classify boundary impact
- update contract docs that callers depend on
- update contributor docs for behavior changes
- add regression coverage
- confirm local replay determinism remains intact where unchanged
- confirm publish/search/install behavior is still documented
