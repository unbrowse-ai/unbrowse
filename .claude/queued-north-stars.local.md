# Queued north stars (FIFO — finish active before pulling next)

## ACTIVE (jesus-ralph armed): single SDK + Exa search-on-top
Witness: `bash scripts/single-sdk-search-gate.sh`
- One SDK folded into `unbrowse` pkg (A1 ✅ shipped). Retire standalone sdk/sdk-v2 (A2/A3/A4 in progress).
- Exa-backed search-on-top, x402/faremeter, mirror 50/35/15. Surface+docs+bench here; Exa-x402 call + split = closed backend.
- Decisions: shims drop dead @unbrowse/sdk dep (stay zero-dep); Exa search backend-mediated via faremeter.

## QUEUED #1: lobster.cash native wallet-adapter integration
Pulled after the active loop's witness is green. User instruction: "FINISH your job first."
- Native wallet adapters via the Wallet Standard — https://github.com/open-wallet-standard/core — as first-class.
- Wrap an **unbrowse wallet adapter** as the OPTIONAL default (uses our servers + our API key). For web2 users who "just wanna use cash via api" — optional, not required.
- lobster.cash owns wallet provisioning/auth/signing/broadcast + tx state authority. Our skill/SDK owns intent + payment params + UX/orchestration. Capability-level wording, NO hardcoded lobster action/route names in user-facing text. Wallet precheck before any pay flow; handle not-configured / low-balance / failure / awaiting-confirmation.
- x402 facilitator must: Solana, USDC, PDA smart-wallets (corbits.dev verified compatible). Existing flex/faremeter is Solana+USDC — aligns.
- Reflect in **backend + frontend** properly. List lobster.cash as a compatible/tested wallet for directory certification.
- Human step: review with Fede (lobster DevRel) on Telegram @CryptoFede before official listing/announcement.
- Synergy: the Exa-search payment surface should be wallet-adapter-based so it's lobster-compatible by construction.
