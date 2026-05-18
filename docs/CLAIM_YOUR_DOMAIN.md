## Why claim

If you run the domain that unbrowse is indexing, every paid call to a skill that talks to your domain routes you 20% of the price.

The carve is `OWNER_BPS = 2000` (added beside `PLATFORM_BPS` at `backend/src/services/flex.ts:39`). It fires inside `computeFlexSplits` when two conditions hold: the skill carries `owner_compensation_opt_in === true` (`backend/src/types.ts:437`) AND a verified `owner_wallet_usdc_ata` exists, hydrated from the `domain-wallet:<domain>` KV binding at resolve time. Both conditions are server-owned; you cannot fake them via the publish API.

No claim is needed for the platform to serve traffic to your site. You only claim when you want a share of the revenue.

## What to put on your DNS

A TXT record at `_unbrowse-claim.<apex-domain>`.

Value format:
```
unbrowse-claim=<challenge>;wallet=<your-wallet>
```

Where `<challenge>` is the 32-byte hex string the API mints for you, and `<your-wallet>` is the base58 Solana pubkey you want to bind. The contract is fixed at `.claude/firmament-step2.md:42-43, 168`.

Apex domains only in v1. If you run `news.ycombinator.com`, the record goes on `ycombinator.com` (the apex) at the name `_unbrowse-claim.ycombinator.com`. Subdomain-level claims are deferred (`.claude/firmament-step2.md:183`).

## The flow

1. Visit `/claim` on unbrowse.ai. (Frontend page not yet shipped; the backend endpoints work today via curl.)
2. Paste the apex domain you want to claim.
3. Paste the Solana wallet that should receive payouts.
4. The page calls `POST /v1/claim/challenge` with your domain and wallet (`backend/src/routes/claim.ts`). The response carries `challenge`, `txt_name`, `txt_value`, and `expires_at`. The challenge is good for 24 hours.
5. Publish the TXT record at your DNS provider. Name: `_unbrowse-claim.<apex>`. Value: exactly the `txt_value` from the response.
6. Wait for propagation (typically 1 to 5 minutes for most providers).
7. Click verify. The page calls `POST /v1/claim/verify`. The server resolves the TXT through two DoH providers in parallel and, if both agree, writes the binding to `domain-wallet:<domain>` KV (`.claude/firmament-step2.md:51-67`).
8. From the next paid execute against any skill on the domain, the 2000 bps lane is live.

You can check status any time, without auth:
```
GET https://beta-api.unbrowse.ai/v1/claim/status?domain=<your-domain>
```

## What you need

- A Solana wallet. lobster.cash is the recommended provisioner (`frontend/src/app/how-unbrowse-pays/page.tsx:205-227`), but any signer that exposes a base58 pubkey and an SPL USDC ATA works. The verify step accepts the wallet pubkey; the USDC ATA is derived server-side.
- DNS edit access on the apex domain. Cloudflare, Route53, Namecheap, Google Domains, anything that lets you publish a TXT record.

## Anti-spoofing rules

- **The wallet is part of the TXT value.** `unbrowse-claim=<challenge>;wallet=<wallet>` means a leaked TXT cannot be replayed against a different wallet. The verify endpoint reconstructs `txt_value` server-side from the stored challenge and compares byte for byte (`.claude/firmament-step2.md:175`).
- **Two independent DoH resolvers must agree.** Cloudflare (`https://cloudflare-dns.com/dns-query`) and Google (`https://dns.google/resolve`) are both queried in parallel. Both must return the matching TXT. A single-provider success is rejected, which makes hostile-network MITM a two-target attack instead of one (`.claude/firmament-step2.md:17, 132-140`).
- **The challenge is tuple-scoped.** The KV key is `domain-claim-challenge:<domain>:<wallet>`, so a TXT you minted for one wallet cannot be used to verify a different one (`.claude/firmament-step2.md:34-35`).
- **Rate limit.** 10 challenge mints per hour per domain (`.claude/firmament-step2.md:72`).
- **Caller must own the wallet.** The verify endpoint requires the caller's agent wallet (looked up server-side from the API key) to equal the `wallet_address` parameter (`.claude/firmament-step2.md:174`).

## What if you change wallets later

Re-verify with the new wallet. The binding does not follow you; the old binding stays until the new claim overwrites it (`.claude/firmament-step2.md:180`).

Mint a new challenge for the same domain and the new wallet, publish the new TXT value, click verify. The old TXT can be deleted once the new binding is confirmed.

## What if you lose your domain

Bindings do not auto-expire. We cannot detect a domain transfer reliably, so the binding stays until someone re-verifies.

The new owner attempts a claim with their wallet, hits `409 wallet_conflict` (`.claude/firmament-step2.md:114, 181`), and contacts support. Admin clears the old binding after the new owner re-publishes a TXT under their wallet. v2 will land an admin route for self-service; v1 is manual.

## Out of scope for v1

- Subdomain-level claims (`.claude/firmament-step2.md:183`).
- Cross-chain wallets. Solana base58 only (`.claude/firmament-step2.md:191`).
- Multi-owner splits. One wallet per domain (`.claude/firmament-step2.md:194`).
- Scheduled re-verification. Once verified, the binding holds until overwritten (`.claude/firmament-step2.md:196`).
