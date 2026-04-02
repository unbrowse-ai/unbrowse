---
name: internal-analytics
description: Internal-only workflow for reading or updating Unbrowse analytics from the repo/backend directly. Use when Lewis asks for analytics, investor metrics, retention, growth, usage, network, economics, acquisition, install funnel, ops dashboard reads, or analytics ingestion updates. Do not treat these analytics surfaces as public docs or public product API copy. Prefer the bundled fetch script for reads and `backend/src/routes/analytics.ts` as the route truth.
user-invocable: true
---

# Internal Analytics

Use this skill for:

- private analytics reads
- investor/product metric pulls
- ops dashboard checks
- analytics ingestion updates
- validating analytics auth or headers

Do not use this skill for:

- public docs
- landing-page/API-marketing copy
- public feature claims about analytics surfaces

Workflow:

1. Read [references/endpoints.md](./references/endpoints.md) for the current surface map.
2. For reads, prefer the helper:

```bash
bun skills/internal-analytics/scripts/fetch-analytics.ts usage dashboard
```

3. Override runtime only when needed:

```bash
UNBROWSE_BACKEND_URL=https://... \
UNBROWSE_API_KEY=... \
bun skills/internal-analytics/scripts/fetch-analytics.ts growth economics
```

4. If the route contract changed, update code truth first:
   - [backend/src/routes/analytics.ts](/Users/lekt9/.codex/worktrees/45e9/unbrowse/backend/src/routes/analytics.ts)
   - [tests/analytics-e2e.test.ts](/Users/lekt9/.codex/worktrees/45e9/unbrowse/tests/analytics-e2e.test.ts)
5. If you touch behavior, keep analytics private:
   - auth required
   - no public docs page
   - no public cache headers

Notes:

- Base URL defaults to `UNBROWSE_BACKEND_URL`, else `http://127.0.0.1:8787`.
- Auth defaults to `UNBROWSE_API_KEY`.
- If the key is missing, stop and ask for runtime/auth rather than guessing.
- For updates, use the same auth path and hit the explicit POST routes only.
