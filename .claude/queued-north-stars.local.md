# Queued north stars (FIFO — finish active before pulling next)

## ACTIVE (jesus-ralph armed): single SDK + Exa search-on-top
Witness: `bash scripts/single-sdk-search-gate.sh`
- One SDK folded into `unbrowse` pkg (A1 ✅ shipped). Retire standalone sdk/sdk-v2 (A2/A3/A4 in progress).
- Exa-backed search-on-top, x402/faremeter, mirror 50/35/15. Surface+docs+bench here; Exa-x402 call + split = closed backend.
- Decisions: shims drop dead @unbrowse/sdk dep (stay zero-dep); Exa search backend-mediated via faremeter.

## DONE: lobster.cash + Wallet Standard (OWS) wallet-adapter integration
Witness `scripts/wallet-adapter-gate.sh` GREEN 8/8 (commits be58b0cd, 9148019c).
SDK bridge (zero-dep, structural) + optional unbrowse-default wallet + frontend
connect + docs. Backend follow-up: implement `/v1/wallet/sign` (the unbrowse-default
wallet calls it) — closed repo.

## Honest remainder of "everything I said in the transcripts" (NOT one witness)
- OUT-OF-REPO: backend Exa /search x402 call + on-chain 50/35/15 settlement; backend
  /v1/wallet/sign; `npm deprecate @unbrowse/sdk` + `@unbrowse/client`.
- HUMAN-GATED: Papers 2 & 3 sign-off by Kevin / Rach Pradhan (rollout blocker).
- UNBOUNDED/aspirational: trojan-horse drop-in PR into every significant GitHub repo;
  BrowseComp/Exa two-witness reproducible win; kuri upstream PR + git-history rewrite.
- VERIFY: live site reflects open-core truth + serves /docs/adapters (last live-gate
  failed mid an earlier session).
These can't be a single runnable gate without it being fake/eternal — each is its
own loop or a human step.

## (superseded) QUEUED #1: lobster.cash native wallet-adapter integration
Pulled after the active loop's witness is green. User instruction: "FINISH your job first."
- Native wallet adapters via the Wallet Standard — https://github.com/open-wallet-standard/core — as first-class.
- Wrap an **unbrowse wallet adapter** as the OPTIONAL default (uses our servers + our API key). For web2 users who "just wanna use cash via api" — optional, not required.
- lobster.cash owns wallet provisioning/auth/signing/broadcast + tx state authority. Our skill/SDK owns intent + payment params + UX/orchestration. Capability-level wording, NO hardcoded lobster action/route names in user-facing text. Wallet precheck before any pay flow; handle not-configured / low-balance / failure / awaiting-confirmation.
- x402 facilitator must: Solana, USDC, PDA smart-wallets (corbits.dev verified compatible). Existing flex/faremeter is Solana+USDC — aligns.
- Reflect in **backend + frontend** properly. List lobster.cash as a compatible/tested wallet for directory certification.
- Human step: review with Fede (lobster DevRel) on Telegram @CryptoFede before official listing/announcement.
- Synergy: the Exa-search payment surface should be wallet-adapter-based so it's lobster-compatible by construction.
