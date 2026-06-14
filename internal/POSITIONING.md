# Public disclosure policy (internal — gitignored)

The evolving boundary for what the public surface (docs site, landing, README, the
security paper) may say. This supersedes the earlier "scrub the coin + maintenance
network entirely" pass where it conflicts.

## Allowed in public
- **Free + frictionless usage.** Internal APIs are free; discovery (resolve/search) is
  free; the platform takes on the cost so there is zero friction. Mechanism: x402, with
  the platform vault wallet sponsoring (`SPONSOR_FREE_MODE`), settling in **USD or USDC**.
- **Mining the internet.** OK to talk about publicly, framed as a way for people to get
  **rewarded with $ — USDC / cash** for contributing routes. Earning is a public story.
- **The coin, as an infrastructure-funding mechanism only.** OK to say the coin exists
  to **fund the infrastructure so it stays free** for users. NOT as an investment.

## Stays hidden (for later)
- The **commoditise-every-API-marketplace / become-the-standard strategy** — never public,
  no matter what.
- The **maintenance-network economics** as the mechanism: bonding, challenge, slashing,
  bonded route trust, proof-of-indexing internals — deferred.
- The **coin as an investment** — no buy-this framing, no token contract address printed
  for speculation, no fair-launch/price narrative.

## Gate
`scripts/public-scrub-gate.sh` is the runnable witness. Its DEFERRED set should encode
exactly the "stays hidden" list above (MN-economics terms, the contract address,
investment/fair-launch framing, the strategy) and must NOT block the allowed list
(free, mining-as-USDC-earning, coin-as-infra-funding). A plain grep cannot tell
"coin funds free infra" from "buy the coin", so the gate keeps the unambiguous
buy-signals (contract address, fair-launch, bonding/slashing) forbidden and the editorial
judgement (how a restored page frames the coin) stays a human review line.

## Remaining editorial step (needs the line confirmed before publishing)
The mining/earn SEO pages were internalized under the earlier strict pass
(`internal/frontend/src/app/{mine-the-internet,openclaw-earn,top-domains-to-mine,...}`).
To re-publish them under this policy: reframe to USDC/cash earning + coin-funds-free-infra,
strip MN-economics + investment framing + the contract address, then move back to
`frontend/src/app/` and re-run `public-scrub-gate.sh`. Hold until the exact coin-disclosure
line is confirmed, since these are published artifacts.
