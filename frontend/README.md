# Unbrowse Frontend

Marketing site, docs entrypoints, blog, public wallet dashboard, and leaderboard for Unbrowse. Built with Next.js 16 and deployed to Cloudflare via OpenNext.

## Read first

- public companion docs: [docs.unbrowse.ai](https://docs.unbrowse.ai)
- frontend worker config: [wrangler.jsonc](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/wrangler.jsonc)
- default API origin: [frontend/.env.production](/Users/lekt9/.codex/worktrees/c99f/unbrowse/frontend/.env.production)

## Local development

From repo root:

```bash
bun install --frozen-lockfile
cd frontend
bun run dev
```

App runs on `http://localhost:3000` by default.

## Useful commands

```bash
bun run dev
bun run build
bun run preview
bun run deploy
```

- `preview` runs the OpenNext Cloudflare preview path
- `deploy` builds with OpenNext and deploys the worker/assets to Cloudflare
- `deploy:ci` builds with OpenNext and deploys via Wrangler without pre-populating the R2 incremental cache

## API wiring

The frontend defaults to:

```bash
NEXT_PUBLIC_API_URL=https://beta-api.unbrowse.ai
```

That value is used by dashboard, leaderboard, blog, and other runtime fetch surfaces unless overridden.

## Main surfaces

- `/` — main marketing page
- `/search` — registry browsing
- `/dashboard` and `/dashboard/:wallet` — public contributor/economics views
- `/leaderboard` — contribution ranking
- `/skill.md` — agent-facing markdown summary
- `/llms.txt` and `/llms-full.txt` — crawler/LLM-readable discovery docs

## Docs linking policy

Prefer the external docs site for reader-facing documentation:

- `https://docs.unbrowse.ai`

Keep FE docs/navigation pointing there for canonical narrative docs. Keep `/skill.md` for agent-readable install/CLI guidance.
