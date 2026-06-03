# Claiming a Website

How a site operator proves they own a domain and starts earning the 15% owner lane on every paid call to Unbrowse skills that talk to it.

## Why claim

Unbrowse marketplace skills capture the public APIs your site already serves. When agents call those skills, the price settles on-chain as a three-way [fare split](fare-splits.md). The 15% **owner lane** routes to a Solana wallet you control — but only after you've proven the domain is yours via a DNS TXT record. Until then, the 15% folds back into the indexer pool.

You claim a domain once. Future paid calls to any skill whose `domain` matches your verified apex carry your wallet as a recipient in the on-chain split, atomically, in the same transaction the platform and indexers get paid.

## What you need

- **A Solana wallet.** [lobster.cash](https://lobster.cash) is the recommended provisioner (the substrate never holds private keys), but any signer that exposes a base58 pubkey and an SPL USDC ATA works. The verify step accepts the wallet pubkey; the USDC ATA derivation is deferred to a follow-up.
- **DNS edit access on the apex domain.** Cloudflare, Route53, Namecheap, Google Domains — anything that lets you publish a TXT record at `_unbrowse-claim.<your-apex>`.

## The flow

1. Visit `/claim` on the Unbrowse frontend.
2. Paste your apex domain (e.g. `example.com`, not `www.example.com`). Subdomains are deferred to v2.
3. Paste your Solana wallet address. The verify step refuses to bind the domain to any wallet other than the one in the request.
4. Click **Get challenge**. The backend mints a one-time challenge and shows you the TXT record to publish:
   - **Name:** `_unbrowse-claim.example.com`
   - **Value:** `unbrowse-claim=<32-byte hex>;wallet=<your wallet>`
5. Publish that TXT record at your DNS provider. Wait a minute or two for global propagation.
6. Click **Verify**. The backend calls Cloudflare's DNS-over-HTTPS resolver AND Google's DNS-over-HTTPS resolver in parallel. Both must independently return your TXT record, byte-for-byte, before the binding lands.
7. On success, the `domain-wallet:<your-domain>` KV row is written, and a post-verify stamping hook walks every published skill for your domain and stamps:
   - `owner_compensation_opt_in = true`
   - `owner_wallet_address = <your wallet>`
   - `owner_wallet_usdc_ata = <your wallet>` (USDC ATA derive deferred)
   - `owner_wallet_verified_at = <verify timestamp>`
8. The next paid call against any of those skills routes 15% (1500 bps) to your wallet via Faremeter Flex.

The whole flow is documented in code at `backend/src/routes/claim.ts` and `backend/src/services/domain-claim-effects.ts`.

## Anti-spoofing rules

- **The wallet is part of the TXT value.** A stolen or leaked TXT cannot be replayed against a different wallet — the value itself embeds the wallet. The verify endpoint reconstructs `txt_value` server-side from the stored challenge and compares byte-for-byte; it never trusts a client-supplied value.
- **Dual-DoH agreement.** Cloudflare's resolver is signed, but a hostile-network MITM could intercept. Cross-checking with Google makes that a two-target attack. Single-provider success returns `partial_propagation` (soft retry); both unreachable returns `doh_unreachable` (502).
- **Tuple-scoped challenge KV.** Two pending claims for the same domain by two different wallets coexist. Verifying one does NOT consume the other. Challenge key is `domain-claim-challenge:<domain>:<wallet>`, not domain-scoped.
- **Rate limit.** No more than 10 challenge mints per domain per hour. Prevents an attacker from churning challenges to spam your DNS UI.
- **Caller's agent wallet must match.** A third party cannot verify your published TXT and bind it to a wallet they own — the verify endpoint requires the calling agent's wallet to equal the `wallet_address` parameter.
- **Server-owned binding fields.** `owner_wallet_*` fields on `SkillManifest` are server-stamped only. `PATCH /v1/skills/:id` rejects any user-supplied value.

## What if you change wallets later

Re-verify with the new wallet. The binding is `domain → wallet`, not `domain → user`. The post-verify stamping overwrites the previous owner fields on every matching skill.

## What if you lose your domain

Bindings do not auto-expire — Unbrowse cannot detect a registrar transfer. The new owner mints a fresh challenge with their wallet and runs verify. This produces a `409 wallet_conflict` against the existing binding; the new owner contacts support to clear it.

## What you can also do via `/claim`

- **Opt out of the marketplace entirely.** Same DNS-TXT primitive with a different value (`unbrowse-takedown=<challenge>`). Verify flips `lifecycle: "disabled"` on every existing skill for your domain AND writes a persistent `domain-optout:<domain>` KV row that blocks future captures from ever publishing.
- **Submit your official API.** A form on `/claim` posts to `POST /v1/claim/submit-official` with your canonical x402-supported endpoints. The team triages and promotes approved submissions to `verification_status: "verified"` with an `owner_submitted: true` provenance flag so they rank above captured endpoints. There's also a `mailto:hello@unbrowse.ai` fallback if you prefer email.

## Related

- [Fare Splits](fare-splits.md) — how the three on-chain lanes are computed
- `backend/src/services/domain-claim.ts` — the DoH verifier + KV key shapes
- `backend/src/services/domain-claim-effects.ts` — the post-verify owner-wallet stamping hook
- `backend/src/routes/claim.ts` — the HTTP surface
