# Unbrowse Frontend

The frontend is the public Next.js landing page for [unbrowse.ai](https://www.unbrowse.ai). It is built with Next.js App Router and deployed to Cloudflare Workers through OpenNext.

## Install

From the monorepo root:

```bash
bun install --frozen-lockfile
```

## Develop

Run the Next.js development server:

```bash
cd frontend
npm run dev
```

The app is available at [http://localhost:3000](http://localhost:3000).

## Preview the Cloudflare runtime

To preview the Worker build locally:

```bash
cd frontend
npm run preview
```

## Deploy

The production frontend is deployed as a Cloudflare Worker via OpenNext, not as a Cloudflare Pages `dist/` upload.

```bash
cd frontend
npm run deploy
```

That command runs `opennextjs-cloudflare build` followed by `opennextjs-cloudflare deploy`, using `frontend/wrangler.jsonc` for the worker name, routes, and bindings.

## Key files

- `frontend/src/app/` — app routes and pages
- `frontend/src/components/` — landing page UI
- `frontend/public/` — static assets such as `robots.txt` and `llms.txt`
- `frontend/wrangler.jsonc` — Cloudflare Worker deployment config
- `frontend/open-next.config.ts` — OpenNext Cloudflare config
