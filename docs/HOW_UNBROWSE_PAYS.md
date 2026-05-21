## What this document is

This page explains how money moves through unbrowse on every paid call. The math, the splits, the wallet ownership, and the rails. Every claim cites a file and line in the codebase.

## The 50/35/15 split

Every paid `unbrowse execute` settles on-chain through a Faremeter Flex authorization with up to five recipients in one transaction.

- **Platform: 50%.** `PLATFORM_BPS = 5000` at `backend/src/services/flex.ts:39`. This share funds the substrate (resolve, marketplace, facilitator). Can be overridden per deployment via the `FLEX_PLATFORM_BPS` env var, range 0 to 10000.
- **Site owner: 15%.** `OWNER_BPS = 1500` (added beside `PLATFORM_BPS` in `backend/src/services/flex.ts`). Routed only when the domain has been DNS-claimed and the skill carries `owner_compensation_opt_in === true` (`backend/src/types.ts:437`) together with a verified `owner_wallet_usdc_ata`.
- **Indexer pool: 35%.** The remaining 3500 bps when a site owner is bound. Split across `skill.contributors[]` weighted by `cumulative_delta` (`backend/src/services/flex.ts:65-74`), then deduped with `mergeSplits` (`backend/src/services/flex.ts:98-113`) because the Flex on-chain program rejects duplicate recipients.
- **No site owner claimed: 50% platform, 50% indexer pool.** When `owner_compensation_opt_in` is false or no DNS claim exists, the carve falls through. `contributorPool = 10000 - PLATFORM_BPS = 5000` bps (`backend/src/services/flex.ts:66`).

The split is capped at `FLEX_MAX_SPLITS = 5` (`backend/src/services/flex.ts:40`). The top four contributors by `cumulative_delta` take the contributor pool when unclaimed; the top three when a site-owner lane is active.

## Per-skill markup (5 to 80 percent)

Every `SkillManifest` carries an optional `markup_bps` field (Pontus / ABK Labs brief 2026-05-21: "5-80% markup potential on Flex"). When set, it overrides the default `PLATFORM_BPS = 5000` for that specific skill's settlements. The clamp is enforced server-side at `backend/src/services/flex.ts:48-49` (`MARKUP_BPS_MIN = 500`, `MARKUP_BPS_MAX = 8000`); values outside the range snap to the nearest bound.

What the agent sees: `markup_bps` shifts the platform's bps share, NOT the owner or indexer math. The owner lane stays at `OWNER_BPS = 1500` when DNS-claimed; the contributor pool absorbs the residual.

Concrete examples (owner claimed, default OWNER_BPS=1500):

- `markup_bps = 500` (the floor, 5% platform) -> 5% platform, 15% owner, 80% indexers.
- `markup_bps = 5000` (the unset default, 50% platform) -> 50% platform, 15% owner, 35% indexers. This is the canonical case above.
- `markup_bps = 8000` (the ceiling, 80% platform) -> 80% platform, 15% owner, 5% indexers.

When no owner is claimed, the residual flows entirely into the contributor pool, so a `markup_bps = 500` skill gives indexers 95% of every paid call. A premium-content skill that wants to fund the platform aggressively can dial up to 8000.

The field is set at publish time (`PublishSkillInput.markup_bps` on the SDK and CLI) and is per-skill, not per-call. Skills with no value continue to settle at the documented 50/35/15.


## Indexer earnings

When you use unbrowse to call a website nobody has indexed yet, the act of resolving and executing CAPTURES the underlying API. You become the indexer of that skill, recorded as `indexer_id` on the `SkillManifest` (`backend/src/types.ts:409`).

From that point forward, every paid `execute` against the same skill, by any agent, routes you a share. Your wallet address lives on the `SkillContributor` row that the publish handler attaches (`backend/src/types.ts:516-531`). At settlement, `computeFlexSplits` reads `skill.contributors`, filters entries with a non-empty `wallet_address`, weights by `cumulative_delta`, and produces the Flex split array (`backend/src/services/flex.ts:54-87`).

Payouts land in the same on-chain transaction as the platform's. There is no escrow, no nightly batch, no opt-in to be paid.

## Site owner earnings

If you run the domain that unbrowse is indexing, you can claim 15% of every paid call to that domain's skills.

The claim is a DNS-TXT record. The verifier resolves `_unbrowse-claim.<apex>` through two independent DoH providers (Cloudflare and Google), both must return a TXT whose value is `unbrowse-claim=<challenge>;wallet=<your-wallet>`. The contract is described in `.claude/firmament-step2.md` lines 86-176 and implemented under `backend/src/routes/claim.ts` and `backend/src/services/domain-claim.ts`.

The skill must also carry `owner_compensation_opt_in === true` (`backend/src/types.ts:437`). The publish handler sets this when the indexer or owner explicitly opts in. The OWNER_BPS lane fires only when both conditions hold: the opt-in flag is true AND `owner_wallet_usdc_ata` resolves from the `domain-wallet:<domain>` KV binding.

See `docs/CLAIM_YOUR_DOMAIN.md` for the step-by-step.

## Payment provider choice (pay.sh / lobster.cash / Privy / external)

The substrate never holds private keys; you bind a signer at `unbrowse setup`. As of 2026-05-21 there are four supported providers selectable from the CLI prompt and the `/account` web page (`POST /v1/account/payment-provider` persists the choice; `backend/src/services/flex.ts` honours it on dispatch).

- **pay.sh** -- TouchID-backed signer, USDC settlement via x402 MPP / search_catalog. The thinnest path for laptop agents; the wallet lives in the macOS keychain. The CLI bridge is `src/payments/paysh-pay.ts` (shells to `pay curl <url>` on each settle).
- **lobster.cash** -- Crossmint-backed credit-card -> virtual-card -> Solana funnel. The recommended path for non-technical users; subscription billing tops up the wallet automatically. `npx @crossmint/lobster-cli setup` provisions the account.
- **Privy embedded** -- Solana wallet provisioned in-browser via Privy. Bound to the user's `agent.wallet_address` after `verifyPrivyAuthToken` succeeds (`backend/src/services/privy.ts`). The right answer when the agent runs as a web app and the user signs in with email or OAuth instead of installing a CLI.
- **External wallet** -- bring your own Solana signer. The substrate emits an x402 envelope; any wallet that can sign a Faremeter Flex authorization works.

The choice is reversible: `unbrowse setup` re-runs the prompt, or POST a new provider to `/v1/account/payment-provider`. The selected provider gates the runtime dispatch path; the on-chain split math (above) is identical across providers.

## Wallets stay with lobster.cash

The substrate never holds private keys. The frontend recommends lobster.cash as the payout wallet (the live `/how-unbrowse-pays` page renders from `docs/HOW_UNBROWSE_PAYS.md` via `frontend/src/lib/docs-renderer.ts`): `npx @crossmint/lobster-cli setup` provisions a Solana account, lobster signs, unbrowse only declares intent, amount, recipient, and memo. If you want a different signer, the payment terms are plain x402; any wallet that can sign a Faremeter Flex authorization works.

## x402 is the main rail

Settlement runs on the x402 standard. unbrowse rotates between two facilitators per request:

- **Flex** (default). Self-hosted Faremeter facilitator with native splits. The 50/35/15 math above runs on Flex. Selection logic at `backend/src/services/rail-rotation.ts`.
- **PayAI exact** (rotation fallback). Single-recipient. Does NOT carry splits, so when PayAI wins the rotation the contributor and owner pools settle off-rail (deferred until a Flex-rail transaction). `PAYAI_ROTATION_BPS` env (default 5000) controls the weight; the hash of `agent_id` decides which rail's accept entry comes first in the 402 envelope.

Stripe optionally wraps either rail for fiat-billed customers, but the underlying on-chain split is unchanged.

## No account required to pay

Agents pay per call. The x402 response carries the price, recipient, and memo. The caller signs and the facilitator settles. There is no signup, no API key gate on the pay path.

Accounts exist for one reason: to accumulate and read earnings. The magic-link flow at `backend/src/routes/auth.ts:53-172` issues an API key and an agent_id; the agent_id is what we attribute contributions to. You can use unbrowse without ever creating one; you just can't see a balance until you do.

## Anti-reverse-engineering: server-bound execution

The unbrowse marketplace is the moat: a CLI binary lifted from npm and run standalone still has local capture / extraction code, but without server-issued search + skill access the agent loses the intelligence layer it needs to be useful.

To enforce this server-side (Wave 1 shipping 2026-05-22):

- Every marketplace API call (`/v1/search`, `/v1/search/endpoints`, `/v1/skills/*`) is gated on a per-session HMAC token mint at `POST /v1/session/exec-token`.
- The token mint requires the caller to send `{ build_sha, deployed_at }` matching either the CURRENT server's `/v1/version` triple OR a tuple CI previously registered via the admin-gated `POST /v1/internal/register-build`.
- Tokens are signed with `RELEASE_MANIFEST_SIGNING_SECRET` (the same secret that signs `/v1/version`) and bound to `{ agent_id, build_sha, deployed_at, exp }`. Constant-time HMAC compare on verify.
- Patching the CLI to skip token injection is fine, but every marketplace call then returns `401 error_code=missing_token`. The binary still runs locally; it just has no intelligence layer behind it.
- Reverse-engineered or hand-built binaries cannot self-register a `(build_sha, deployed_at)` tuple because the registration route is `ADMIN_KEY`-gated and only the CI release workflow has that key.

Substrate-faithful: tokens carry actionable next_step (`run \`unbrowse update\` to get a CI-signed build`) and the gate refuses on `secret_unconfigured` rather than fake-passing. See `backend/src/services/exec-token.ts` for the canonical contract and `backend/tests/exec-token.test.ts` for the 10 locked invariants.

## What this is not

- Not a custodial wallet. Funds never sit in an unbrowse account.
- Not a marketplace fee on capture. We charge on execute, not on publish.
- Not a subscription. There is no monthly plan; every paid call is its own settlement.
- Not a cross-chain bridge. Solana USDC only; the on-chain mint is hardcoded at `backend/src/services/flex.ts:44`.
