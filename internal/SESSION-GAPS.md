# Session gap ledger — filled vs blocked (honest)

Internal (gitignored). Records what this long session filled (with commits) and
what remains, honestly categorized. No fabricated green; blocked ≠ done.

## FILLED (real, committed, witnessed)
- **Capture fixes (BrowseComp SPA/parked)** — `159a5cf6` (SPA-shell render routing, dead/parked fast-fail) + harness fixes; tests green.
- **Forwarder leak fix** — `3ecaf76e`/`4680fd1d` (reap proxy forwarder on exit; lean-boot `UNBROWSE_SKIP_REHYDRATE` 23s→6s).
- **EmergentDB vectors+KV client** — `76071bda` (1536-dim search + qdkv; live witness). Substrate replaces Neon (legacy `USE_PGKV`) + R2 (optional blob tier).
- **Fair-value x402 split** — `1320e8e9` (3-way Faremeter split test green; fdry wallet wired as platform recipient in local .dev.vars).
- **pay.sh integration** — `a979d3c9` (pay detects+settles unbrowse x402; doc + witness).
- **lobster.cash payment path** — `f6eb759d` (Solana/USDC x402 delegation; doc + witness).
- **Frontend payment honesty** — `ae13dc4d` (billing + account rewritten to per-request x402 cut; no Stripe subscription selling; TASTE root/seal fix).
- **env-audit + envs filled** — `81f8d1c6` + local config: Helius RPC (verified), fdry keys (IQ signer + sponsor), EmergentDB, CORE all present.
- **CF scoped deploy token** — minted least-privilege `unbrowse-deploy` token (Workers/KV/Pages/R2/Zone), set as GH Actions secrets on unbrowse-dev. Global key never in CI.
- **stack-health + billing-honesty witnesses** — `ad6274bf` (auth/envs/EmergentDB/x402/Helius all green; payment surfaces honest).
- **bun.lock sync** — `8e915166` (fixed frozen-lockfile CI failure).
- **Worker-safe module load** — `753f5f49` (guard `fileURLToPath(import.meta.url)` in version.ts; lazy `nanoid()` session id in dag-feedback.ts). Two top-level workerd-illegal ops were crashing the backend deploy at CF validation (error 10021), masked by a wrangler 4.x error-formatting bug. NOT token/version/lockfile. Witness: `wrangler deploy --env staging` green; `/health` 200 storage_backend=emergentdb.
- **CICD deploy unblocked** — staging deploy green via CI (scoped token), backend + frontend; staging on HEAD SHA so the staging-first prod gate precondition holds.
- **Frontend prebuild doc** — `c7d47eaa` (restored `docs/HOW_UNBROWSE_PAYS.md` as a clean public payment doc; b68fc63b removed it for moat reasons but left page/codegen/test referencing it → frontend deploy ENOENT). 9/9 render tests; leak-guard clean.
- **Website earnings visibility** — `b18d153d` (`GET /v1/claim/earnings?domain=` + `earningsForWallet`). Answer to "do websites redeem tokens?": no redemption — owner lane pays directly on-chain at settlement; the gap was a *read* surface (the `unbrowse_earnings` MCP tool called a missing `/v1/account/earnings` handler). Witness: claim-earnings.test.ts red(404)→green.

## BLOCKED / DEFERRED (honest — what unblocks each)
| Gap | Why blocked | Unblock |
|---|---|---|
| **Prod deploy (release)** | RESOLVED the deploy crash (was workerd-illegal top-level ops in src/, not wrangler/token). Staging deploys GREEN via CI (backend+frontend) on HEAD SHA. Now blocked only by the `main`-push MCP-safety pre-push hook: it requires the 1000-probe bench ledger tail to be `verified\|shipped\|converged` AND post-date the push delta. Current tail is `verified` @ 2026-06-02, older than the new commits. | Either (a) iterate the bench-mcp-safety meta-harness to refresh the verdict post-dating HEAD, then push main → tag; or (b) `MCP_GATE_BYPASS=1` with a CHANGELOG note (explicitly "NOT routine"). Prod untouched; staging-first gate precondition already holds. |
| **Beat BrowseComp >0.336** | pipeline fully fixed + measured **0.167** (real, up from false 0.0); gap is answer-correctness on adversarial multi-constraint chaining. | retrieval reranking + stronger agent model + larger-N measurement. Research. |
| **fdry as PROD payTo** | `wrangler.ci.toml [vars] PAYMENT_RECIPIENT` = old wallet `6Kpxao…`, hardcoded. Local .dev.vars has fdry; prod doesn't. | change the var to `8n7Qz…` (or make it a secret) — part of the deploy pass. |
| **Backend Stripe code removal** | ~20 files; metering/subscription interlocks. Frontend already honest; backend Stripe is inert dead weight. | cluster-by-cluster delete with `bun test` each. Refactor. |
| **aiko chat-UI (Perplexity-style + CF tunnel + tinytools-agent + x402)** | greenfield multi-system build (chat UI, CF→tailnet tunnel, aiko-0.8b GGUF deploy, x402/lobster paywall, connectors). | dedicated multi-session project from `tinytools-agent`. |
| **Paper BrowseComp results section** | gated on beating 0.336 (writing it now = fabricated numbers). | unblocks when score clears 0.336. Cayden co-author + "Security Was All You Needed" title already done. |

## Promise status
`no gaps left to fill` is **NOT true**: fillable gaps remain (wrangler migration,
backend Stripe removal, aiko chat-UI) — large/focused, not completable in this
exhausted session — plus research-blocked (BrowseComp). The cheaply-fillable gaps
are filled; the rest are honestly documented above. Promise withheld.
