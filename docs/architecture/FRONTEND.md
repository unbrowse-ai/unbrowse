# Frontends

> Two apps. `frontend/` (in this monorepo) is the canonical product UI at
> `unbrowse.ai`. `unbrowse-dashboard` (sibling repo) is a public, read-only
> metrics page at `launch.unbrowse.ai` and does not talk to the backend.

## A. `frontend/` — product UI (unbrowse.ai)

### Stack & deploy
- Next.js 16 App Router, React 19, TypeScript (`frontend/package.json`).
- Cloudflare Workers via open-next (`frontend/wrangler.jsonc`), zones
  `unbrowse.ai` and `www.unbrowse.ai`, staging + experiments envs, R2
  incremental cache.
- Backend base URL `https://beta-api.unbrowse.ai`, overridable with
  `NEXT_PUBLIC_API_URL` (`frontend/src/lib/api-base.ts`).

### Route map (`frontend/src/app/`)
| Route | Purpose |
|---|---|
| `/` | Skill registry: search, popular skills, marketing sections (`page.tsx`) |
| `/search` | Intent-based skill discovery |
| `/skill/:id` | Skill detail |
| `/aiko` | Conversational chat that executes skills |
| `/login` | Magic-link email sign-in (`login/page.tsx`) |
| `/account` | Account hub & onboarding wizard |
| `/account/wallet` | Solana wallet pairing for x402 settlement (`account/wallet/page.tsx`) |
| `/account/session-key` | Session & API key display |
| `/account/escrow`, `/account/cookies` | Advanced settings |
| `/dashboard` | Authed: agent stats, execution history, preferences (`dashboard/page.tsx`) |
| `/dashboard/:wallet` | Public per-wallet earnings/ledger view |
| `/billing` | Sponsored-tier status and pay-per-request explanation (`billing/page.tsx`) |
| `/docs`, `/faq`, `/contact`, `/privacy`, `/terms`, `/security`, `/classic` | Docs/legal/marketing |
| `/compare/:slug`, `/vs/:slug` | SEO comparison pages |
| `/ops` | Internal ops view (auth required) |
| `/[domain]` | Dynamic per-domain proxy/capture pages |

### Auth
- Magic-link only (no passwords): email → `POST /v1/agents/login` → token
  polling → `POST /v1/agents/token/consume` returns
  `{api_key, agent_id, user_id, email}` (`frontend/src/app/login/page.tsx`,
  `frontend/src/lib/auth-context.tsx`).
- Session = `localStorage["unbrowse_auth"]` holding the API key and agent
  identity; all authed fetches send `Authorization: Bearer <api_key>`.
  There is no server session cookie and no Next.js middleware gate — auth
  checks are client-side via `useAuth()`.
- CLI↔web pairing: `GET /v1/local/pair?token=…`.
- Optional Privy embedded-wallet provider is dynamically imported and
  feature-gated (`frontend/src/lib/privy-provider.tsx`).

### Billing & wallet UI
- `/billing` shows the sponsored allowance (calls
  `GET /v1/account/sponsor-status`) and explains the per-request USDC
  settlement model; the card-subscription checkout flow is backend-driven
  (`/v1/billing/checkout`) and not currently surfaced as a Stripe pricing
  page in this UI.
- `/account/wallet` pairs an external Solana wallet (manual address entry or
  Privy modal). Transaction signing/broadcast is **not** done in the
  frontend — it happens CLI-side or backend-side.
- API keys: created implicitly at registration; displayed at
  `/account/session-key`. There is **no create/revoke key management UI**
  yet (the backend endpoints exist — see gap list).

### Backend contract used by the UI (`frontend/src/lib/api.ts`)
- Auth/profile: `POST /v1/agents/register`, `POST /v1/agents/login`,
  `POST /v1/agents/token/consume`, `GET /v1/agents/me`, `GET /v1/agents/:id`
- Skills: `GET /v1/skills` (+card view), `GET /v1/skills/popular`,
  `GET /v1/skills/:id`, `POST /v1/search`, `POST /v1/search/domain`
- Stats/dashboard: `GET /v1/stats/summary`, `GET /v1/dashboard/me`
- Account: `GET /v1/account/me`, `GET/POST /v1/account/preferences`,
  `GET /v1/account/sponsor-status`
- Misc: `GET /v1/tos/current`, `GET /v1/ops`

## B. `unbrowse-dashboard` — public metrics (launch.unbrowse.ai)

- Next.js 16 on Cloudflare Pages (`unbrowse-dashboard/wrangler.toml`);
  single page (`src/app/page.tsx`) auto-refreshing every 60s from its own
  edge route `GET /api/metrics` (`src/app/api/metrics/route.ts`).
- **No auth, no billing, no wallet** — read-only public showcase.
- Data sources (server-side only; secrets never reach the client —
  `src/lib/api.ts`):
  - Unkey API: key list + verification analytics (DAU/WAU, retention,
    outcomes)
  - GitHub API: stars/forks/watchers for the public repo
  - npm API: package download counts (CLI + integration plugin)
  - Cloudflare Analytics: env vars wired but not yet queried
- Known placeholders are listed in `unbrowse-dashboard/MISSING_DATA.md`
  (geo distribution, endpoint breakdown, latency percentiles, etc.).
- Relationship: complementary, zero coupling — different domain, different
  data sources, no calls to `beta-api.unbrowse.ai`.

## Gaps observed (frontend)
1. No API-key management UI (create/rename/revoke) despite backend support.
2. No Stripe pricing/checkout page in the UI; subscription purchase relies
   on backend endpoints being called from elsewhere (CLI/dashboard link).
3. Client-side-only auth gating (`localStorage`) — acceptable for an
   API-key product but means authed pages render a shell before redirect.
4. Privy wallet path feature-gated and incomplete (matching the backend's
   unimplemented signing endpoint).
