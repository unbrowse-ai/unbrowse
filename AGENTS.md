# Unbrowse (OpenClaw) Agent Notes

Project: reverse-engineer internal web APIs into reusable “skills”.

## CLAUDE.md Carryover (useful bits)
- Core loop: `unbrowse_login` or `unbrowse_browse` (auth) -> `unbrowse_capture` (learn) -> `unbrowse_publish` (share) -> `unbrowse_replay` (execute).
- Key promise: whatever the web app frontend can do (via XHR/fetch), Unbrowse can capture and replay.
- Skill tiers:
  - Local: capture + replay with your own browser/session; stays on disk; no marketplace.
  - Marketplace: publish verified skills; agents discover via search; replay can route via backend executor for tracing (LAM).

## Repo Layout
- `packages/plugin/`: OpenClaw plugin (`@getfoundry/unbrowse-openclaw`)
- `packages/web/`: UI (Vite + React)
- `server/`: marketplace/backend (execution tracing, DAG merge, exports)

## Core Flows (mental model)
- Browse/login normally -> capture XHR/fetch -> generate skill (`SKILL.md`, `references/*`, `scripts/api.ts`)
- Marketplace: publish/download skills; backend can execute endpoints for tracing/verification.

## Commands (common)
- Root typecheck: `npm run typecheck`
- Plugin tests: `bun test packages/plugin/test/*.test.ts`
- Server build: `cd server && pnpm build`

## LAM / Tracing
- Backend trace capture: `POST /marketplace/endpoints/:endpointId/execute` stores `workflow_steps` + transitions.
- Dataset export: `server/scripts/export-lam-training.ts` (JSONL: traces/pairs/openai-chat).
- Optional API export (disabled by default): `GET /marketplace/traces/export` (requires `ENABLE_LAM_EXPORT=true`).

## Gotchas
- Skill dirs live under `~/.openclaw/skills/<service>/` (unless configured).
- Learning-on-the-fly needs `captureTraffic=true` (auto-forced in `unbrowse_browse` when required).
- If OpenClaw logs show `duplicate plugin id detected` for `unbrowse-openclaw`, you are loading two copies. Fix: keep exactly one source (dev path OR `~/.openclaw/extensions/*` install).

## Dev Pointers
- Plugin main tools: `packages/plugin/src/plugin/tools/`
- Skill generator + parser: `packages/plugin/src/skill-generator.ts`, `packages/plugin/src/har-parser.ts`
- Marketplace execute endpoint (trace capture): `server/src/server/routes/marketplace.ts`

## Quality
Bugs: add regression test when it fits.
