# Frontend Dashboard Plan — unbrowse.ai/dashboard (brownfield)

Plan for evolving the operator-facing dashboard at `https://www.unbrowse.ai/dashboard`. Covers earnings, payments, routes (public + private), and the privacy boundary that separates them.

> **Stack as it actually is**: Next.js 13+ App Router under `frontend/src/app/`, deployed via OpenNext-on-Cloudflare (per `wrangler.jsonc`). Auth via magic-link email + CLI pairing tokens, session in localStorage. Shared `ContributorDashboard` component renders both the auth-gated and public wallet views.

## Already wired vs greenfield

The single most important table in this plan: what exists today, what's a new addition.

| Surface / capability | Real path / file | Status | Data source today |
|---|---|---|---|
| Auth-gated dashboard landing | `/dashboard` → `frontend/src/app/dashboard/page.tsx` | **EXISTS** | `GET /v1/dashboard/me`, `GET /v1/account/me`, `GET /v1/account/preferences` |
| Public wallet dashboard | `/dashboard/[wallet]` → `frontend/src/app/dashboard/[wallet]/page.tsx` | **EXISTS** | `GET /v1/dashboard/wallet/:walletAddress` |
| Reusable dashboard component | `ContributorDashboard` (renders both gated + public via `view` flag) | **EXISTS** | passes through |
| Magic-link login + CLI pairing | `/login` → `frontend/src/app/login/page.tsx` + `frontend/src/lib/auth-context.tsx` | **EXISTS** | `POST /v1/auth/email/start`, `GET /v1/auth/email/poll`, `GET /v1/local/pair` |
| Auth context + session | `useAuth()` from `frontend/src/lib/auth-context.tsx` | **EXISTS** | localStorage key `unbrowse_auth` |
| API key generator | `frontend/src/components/api-key-generator.tsx` | **EXISTS** | `POST /v1/agents/register`, `GET /v1/tos/current` |
| Miners landing (atlas + leaderboard + registry tabs) | `/miners` → `frontend/src/app/miners/page.tsx` | **EXISTS** | `GET /v1/miners/stats`, `GET /v1/tos/current` |
| Leaderboard | `/leaderboard` → 301 to `/miners` | **EXISTS** (folded) | n/a — rendered inside `/miners` |
| Skill detail | `/skills/[id]` → `frontend/src/app/skills/[id]/page.tsx` (SSR) | **EXISTS** | `GET /v1/skills/:id` |
| Agent detail | `/agents/[id]` → `frontend/src/app/agents/[id]/page.tsx` (SSR) | **EXISTS** | `GET /v1/agents/:id` |
| Skills index page | `/skills` | **MISSING** | (would need new backend list endpoint) |
| Agents index page | `/agents` | **MISSING** | (would need new backend list endpoint) |
| Routes ▸ Public sub-section | inside `ContributorDashboard` | **GREENFIELD** | filter `dashboard.contributions` + new `u.listSkills({ publishedByWallet })` |
| Routes ▸ Private sub-section | inside `ContributorDashboard` | **GREENFIELD** | needs new `u.settings.publishBlacklist.list()` |
| Routes ▸ In Review sub-section | inside `ContributorDashboard` | **GREENFIELD** | needs new backend `GET /v1/admission/queue?agentId=…` |
| Workers (per-`clientId`) | inside `ContributorDashboard` | **GREENFIELD** | needs daily-bucketed rollup on existing `/v1/dashboard/me` |
| Wallet & Payouts sub-section | inside `ContributorDashboard` | **GREENFIELD** | needs new `u.payouts.history(agentId)` |
| Settings (blacklist editor, ToS confirms, API keys) | inside `ContributorDashboard` | **GREENFIELD** | reuses existing `api-key-generator.tsx` + new blacklist API |

> Naming I got wrong on first draft and corrected here: **`/wallet/[address]` → use real `/dashboard/[wallet]`. `/skill/[id]` → use real `/skills/[id]` (plural, exists already). `/leaderboard` → already a 301 to `/miners`. `/dashboard/me` → just `/dashboard`.**

## Audience

Three personas hit the same dashboard:

| Persona | Their question on landing |
|---|---|
| Solo operator | "How much did I earn yesterday and which routes drove it?" |
| Validator-fleet operator | "Which workers/domains are healthy, where is the marginal dollar, what's the unsettled balance?" |
| Auditor / partner | "Show me a public wallet's contribution — is this fleet legit?" |

> **Term note**: "validator" in this plan is shorthand for an agent that earns from captured routes (the contributor-pool sense used in onboarding docs). The whitepaper reserves "validator" for a future verification/staking role. See [`onboarding-validators.md`](./sdk/onboarding-validators.md) for the full caveat.

The split between gated `/dashboard` and public `/dashboard/[wallet]` already serves persona-1+2 vs persona-3. We're not adding new top-level routes — we're extending `ContributorDashboard` to answer all three views deeper.

## Information architecture (real paths only)

```
/dashboard                                  (auth-gated, exists)
  └─ ContributorDashboard view="private"
      ├─ Overview (exists)                  4-number block: earnings / unsettled / routes / browser-open rate
      ├─ Earnings (exists, partial)         drilldown table by skill — extend with sparklines
      ├─ Spending (exists, partial)         consumed routes — extend with by-domain rollup
      ├─ Routes ▸ Public (NEW)              skills you published, sortable
      ├─ Routes ▸ Private (NEW)             publish-blacklist domains, visually distinct
      ├─ Routes ▸ In Review (NEW)           admission queue items
      ├─ Workers (NEW)                      per-clientId attribution
      ├─ Wallet & Payouts (NEW)             settled vs unsettled, on-chain links
      └─ Settings (NEW shell, partial)      blacklist editor, ToS confirms, api-key-generator (already a component)

/dashboard/[wallet]                         (public, exists)
  └─ ContributorDashboard view="public"
      ├─ Overview (exists)
      ├─ Public skills published (exists, partial)
      └─ Lifetime earnings, anonymized (exists)

/miners                                     (public, exists)
  ├─ Coverage Atlas tab
  ├─ Top Contributors tab    (this is the leaderboard; /leaderboard 301s here)
  └─ Domain Registry tab

/skills/[id]                                (public SSR, exists)
/agents/[id]                                (public SSR, exists)
/login                                      (exists)

/skills (index)                             NOT BUILT — propose Phase 4
/agents (index)                             NOT BUILT — propose Phase 4
```

## Data sources (typed SDK only)

Everything reachable through `@unbrowse/sdk` 6.9.69423+ where possible. No shadow REST calls from the frontend.

| Page / section | Typed SDK call | Notes |
|---|---|---|
| `/dashboard` Overview + Earnings + Spending | `u.dashboard()` | existing call; bearer-gated via auth-context apiKey |
| `/dashboard` transactions drilldown | `u.creatorTransactions(agentId)` | new in 6.9.69423 |
| `/dashboard` indexer attribution panel (fleet only) | `u.indexerAttribution(indexerId)` | new in 6.9.69423 |
| `/dashboard/[wallet]` | `u.dashboardByWallet(walletAddress)` | new in 6.9.69423; no auth |
| `/skills/[id]` | `u.getSkill(id)` | already used SSR-side |
| `/agents/[id]` | `GET /v1/agents/:id` | currently raw fetch; consider typing as `u.getAgent(id)` |
| `/miners` Top Contributors tab | `GET /v1/leaderboard?limit=N` | currently raw; type as `u.leaderboard({ limit })` |
| Routes ▸ Public | needs new `u.listSkills({ publishedByWallet, lifecycle })` | SDK addition required |
| Routes ▸ Private | needs new `u.settings.publishBlacklist.{list,add,remove}` | SDK addition required |
| Routes ▸ In Review | needs new backend `GET /v1/admission/queue` + SDK wrapper | both ends |
| Workers | needs daily-bucket extension to `dashboard()` payload | backend change |
| Wallet & Payouts | needs new `u.payouts.history(agentId)` | SDK + backend |

## Privacy boundary, made visible

The single most important UX move stays from the prior draft, now applied to the existing `ContributorDashboard`:

- **Routes ▸ Private** sub-section uses a different background tint (cool neutral, NOT red — it's not an alert). A small lock icon in each row, and a sticky tab banner: *"These domains never reach the marketplace. Captures stay on this runtime only."*
- If a private route ever crosses into Public during admission, the operator sees it as a **visual** anomaly without needing to read copy.
- The boundary lives in the component, not the route. The route count stays flat.

## Auth model (already shipped)

- Magic-link email: enter email → `/v1/auth/email/start` → poll `/v1/auth/email/poll?token=…` → session.
- CLI pairing: CLI mints a short-lived token, dashboard exchanges via `/v1/local/pair`.
- Session stored in localStorage as `unbrowse_auth` (agentId, apiKey, email, userId).
- `useAuth()` exposes `isAuthenticated`, `agentName`, `apiKey`, `register`, `loginWithEmail`, `consumeMagicToken`, `pairLocalCli`, `logout`.
- API keys page is the existing `api-key-generator.tsx` — it's a component, lift it into `ContributorDashboard ▸ Settings`.

Don't propose OAuth or new token shapes; the magic-link + pairing flow is the standard.

## Build phases (brownfield deltas only)

> **Component path**: `frontend/src/components/contributor-dashboard.tsx` (currently 229 lines, accepts `view: "public" | "private"`).
>
> **Componentization warning**: five new sub-sections (Routes ×3, Workers, Wallet & Payouts) at typical density (~100-150 lines each) will push the file past 800 lines. Plan a sub-component split during Phase 2: extract `routes-public.tsx`, `routes-private.tsx`, `routes-in-review.tsx`, `workers-panel.tsx`, `wallet-payouts.tsx` so no single file exceeds ~400 lines. The current 229-line component stays the shell.

### Phase 1 — Routes + Workers extension (1 week)
Extend `frontend/src/components/contributor-dashboard.tsx` with three new sub-sections inside the existing route:
- Routes ▸ Public (uses existing `dashboard()` + a lightweight client-side filter; SDK addition for `listSkills` is nice-to-have but not blocking)
- Routes ▸ Private (read-only first; needs `u.settings.publishBlacklist.list()` only)
- Workers panel (per-`clientId` rollup of existing transactions)

### Phase 2 — Privacy editor + admission queue (1 week)
- Routes ▸ Private becomes editable (add/remove): requires new SDK methods + backend route to mirror `unbrowse settings --publish-blacklist`.
- Routes ▸ In Review: requires new backend `GET /v1/admission/queue?agentId=…`.
- Visual distinctness pass on Private (cool-neutral tint, lock icon, sticky banner).

### Phase 3 — Wallet & Payouts (1 week)
- Settled vs unsettled timeline.
- On-chain settlement links (Solana explorer).
- CSV export.
- Requires new SDK + backend payouts history endpoints.

### Phase 4 — Index pages (optional, when traffic justifies)
- `/skills` index, `/agents` index.
- SEO-cached at edge.

### Phase 5 — Polish
- Daily-earnings sparkline (requires `dashboard()` daily-bucket extension on backend).
- Mobile layout pass.
- Settings page consolidation (move `api-key-generator` from standalone usage into Settings shell).

## SDK additions this plan depends on

These are NEW typed methods to add to `packages/sdk/src/client.ts` ahead of Phase 2:

```ts
u.listSkills({ publishedByWallet?, domain?, lifecycle? })
u.leaderboard({ window?, limit? })
u.getAgent(agentId)
u.settings.publishBlacklist.list()
u.settings.publishBlacklist.add(domain)
u.settings.publishBlacklist.remove(domain)
u.payouts.history(agentId)
u.admissionQueue(agentId)   // for Routes ▸ In Review
```

Backend additions required for Phase 2-3 (these do NOT exist yet — proposed surfaces):

<!-- validator:skip-routes-below -->
- `GET /v1/admission/queue?agentId=…`
- `POST /v1/settings/publish-blacklist` + `DELETE /v1/settings/publish-blacklist/:domain` + `GET /v1/settings/publish-blacklist`
- `GET /v1/payouts/:agentId`
- Optional: `dashboard()` payload extension to include daily buckets (`?include=daily`)
<!-- /validator:skip-routes-below -->

- `/dashboard` initial paint < 300ms cold (P95). The backend's `buildDashboard` already caches 30s.
- Routes lists must paginate; don't load 1000 skills at once.
- `/dashboard/[wallet]`, `/skills/[id]`, `/agents/[id]` are SSR-cached at edge for SEO + scale.

## What we're explicitly NOT building

- In-dashboard wallet creation (Lobster handles that, link out).
- In-dashboard SDK code editor / sandbox.
- Notifications / email alerts on earnings thresholds.
- Multi-tenant team views (single-wallet for now).
- Real-time websockets. Poll on focus + every 60s.

## Design discipline (CLAUDE.md global)

- OKLCH neutrals, tinted toward the brand hue. No `#000` / `#fff`.
- One accent + one neutral hierarchy. Private vs Public uses the neutral hierarchy, not a second accent.
- No identical card grids — the four-number block is a row, not 4 cards.
- No glassmorphism, no gradient text, no side-stripe borders.
- 65-75ch line cap on long-form (skill detail descriptions).
- Motion: 200-300ms ease-out-quart on tab switches; transform/opacity only.

## Concrete next steps

1. **Audit `ContributorDashboard`** — find the existing sub-section seams and decide whether new sub-sections are tabs, accordion, or stacked cards.
2. **Add the SDK methods** listed above (one PR; gated behind 6.9.69424).
3. **Phase 1 ships entirely without backend changes** — start there.

## See also

- [SDK API reference: rewards](../packages/sdk/docs/api-reference/rewards.md)
- [Build on Unbrowse](./sdk/build-on-unbrowse.md) — the broader builder context
- [Rewards & economics](./sdk/rewards-and-economics.md) — the model the dashboard renders
- [Open source notice](./OPEN-SOURCE-NOTICE.md)
