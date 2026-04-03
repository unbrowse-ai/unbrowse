# funnel-merjs

Standalone `merjs` visual surface for the full Unbrowse funnel.

## What it shows

- campaign / content -> landing
- landing -> install-copy
- install -> cli -> registration -> first success
- canonical product funnel: registered -> activated -> aha -> repeat -> retained d7 -> retained d30
- top ICPs, sections, and joined campaign rows
- `/json-render` mounts the real `@json-render/react` renderer inside the merjs shell and turns arbitrary JSON into a spec-driven UI workbench

## Run

```bash
cd /Users/lekt9/.codex/worktrees/81eb/unbrowse/visualizers/funnel-merjs
cp .env.example .env
zig build serve
```

Default URL: `http://127.0.0.1:3011`

Desktop wrapper:

```bash
cd /Users/lekt9/.codex/worktrees/81eb/unbrowse/visualizers/funnel-merjs
zig build desktop
open zig-out/UnbrowseVisualLab.app
```

Routes:

- `/` — direct funnel screen
- `/json-render` — json-render lab, desktop-wrapper friendly
- `POST /api/viz` — create a session-backed visualization from arbitrary JSON or a live analytics snapshot
- `GET /api/viz?id=...` — inspect saved session JSON
- `GET /viz?id=...` — render the saved session as a fluid analytics board

## Notes

- `UNBROWSE_API_KEY` is required for private analytics routes.
- The page fetches from its own local `GET /api/snapshot`, which proxies the backend analytics surfaces with bearer auth.
- The practical skill contract is `payload -> POST /api/viz -> open /viz?id=...`.
- To let the merjs app pull live analytics itself, post:

```bash
curl -X POST http://127.0.0.1:3011/api/viz \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "analytics_snapshot",
    "kind": "analytics_snapshot",
    "prompt": "show biggest funnel leaks by campaign and ICP",
    "days": 30,
    "view_hints": ["funnel", "campaigns", "icp"]
  }'
```

- To visualize arbitrary JSON from the skill, post:

```bash
curl -X POST http://127.0.0.1:3011/api/viz \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "show anomalies and biggest conversion drops",
    "view_hints": ["funnel", "table", "segments"],
    "payload": { "stages": [], "campaigns": [], "retention": {} }
  }'
```

- Native X impression / engagement stats are still only as good as the upstream campaign sync; the visualizer starts at the measurable join we already have.
- The shell is merjs. The json-render route uses client-side ESM imports for `react`, `@json-render/core`, and `@json-render/react`, so the same route can sit inside merjs desktop `WKWebView` without Next/Vite/Electron.
- The json-render lab accepts pasted JSON, dropped `.json` files, and shareable hash-state URLs for prompt + payload bootstrapping.
- `zig build desktop` packages a native macOS app wrapper around the same merjs routes, so `/viz?id=...` and `/json-render` both run in the app without Electron.
