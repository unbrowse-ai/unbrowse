# Domain opt-out

## The rule

A site owner can remove their domain from Unbrowse's index by proving ownership of the domain. Proof is mechanical (a DNS TXT record or a `.well-known/unbrowse-optout` file). Once verified, all skills indexed against that domain are deprecated, no further routes are stored, and incoming resolves return a "domain opted out" hint to the agent.

## Why we built this

An agent indexing the public web inevitably crosses paths with sites that prefer not to be aggregated. We do not assert the right to ignore that preference. We assert the right to require proof of ownership before honoring the removal, so an opt-out cannot be triggered against a domain by a non-owner.

## How a site owner triggers it

Two proof methods, either is sufficient.

### DNS TXT method

```
_unbrowse-optout.<domain>  TXT  "verified-owner=true"
```

The owner adds the TXT record. They visit `https://unbrowse.ai/opt-out` and enter the domain. The backend resolves the TXT record. If present, the domain enters the opted-out set.

### Well-known file method

```
https://<domain>/.well-known/unbrowse-optout
```

The file contains the literal string `verified-owner=true`. The owner visits `https://unbrowse.ai/opt-out` and enters the domain. The backend fetches the file. If present and correct, the domain enters the opted-out set.

## What happens after opt-out

1. Every skill in the marketplace tagged to that domain is marked `deprecated_by_opt_out`. Existing agents that hold a reference to the skill see the deprecation flag on next resolve.
2. New captures from any agent for that domain are rejected at the capture pipeline. The agent sees a `domain_opted_out` hint with a link to the opt-out documentation.
3. The opt-out record is public: `GET /v1/domains/opt-outs` returns the current set so any agent or auditor can verify.

## Reversal

The owner can rescind by removing the TXT record (or the well-known file) and visiting `https://unbrowse.ai/opt-out?action=rescind`. The backend re-verifies the absence and removes the domain from the opted-out set. Future captures resume.

## Where this lives in the code

- `backend/src/routes/opt-out.ts` — the HTTP handlers (`POST /v1/domains/opt-out`, `POST /v1/domains/opt-out/rescind`, `GET /v1/domains/opt-outs`)
- `backend/src/services/domain-verifier.ts` — the verification logic (DNS resolver, well-known fetcher)
- `backend/src/services/marketplace.ts` — the deprecation flag on skill records
- `src/capture/index.ts` — the capture-time check (rejects on opted-out domain)

## Status

The folder you are reading codifies this rule. Implementation status as of this writing: the routes and the marketplace deprecation flag are in development. This document is the contract that the code holds to.
