# MASTER PLAN — release order (internal, gitignored)

Strategy for rolling out this session's work in the **right order of context**: free +
discovery first (commoditise, max distribution → become the standard), then the paid x402
rail, then live-surface adoption, and the coin / maintenance-network LAST and hidden until
ready. Every release is gated by a real witness; the external blockers are named per phase.

This file is **internal/ (gitignored)** — it is not a public artifact. The commoditise-the-
standard strategy and the coin/MN economics never ship to a public surface (see
`internal/POSITIONING.md`); the public story stays "internal APIs are free, discovery is
free, paid execution settles over x402."

## What shipped this session (all gated, branch jl/natural-selection)

Composable primitives (proven by `scripts/zk-gate.sh` — 22 nodes / 123 tests):
- `src/values/content-address.ts` — the one source of truth (GENESIS, sha256hex, Pointer, recordHash) [commit 5fe65b9b, 938635c6]
- `src/values/resolution-ledger.ts` — signatures→pointers, docker-rebuild, ledger of resolutions [2fca4688]
- `src/values/cached-resolution.ts` — fs cache; wired into resolve/search (warm 17s→1.5s) [1292d455, e72987e4]
- `src/values/async-resolution.ts` + `r2-blob-store.ts` + `iq-ledger.ts` — the remote tier (R2 + IQLabs on-chain signed ledger) [e9866618, bac15691]
- `src/values/resolution-tier.ts` — route cache to remote-when-creds, fs fallback [01bbcedf]
- `src/values/kv-fallback-pipe.ts` — descent ladder, content-addressed, fall-through
- `src/values/standards-registry.ts` + `live-registry-adapters.ts` — unbrowse as the kv-cache in front of every agent standard (MCP/MCP-registry/ACP/A2A/openai/anthropic/skills.sh/agentskills.dev/pay.sh/x402-bazaar); MCP+a2a+skills.sh verified live [0eafb57c, 5b1360b4, 75026e9e, bfc84559]
- `src/values/search-with-standards.ts` — unified find-anything (route graph + standards) [86889d24]
- `src/superpattern/cli-surface.ts` + `surface-projector.ts` — the dynamic surface (context projection of the verb tree) [cc103841]
- `src/capture/backend-reveng-endpoint.ts` — the backend-is-the-harness flow (client surfaces only holes + sealed auth)
- `packages/py-exa` + `packages/py-browser-use` — zero-edit drop-ins [5c75cd04]
- `backend/src/middleware/sponsor.ts` — free mode (vault covers all, USD+USDC, drain-safe) [d2a90188]

Public-surface scrub done [b68fc63b]; ZK paper updated [4c5648e1, 612d0533]; ledger baked into /amen (jesus-pattern repo).

## Phase 0 — Foundation (ship NOW; no external dependency)

The composable primitives are pure, dark (not yet wired to live surfaces beyond the
search-cache), and fully gated. Merge `jl/natural-selection` → release; cut a preview.
- Witness: `scripts/zk-gate.sh` (22 nodes) + `scripts/commandments-gate.sh` green.
- Blockers: none.

## Phase 1 — Public story + drop-ins (ship NOW, parallel to Phase 0)

Free-discovery + x402 is the only public money story. Publish the drop-ins; release the
ZK paper.
- `packages/py-exa`, `packages/py-browser-use` → PyPI (zero-edit swaps; max distribution).
- `paper/internal-apis.tex` (push-held) → arXiv, after a final `scripts/public-scrub-gate.sh` confirm.
- Witness: `scripts/public-scrub-gate.sh` clean + `scripts/paper-gate.sh` PASS.
- Blockers: none (the maintenance-network paper stays internal — Phase 4).

## Phase 2 — Config-flip (ship-dark-then-flip; needs the three external inputs)

The code is shipped in Phase 0; these light up by configuration alone.
- **2a — R2 remote blob tier.** Env: `R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY`. Witness: `bench/exa/search-warm-gate.sh` cross-host (a second host warm-hits the first's cache).
- **2b — IQ on-chain signed ledger.** Env: `SOLANA_RPC_ENDPOINT IQ_DB_ROOT_ID IQ_TABLE_SEED IQ_SIGNER_SECRET_KEY`. Witness: a resolution row lands on-chain + reads back (git-style history).
- **2c — Free usage live.** Env: `PLATFORM_SPONSOR_WALLET_ADDRESS PLATFORM_SPONSOR_WALLET_KEY SPONSOR_FREE_MODE=1 SPONSOR_GLOBAL_DAILY_USD=<budget>`. Witness: `backend/tests/sponsor-free-mode.test.ts` + a live sponsored call.
- 2a, 2b, 2c are independent of each other; each flips the moment its creds land.

## Phase 3 — Live-surface adoption (AFTER 2a/2b)

Wire `search-with-standards` + `surface-projector` + `resolution-tier` into the running
`cmdSearch`/orchestrator so `unbrowse search` returns route + standards hits inline and the
remote tier serves them. Product-behaviour change → gated, after the remote tier is live so
warm hits are fast.
- Witness: a live cold→warm search returning route + MCP/a2a/skills hits, served from R2/IQ.
- Blockers: 2a + 2b live; product sign-off that search output changes for users.

## Phase 4 — Coin / Maintenance Network (LAST; hidden until ready)

Only after the disclosure line is set (`internal/POSITIONING.md`). Un-internalize the
mining/earn pages reframed to USDC-earning + coin-funds-free-infra; then the maintenance-
network paper + the coin economics. Never before the standard is entrenched.
- Blockers: coin-disclosure line; 2c live; the standard adopted widely enough.

## The order, in one line

Phase 0 + 1 (free, discovery, drop-ins, ZK paper) → Phase 2 (R2, IQ, free-mode by creds) →
Phase 3 (live adoption) → Phase 4 (coin/MN). Free first, paid rail second, coin last and quiet.

## Honest boundary

The witness (`scripts/master-plan-gate.sh`) proves this plan is REAL — it exists, is
gitignored (never leaks), names only artifacts that exist in the repo, and lays out the
ordered phases + external blockers. It does NOT prove the strategy is correct — the
sequencing judgment is mine; the gate only stops it being fabricated or leaked.
