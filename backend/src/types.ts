export interface Env {
  API_KEY: string;
  LANDING_PUBLISH_KEY?: string;
  /** Shared secret for /v1/blog/publish. Set via `wrangler secret put BLOG_PUBLISH_KEY`. */
  BLOG_PUBLISH_KEY?: string;
  EMERGENTDB_API_KEY: string;
  EMERGENTDB_TIMEOUT_MS?: string;
  /** BUG-011 (contract 311771e1): per-value byte cap for EdbKV.put. Default 10240. */
  EMERGENTDB_MAX_VALUE_BYTES?: string;
  /**
   * Internal canonical-anchor ordering (services/bible-anchor.ts). When "1",
   * resolve results are sequenced by their nearest canonical anchor at the
   * presentation boundary, behind the apophenia confidence gate. Default unset
   * = OFF (pure relevance order). Requires the bible-chapters domain to be
   * seeded (scripts/seed-bible-chapters.ts).
   */
  BIBLE_ANCHOR_ORDER?: string;
  NEBIUS_API_KEY: string;
  /** Fallback embeddings host for the canonical-anchor seed (qwen3-embedding-8b). */
  OPENROUTER_API_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_PR_BOT_TOKEN?: string;
  GITHUB_PR_BOT_LABEL?: string;
  GITHUB_PR_BOT_MERGE_METHOD?: string;
  GITHUB_WEBHOOK_ALLOWED_REPOS?: string;
  GITHUB_PR_AGENT_WORKFLOW?: string;
  GITHUB_PR_AGENT_WORKFLOW_REF?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RELEASE_MANIFEST_SIGNING_SECRET?: string;
  /**
   * Deploy-time identity vars (principle 20260521T194246Z-7ad798e3:
   * staging-then-prod with signed release notes). Set by CI on every
   * deploy via wrangler [env.*.vars] OR `wrangler deploy --var ...`.
   * Served by GET /v1/version so any user can confirm which artifact
   * they hit and verify the signed manifest hash via the SDK / CLI.
   *
   * UNBROWSE_VERSION       semver string from packages/skill/package.json
   *                        (e.g. "6.17.0-preview.7")
   * UNBROWSE_BUILD_SHA     GITHUB_SHA / `git rev-parse HEAD` at build
   * UNBROWSE_DEPLOYED_AT   ISO 8601 stamp wrangler deploy.yml writes
   *                        on the flip (e.g. "2026-05-22T03:45:00Z")
   *
   * All three optional — when unset (local dev, fresh staging before CI
   * wires them), /v1/version returns null for the field rather than a
   * stub. Caller knows the build wasn't through CI (no-stubs principle
   * 20260521T193905Z-61e01c0e).
   */
  UNBROWSE_VERSION?: string;
  UNBROWSE_BUILD_SHA?: string;
  UNBROWSE_DEPLOYED_AT?: string;
  STATS_KV: KVNamespace;
  /**
   * v7.0 audit log — pointer-only fill receipts (Ed25519 sig-shape today,
   * Groth16 SNARK in v7.3 behind the same wire surface). See
   * `services/audit.ts` for the KV schema and `routes/audit.ts` for the
   * REST surface. Binding optional in v7.0 scaffold because the storage
   * path is inert (throws NotImplementedError); deploys without the
   * namespace declared still serve the verify path with a 501 hint.
   * Wrangler declares the binding stanza; `wrangler kv:namespace create
   * AUDIT_LOG` produces the id the operator pastes into the TODO slot.
   */
  AUDIT_LOG?: KVNamespace;
  /**
   * v7.2.0-preview.0 persistent-session state — pointer-of-pointer chain
   * (L1..L4 per BoundPointer) parked at `breath session-park` and read
   * at `breath session-restore`. Dedicated namespace; KV key shape is
   * `session:<walletPubkey-hex>:<sessionId>` so cross-wallet enumeration
   * is structurally impossible. See `services/session-state.ts` for the
   * helper and `routes/session-state.ts` for the wire surface. Binding
   * optional in v7.2.0-preview.0 because the storage path is INERT
   * (throws BindingMissingError → 503 honest envelope at the route);
   * v7.3 wave provisions the namespace and wires the real impl.
   * Operator provisions via:
   *   bunx wrangler kv:namespace create SESSION_STATE
   *   bunx wrangler kv:namespace create SESSION_STATE --preview
   * then pastes the ids into wrangler.toml's SESSION_STATE stanza.
   * Mt 6:19-20 — lay up for yourselves treasures in heaven; the
   * KV-cached pointer-chain IS the persistent treasure that browser-
   * close was destroying every session.
   */
  SESSION_STATE?: KVNamespace;
  /**
   * v7.2.0-preview.0 trace-state KV (Day-3 Land worker B, 2026-05-28).
   * Pointer-only execution traces (decision_trace step labels + timings
   * + status_class + canonical error_code; NEVER URL paths, query
   * strings, or response bodies). Key shape:
   *   trace:<walletPubkey-hex>:<sigHashHex>
   * Wallet-prefixed for cross-wallet structural isolation. TTL 7d.
   * See `services/trace-state.ts` for the schema and `routes/trace.ts`
   * for the wire surface. Binding optional in v7.2.0-preview.0 — the
   * route returns 503 with `_binding_missing: "TRACE_STATE"` when
   * absent so the deployment-shape problem surfaces honestly.
   * Operator provisions via:
   *   bunx wrangler kv:namespace create TRACE_STATE
   *   bunx wrangler kv:namespace create TRACE_STATE --preview
   */
  TRACE_STATE?: KVNamespace;
  /**
   * v7.2.0-preview.0 settings-state KV (Day-3 Land worker B, 2026-05-28).
   * Per-wallet durable preferences (default_proxy, headless,
   * auth_capture_mode, etc.). Key shape:
   *   settings:<walletPubkey-hex>:<settingKeyHash>
   * where settingKeyHash = sha256(settingKey)[:32] (so settings keys
   * are not enumerable from a KV listing). Value field is a pointer
   * (literal: | op:// | keychain:// | bw:// | arg:// | unbrowse://),
   * NEVER a raw value. See `services/settings-state.ts` for the
   * schema and `routes/settings.ts` for the wire surface. Indefinite
   * TTL — settings are durable preferences. Binding optional in
   * v7.2.0-preview.0; route returns 503 with `_binding_missing:
   * "SETTINGS_STATE"` when absent.
   * Operator provisions via:
   *   bunx wrangler kv:namespace create SETTINGS_STATE
   *   bunx wrangler kv:namespace create SETTINGS_STATE --preview
   */
  SETTINGS_STATE?: KVNamespace;
  /**
   * v7.x KV response cache (W17 wave, 2026-05-28). Dedicated namespace —
   * NOT shared with STATS_KV (analytics writes) or AUDIT_LOG (signed
   * receipts) so wholesale cache invalidation doesn't disturb adjacent
   * state. See `services/kv-cache.ts` for the helper. Binding optional:
   * when absent the helper gracefully falls through to compute (no
   * throw, single per-isolate warn log). Operator provisions via:
   *   bunx wrangler kv:namespace create RESPONSE_CACHE
   *   bunx wrangler kv:namespace create RESPONSE_CACHE --preview
   * then pastes the ids into wrangler.toml's RESPONSE_CACHE stanza in
   * place of the `TODO_create_via_wrangler_kv_namespace_create*` slots.
   * Matt 6:34 — sufficient unto the day; what was computed need not be
   * recomputed.
   */
  RESPONSE_CACHE?: KVNamespace;
  /**
   * v7.2.0-preview.0 screenshot-blob KV (Day-5 SWARM worker D, 2026-05-28).
   * Content-addressable PNG storage keyed by `sigKey = sha256(signature)[:32]`.
   * Two writes per POST (meta + blob), per-row 30d TTL. Returns
   * `unbrowse-blob://<sigKey>` pointer instead of writing the PNG to
   * `~/.unbrowse/screenshots/` under stateless mode. Binding optional —
   * route returns 503 with `_binding_missing: "SCREENSHOT_BLOB"` when
   * absent; the CLI handler treats this as graceful-degrade and writes
   * to `~/.unbrowse/tmp/<sigKey>/screenshot.png` (per A1's tmp exclusion).
   * Operator provisions via:
   *   bunx wrangler kv:namespace create SCREENSHOT_BLOB
   *   bunx wrangler kv:namespace create SCREENSHOT_BLOB --preview
   * Then paste the ids into wrangler.toml's SCREENSHOT_BLOB stanzas.
   */
  SCREENSHOT_BLOB?: KVNamespace;
  /**
   * v7 covenant peer-federation target (W26-C, 2026-05-28). The base URL of a
   * running covenant-server (the native binary's HTTP surface, or another
   * Worker peer) that the unbrowse backend mirrors each `/v1/covenant` receipt
   * to via `POST <COVENANT_LEDGER_URL>/submit-op` — the SKILL.md peer-federation
   * shape (Gen 2:18 — *ezer kenegdo*, helpers facing each other; Eph 4:4 — one
   * body). The mirror is fire-and-forget (ctx.waitUntil) and OPTIONAL: when this
   * is unset, `mirrorToCovenantLedger` is an honest no-op (single warn log, no
   * throw) — the federation is optional infra, never blocks the user response.
   * The unbrowse KV row and the covenant ledger row share the SAME
   * `deriveCovenantReceiptPtr` content-address, so "same database" holds via
   * shared content-addressing even with two physical stores
   * (.planning/v7-rip/CONVERGENCE_MAP.md §3 option a+c).
   * Example: COVENANT_LEDGER_URL = "http://aiko-host:8787".
   *
   * OPACITY NOTE (W33-C, 2026-05-28): the mirror now sends an OPAQUE op (no
   * covenant verb, no scripture witness) to `<base>/op`, NOT the covenant
   * `/submit-op` wire. Prefer `AIKO_OP_URL` (below) — this legacy name still
   * works and ALSO receives the opaque op shape.
   */
  COVENANT_LEDGER_URL?: string;
  /**
   * v7 aiko-proxy op target (W33-C, 2026-05-28). The base URL of an aiko-level
   * proxy that accepts an OPAQUE unbrowse-native op — `POST <AIKO_OP_URL>/op`
   * with body `{op_class, op_kind, params, identity, sig?, unbrowse_receipt_ptr}`
   * — and returns only `{receipt_ptr}`. The proxy (sovereign, aiko-side) is the
   * one that maps `op_class → covenant verb` and supplies the default_witness;
   * the covenant MECHANISM (verb + scripture) NEVER crosses the unbrowse egress
   * wire (Mark 4:11). Preferred over the legacy COVENANT_LEDGER_URL. Optional —
   * when all of AIKO_OP_URL / COVENANT_LEDGER_URL / PEER_URLS are unset, the
   * mirror is an honest no-op (single warn log naming only the op_class + ptr).
   */
  AIKO_OP_URL?: string;
  /**
   * v7 aiko-insider auth key (W33-C, 2026-05-28). Gates the FULL `/v1/covenant`
   * response (`kind` / `action` mechanism fields) behind `Authorization:
   * Bearer <AIKO_KEY>`. Public callers (no key, or a mismatch) receive the
   * OPAQUE response only — `{ok, receiptId, covenantReceiptPtr, verify_ok,
   * idempotent}` — never the 3-verb vocabulary (Mark 4:11). ADMIN_KEY is also
   * accepted as an insider token so a fresh secret is optional. Set via
   * `wrangler secret put AIKO_KEY`. Never echoed in any response.
   */
  AIKO_KEY?: string;
  /**
   * v7 covenant federation fan-out peers (W26-C, 2026-05-28). Comma-separated
   * list of additional covenant-server base URLs the receipt is mirrored to
   * (Num 11:17 — the Spirit shared across many). Each entry is treated the same
   * as COVENANT_LEDGER_URL: fire-and-forget `POST <url>/submit-op`, graceful
   * skip on failure. COVENANT_LEDGER_URL is the primary; PEER_URLS are
   * secondary witnesses (Deut 19:15). Optional — unset = no extra peers.
   */
  PEER_URLS?: string;
  ENVIRONMENT?: string; // "production" | "staging"
  // PAYMENTS_ENABLED / X402_SEARCH_ENABLED removed 2026-05-26: per-skill
  // owner_compensation_opt_in is the ONLY lever now. No operator-side
  // env-var escape hatch — the substrate cannot be accidentally turned
  // on or off by a stale wrangler.toml entry. Indexing is always free;
  // payment is opt-in per skill via DNS claim + wallet binding.
  CREDITS_ENABLED?: string;
  X402_NETWORK_MODE?: string;
  /**
   * When set to "1"/"true", x402 verification falls back to allow-on-failure
   * if the upstream facilitator is unreachable. Off by default — keep it off
   * unless you have separate alerting/throttling on degraded responses.
   */
  X402_DEGRADED_ALLOW?: string;
  /**
   * Nuclear kill-switch (2026-05-18 security rotation). When set to "1" / "true",
   * `bearerAuth` rejects EVERY API key with `error: "all_keys_rotated"` + a
   * re-register URL. Used after a leaked-token cleanup or audit; flip to "0"
   * to restore normal verification. Does not delete keys from KV — purely a
   * gate; if the rotation needs to be reverted, clear this env and keys work
   * again. See: services/keys.ts verifyLocalKey early-return.
   */
  ALL_KEYS_REVOKED?: string;
  /**
   * Anti-reverse-engineering exec-token gate (services/exec-token.ts,
   * middleware/exec-token.ts). When "1" / "true", marketplace routes
   * (/v1/search*, /v1/skills*) REJECT authenticated callers that do
   * not present a valid X-Unbrowse-Session token. Default unset =
   * observe mode (logs `[exec-token]` evidence, never blocks) so
   * existing CLIs in the wild keep working until they ship the header.
   * Flip to "1" only after observe-mode logs confirm real CLIs send
   * valid tokens.
   */
  EXEC_TOKEN_ENFORCE?: string;
  /** Wallet address that receives x402 skill-access payments. */
  PAYMENT_RECIPIENT?: string;
  /** The unbrowse-default wallet secret (64-byte Solana keypair, JSON-array /
   *  hex / base58). Platform-held; signs attestations server-side via Web Crypto
   *  Ed25519. Set via `wrangler secret put UNBROWSE_DEFAULT_WALLET_KEY`. */
  UNBROWSE_DEFAULT_WALLET_KEY?: string;
  /**
   * Rotation weight (0-10000 bps) for which scheme appears FIRST in the
   * dual-accept Flex 402 envelope. 0 = always Flex-first, 10000 = always
   * PayAI-exact-first. Default 5000 = 50/50, deterministic per agent_id
   * hash so a given agent consistently sees the same ordering inside the
   * bucket (so latency comparisons hold). Clients still choose which
   * accept entry to pay; this only biases the order they see.
   */
  PAYAI_ROTATION_BPS?: string;
  /**
   * Wave 3 of the integrate-abk-labs-fair-meter-faremeter-x402-pay scaffold.
   * When "1" / "true", `/v1/test/paid` mounts `@faremeter/middleware` and
   * emits a real 402 with payment requirements. OFF by default. Existing
   * Flex/PayAI paths are unaffected — this is an isolated test surface.
   */
  FAREMETER_ENABLED?: string;
  // v6.16: CASCADE_PLATFORM_WALLET and CASCADE_SIGNER_SECRET_KEY are unused by
  // the runtime — Flex carries the 10% platform cut natively in every signed
  // authorization's splits. They remain in the Env shape for one release so
  // existing wrangler secret configs don't fail validation; v6.17 removes them.
  // CASCADE_RPC_URL / CASCADE_RPC_WS_URL stay (Solana RPC binding for Flex).
  CASCADE_PLATFORM_WALLET?: string;
  CASCADE_SIGNER_SECRET_KEY?: string;
  CASCADE_RPC_URL?: string;
  CASCADE_RPC_WS_URL?: string;
  // Demo video generation pipeline
  TURBOBOX_URL: string;
  R2_BUCKET: R2Bucket;
  FAL_KEY: string;
  // Cartesia TTS (voice synthesis for demo pipeline)
  CARTESIA_API_KEY?: string;
  CARTESIA_VOICE_ID?: string;
  // Email (Resend) for magic-link auth
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  PUBLIC_API_URL?: string;
  PUBLIC_FRONTEND_URL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  /** Optional GitHub PAT for traction stats fetch. Raises rate limit to 5000/hr. */
  GITHUB_TOKEN?: string;
  /** Exa web search — parallel step in resolve, surfaces highlights when marketplace misses. */
  EXA_API_KEY?: string;
  /**
   * Master key-encryption-key for the per-account cookie vault (L4). The
   * vault wraps each user's random data key with AES-GCM under this secret
   * (envelope encryption); cookies are never stored in plaintext. When
   * unset the cookie endpoints return 503 vault_not_configured rather than
   * degrading to weak storage. Set as a Worker secret in production.
   */
  COOKIE_VAULT_MASTER_KEY?: string;
  /**
   * Comma-separated list of additional reserved domains. Non-admin publishers
   * cannot publish skills for these domains (or their subdomains). Combined
   * with the seed list in `services/domain-reservations.ts`.
   */
  RESERVED_DOMAINS?: string;
  /**
   * Privy server-side verification + embedded-wallet lookup
   * (Wave 2 of wire-privy-authentication-end-to-end-for-unbrows).
   *
   * PRIVY_APP_ID is the public app id (same value as
   * NEXT_PUBLIC_PRIVY_APP_ID on the frontend). Currently
   * cmpalnem701z00cjmncqve4q0 per memory reference_privy_app_creds.
   *
   * PRIVY_APP_SECRET is the app secret minted in the Privy dashboard.
   * Set via wrangler secret put PRIVY_APP_SECRET. NEVER commit. The
   * 2026-05-18 value was pasted in chat and is pending rotation in the
   * Privy dashboard before flipping prod traffic.
   */
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
  /**
   * Comma-separated list of domains where the well-known HTTP probe is
   * waived (test fixtures, internal hosts). Most operators leave this empty.
   */
  DOMAIN_VERIFY_SKIP?: string;
  /** Set to "1"/"true" to require .well-known probe before any non-admin publish. */
  REQUIRE_DOMAIN_VERIFICATION?: string;
  /**
   * Stripe — subscription wrapper around x402. Optional; when unset, the
   * admission ladder falls through to the existing x402 / credits paths
   * unchanged (falsifier F1).
   */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Stripe Price IDs for the three-tier billing rail (D3 wave 3 of
   * unbrowse-payments-faremeter). When unset, inferTier returns "free"
   * and no grants fire.
   * - STRIPE_PRICE_PRO_MONTHLY: the flat $20/mo recurring price; matching
   *   subscriptions get a 200_000 uc grant on each period rollover.
   * - STRIPE_PRICE_METERED: the metered price (Stripe Meter API); matching
   *   subscriptions debit per execute (wave 4 ring-buffer flush).
   */
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_METERED?: string;
  /** Stripe Meter event name (default `unbrowse_execute`) for the metered tier. */
  STRIPE_METER_EVENT_NAME?: string;
  /**
   * Monthly-USDC subscription pricing (contract organ 1682152a stage B —
   * ported from aiko-v2 so unbrowse is the single source of truth for
   * payments). When set, POST /v1/billing/crypto-sub/{base,pro} mints a
   * 30-day subscription paid in USDC over x402 instead of card-on-file.
   *
   * CRYPTO_BASE_USDC / CRYPTO_PRO_USDC override the default $19 / $59.
   * CRYPTO_BASE_QUOTA / CRYPTO_PRO_QUOTA set the included call budget
   * (defaults 200_000 / 1_000_000 — read-side decides the unit).
   */
  CRYPTO_BASE_USDC?: string;
  CRYPTO_PRO_USDC?: string;
  CRYPTO_BASE_QUOTA?: string;
  CRYPTO_PRO_QUOTA?: string;
  /** Stripe price ID for the base subscription tier (monthly quota). */
  STRIPE_PRICE_BASE?: string;
  /** Stripe price ID for metered overage (per-unit) above the quota. */
  STRIPE_PRICE_OVERAGE?: string;
  /**
   * Auto-refill overage (subscription-billing-layer wave 2). When a user's
   * monthly-plan credit is exhausted mid-cycle, the /llm route fires an
   * off-session Stripe PaymentIntent on the card on file and grants the
   * equivalent credit. STRIPE_AUTOREFILL_USD is the dollar size of each
   * refill (default 5). STRIPE_AUTOREFILL_MAX_PER_PERIOD caps refills per
   * UTC month so a runaway loop cannot drain a card (default 20).
   */
  STRIPE_AUTOREFILL_USD?: string;
  STRIPE_AUTOREFILL_MAX_PER_PERIOD?: string;
  /**
   * Web2 subscription gate (contract 9474c6ab). When set to "1", the sponsor
   * middleware first asks the Stripe admission ladder whether the caller has a
   * subscription with quota, and if so draws from the Stripe-tracked balance
   * instead of the x402 platform-sponsor wallet. Unset = legacy behaviour
   * (every paid call rides x402, sponsor middleware unchanged).
   */
  UNBROWSE_BILLING_ENABLED?: string;
  /**
   * Platform-sponsor wallet (v6.15.0+) — funds first-call subsidies so route
   * creators see x402 earnings immediately. Both ADDRESS and KEY must be set
   * for the sponsor middleware to enable; otherwise it refuses-to-enable and
   * the standard 402 flow runs unchanged.
   */
  PLATFORM_SPONSOR_WALLET_ADDRESS?: string;
  PLATFORM_SPONSOR_WALLET_KEY?: string;
  /** Per-agent daily sponsor cap in USD (default 1.0). */
  SPONSOR_CAP_DAILY_USD?: string;
  /** Org-wide daily sponsor cap in USD (default 50.0). */
  SPONSOR_GLOBAL_DAILY_USD?: string;
  /**
   * Flywheel closure (v6.17+) — fraction of Stripe revenue carved off
   * into the sponsor pool on every subscription grant + auto-refill.
   * Default 1000 bps (10%) per arXiv 2604.00694 §3.5 "infrastructure
   * ≈ 10% platform toll". Set to 0 to disable the pool feed (sponsor
   * middleware falls back to PLATFORM_SPONSOR_WALLET_ADDRESS). See
   * backend/src/services/sponsor-pool.ts.
   */
  PLATFORM_REVENUE_TO_POOL_BPS?: string;
  /**
   * Admin-only operations key (v6.15.0+) — gates `/v1/admin/*` read surfaces
   * like sponsor-ledger. Separate from API_KEY (which doubles as a legacy
   * admin token for CLI back-compat) so the admin surface can rotate
   * independently. Set via `wrangler secret put ADMIN_KEY`. Routes return
   * 401 on missing OR mismatched header; the configured value is never
   * echoed in error responses.
   */
  ADMIN_KEY?: string;
  /**
   * Faremeter Flex facilitator (v6.16.0+) — self-hosted Solana flex
   * facilitator. Wires the four envs below into createFlexFacilitator on
   * Day 5; until then the bindings exist but are unused.
   */
  FLEX_PLATFORM_FACILITATOR_KEY?: string;     // secret (set via wrangler secret put)
  FLEX_PLATFORM_RECIPIENT_USDC_ATA?: string;  // public binding
  FLEX_REFUND_TIMEOUT_SLOTS?: string;         // public binding, defaults to "150"
  FLEX_DEADMAN_TIMEOUT_SLOTS?: string;        // public binding, defaults to "1000"
  /**
   * Global-hold USDC ATA — the wallet that accumulates the
   * domain-owner lane of every paid execute when the domain has NOT
   * been DNS-claimed (primitive doc
   * `docs/public/primitives/07-fair-split-and-claim.md`). When a
   * domain owner later verifies via routes/claim.ts, the backend
   * sweeps the accumulated balance from this wallet to the bound
   * domain wallet. MUST be the USDC associated token account of the
   * holding wallet (NOT the wallet base pubkey). When unset AND the
   * domain is unclaimed, `resolveThreeRecipientSplits` throws —
   * paid execute MUST NOT route the domain lane to platform on a
   * misconfigured deploy.
   */
  FLEX_GLOBAL_HOLD_USDC_ATA?: string;         // public binding
  /**
   * PayAI facilitator integration (v6.16+) — Solana feePayer pubkey used
   * when emitting the exact-scheme accept entry that delegates verify+settle
   * to `https://facilitator.payai.network`. Defaults to PayAI's published
   * Solana feePayer (`2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4` from
   * facilitator.payai.network/supported). Override in env only if you
   * operate a custom PayAI relationship.
   */
  PAYAI_FEEPAYER_PUBKEY?: string;             // public binding, optional
  /**
   * Flex sponsor session key (v6.16 Phase 4) — Ed25519 keypair the platform
   * uses to sign sponsor-tier Flex payment authorizations.
   * SECRET: set via `wrangler secret put FLEX_SPONSOR_SESSION_KEY_SECRET`.
   * Minimum recommended expiry window ~48h (432_000 slots @ 400ms/slot);
   * hard cap ~96h. Tracked via the EXPIRES_AT_SLOT binding below — both
   * must be rotated together.
   */
  FLEX_SPONSOR_SESSION_KEY_SECRET?: string;          // secret
  /** Public binding: slot at which the current session key expires (uint64 as string). */
  FLEX_SPONSOR_SESSION_KEY_EXPIRES_AT_SLOT?: string;
  /**
   * Sponsor-on-Flex (v6.16.0+) — when SPONSOR_USE_FLEX_SPLIT="1", the sponsor
   * middleware mints a Flex authorization against FLEX_SPONSOR_ESCROW_ADDRESS
   * signed by FLEX_SPONSOR_SESSION_KEY_SECRET (above). When unset/"0",
   * sponsor mode falls back to direct-SPL via `sendSponsorPayment`
   * (v6.15 behavior). Independent of Cascade — Phase 5 retires Cascade naming.
   */
  FLEX_SPONSOR_ESCROW_ADDRESS?: string;
  SPONSOR_USE_FLEX_SPLIT?: string;
  /**
   * Semantic-augmentation model (server-side, v6.16+). The endpoint
   * skeleton-enrichment LLM call moved server-side so the prompt + model
   * are configurable without a client release. Falls back to
   * UNBROWSE_AGENT_JUDGE_MODEL then a sane default in the service.
   */
  UNBROWSE_AGENT_SEMANTIC_MODEL?: string;
  UNBROWSE_AGENT_JUDGE_MODEL?: string;
  /** Disable server-side semantic augmentation entirely (returns no enrichment; client falls back to local heuristic). */
  UNBROWSE_AGENT_SEMANTIC_AUGMENT?: string;
  /**
   * LLM PII scrubber model (publish-path defense-in-depth, contract 101b1f77).
   * Inspects augmented endpoint descriptions/examples for PII the regex layer
   * missed. Defaults to `moonshotai/Kimi-K2.5` in
   * `backend/src/services/ai-scrub.ts`. NEBIUS_API_KEY (already declared) is
   * the cheap-model bearer used; soft-fails if unset.
   */
  UNBROWSE_AI_SCRUB_MODEL?: string;
  /**
   * Server-side aiko-compile LLM bearer (used by
   * `backend/src/services/unbrowse-llm.ts:compileAikoPromptToTree`).
   * Wave 2b: now load-bearing on `/v1/contract/declare` — when unset, the
   * route still admits the parent row but skips child-neuron compilation
   * and surfaces an honest evidence line.
   */
  UNBROWSE_LLM_API_KEY?: string;
  /**
   * NVIDIA direct-API key for the FREE fallback tier of the /contract LLM chain
   * (integrate.api.nvidia.com — rate-limited, NOT private). Zero-cost safety net when
   * the paid Nebius tiers are unavailable; mirrors aiko-ebllm's free lane.
   */
  NVIDIA_API_KEY?: string;
  /**
   * Optional override for the unbrowse-llm chat URL (used by the
   * lightweight `getUnbrowseLlmBinding` helper). The three-tier
   * tokenfactory chain in `compileAikoPromptToTree` is hardcoded and
   * does NOT read this — it's only used by callers that build their
   * own request directly.
   */
  UNBROWSE_LLM_CHAT_URL?: string;
  /**
   * External OS-level egress service for the `residential` proxy mode. The
   * Workers runtime cannot complete a TLS handshake to non-Cloudflare origins
   * via `cloudflare:sockets` startTls(), so the residential path delegates the
   * actual upstream fetch to a real-OS egress process reachable over plain
   * HTTPS. MINI_EGRESS_URL is its base URL; EGRESS_SECRET is the shared secret
   * sent as `X-Egress-Secret`. Set via `wrangler secret put`. When unset, the
   * residential path returns an honest error rather than degrading.
   */
  MINI_EGRESS_URL?: string;
  EGRESS_SECRET?: string;
}
// --- Agent identity ---

export interface AgentProfile {
  agent_id: string;       // Local key hash (SHA-256 of ubr_<hex>)
  name: string;
  created_at: string;
  wallet_address?: string;
  wallet_provider?: string;
  profile_origin?: "registered" | "recovered";
  recovered_at?: string;
  skills_discovered: string[];
  total_executions: number;
  total_feedback_given: number;
  tos_accepted_version: string | null;
  tos_accepted_at: string | null;
  // Lifecycle tracking (added for retention analytics)
  first_execution_at?: string;
  last_active_at?: string;
  activity_dates?: string[];
  // Install funnel attribution (signed token from landing page)
  landing_token?: string;
  // Flex onboarding (v6.16.0+) — set by `unbrowse setup` / /account pairing
  flex_escrow_address?: string;      // base58 PDA
  flex_session_key_address?: string; // base58 ed25519 pubkey
  flex_facilitator?: string;         // which facilitator URL this escrow points at; null = our default
}

// --- Shared types (mirrored from src/types/skill.ts) ---

export type SkillLifecycle = "active" | "deprecated" | "disabled";
export type OwnerType = "agent" | "marketplace" | "user";
export type Idempotency = "safe" | "unsafe";
export type VerificationStatus = "verified" | "unverified" | "failed" | "pending" | "disabled";
export type GraphVisibility = "shadow" | "public";

export interface SkillSubmissionProvenance {
  submitted_at: string;
  submitter_agent_id?: string;
  client_trace_version?: string;
  client_code_hash?: string;
  client_git_sha?: string;
  transport?: string;
  release_manifest_version?: string;
  release_manifest_verified?: boolean;
  release_manifest_reason?: string;
}

export interface SkillTrustMetadata {
  graph_visibility: GraphVisibility;
  promotion_reason: string;
  submission_count: number;
  unique_submitters: number;
  verified_release_submissions: number;
  unique_verified_submitters: number;
  verified_ratio: number;
  last_submission_at: string;
}

export interface EndpointCorroboration {
  submission_count: number;
  unique_submitters: number;
  verified_release_submissions: number;
  unique_verified_submitters: number;
  last_submission_at: string;
  submitter_agent_ids?: string[];
  verified_release_submitter_ids?: string[];
}

export interface AuthProfile {
  oauth_type?: string;
  csrf_sources: Array<"header" | "cookie" | "form">;
  refresh_policy: string;
  session_refresh_triggers: string[];
  rotation_policy?: string;
  storage_hint: string;
}

export interface CsrfPlan {
  source: "header" | "cookie" | "form";
  param_name: string;
  refresh_on_401: boolean;
  extractor_sequence: string[];
}

export interface OAuthPlan {
  grant_type: string;
  token_url?: string;
  scopes?: string[];
  refresh_path?: string;
}

export interface Transform {
  transform_id: string;
  version: string;
  request?: {
    sort_query_keys?: boolean;
    enforce_timezone_header?: boolean;
    sanitize_params?: string[];
  };
  response?: {
    flatten_arrays?: boolean;
    coerce_numeric_strings?: boolean;
    error_map?: Record<string, string>;
    strip_ephemeral_ids?: string[];
  };
}

export interface ResponseSchema {
  type: string;
  properties?: Record<string, ResponseSchema>;
  items?: ResponseSchema;
  required?: string[];
  anyOf?: ResponseSchema[];
  inferred_from_samples: number;
}

export interface ProofCommitment {
  response_body_hash: string;
  domain: string;
  url_template: string;
  method: string;
  response_status: number;
  captured_at: string;
  schema_hash?: string;
}

export interface ZkProof {
  proof_type: "tlsnotary" | "reclaim" | "commitment_only";
  proof_data: string;
  commitment: ProofCommitment;
  notary_id: string;
  generated_at: string;
  verified: boolean;
  verified_at?: string;
  verification_failure?: string;
}

export interface ProofVerificationResult {
  valid: boolean;
  proof_type: string;
  verified_at: string;
  domain_match: boolean;
  response_hash_match: boolean;
  failure_reason?: string;
  failure_kind?: "malformed_proof" | "malformed_hash" | "future_timestamp" | "domain_mismatch" | "unverified_proof" | null;
}

export interface ProofSummary {
  total_endpoints: number;
  endpoints_with_proof: number;
  verified_proofs: number;
  proof_types: Record<string, number>;
}

/**
 * Pointer to another contract's id in the /contract substrate. A
 * ContractRef is the string id of a cell contract whose satisfaction
 * is the precondition for this field's truth claim. See
 * ~/.claude/skills/contract/SKILL.md — "pointer principle". Wave-1
 * carrier of the runtime↔substrate isomorphism (organ b9c8a64d stage 1).
 * Tri-file synced with `src/types/skill.ts` and `frontend/src/lib/api.ts`.
 */
export type ContractRef = string;

export interface EndpointDescriptor {
  endpoint_id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "WS";
  url_template: string;
  /** LLM-generated description of what this endpoint returns, for semantic matching */
  description?: string;
  headers_template?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  csrf_plan?: CsrfPlan;
  oauth_plan?: OAuthPlan;
  transform_ref?: string;
  idempotency: Idempotency;
  verification_status: VerificationStatus;
  reliability_score: number;
  last_verified_at?: string;
  signature?: string;
  response_schema?: ResponseSchema;
  graphql_info?: {
    operation_name?: string;
  };
  trigger_url?: string;
  graph_visibility?: GraphVisibility;
  corroboration?: EndpointCorroboration;
  /** Loop 4 (B-023 follow-up): admission-time login-wall signal.
   *  Tri-file synced with `src/types/skill.ts` and `frontend/src/lib/api.ts`. */
  auth_walled?: boolean;
  /** Learned constraints from API errors and agent observations */
  constraints?: EndpointConstraint[];
  /** Agent-contributed best practices, tips, and gotchas */
  annotations?: EndpointAnnotation[];
  /** Optional proof metadata or client-side commitment */
  zk_proof?: ZkProof;
  /**
   * Owner-submitted provenance flag. Set to `true` by `promoteOfficialSubmission`
   * when a domain owner's canonical x402-supported endpoint is promoted out of
   * the triage queue. Tri-file synced with `src/types/skill.ts` and
   * `frontend/src/lib/api.ts`. Captured endpoints leave this undefined.
   */
  owner_submitted?: boolean;
}

export interface EndpointConstraint {
  /** The parameter or field this constraint applies to */
  param: string;
  /** Type of constraint */
  rule: "required" | "deprecated" | "format" | "enum" | "max_length" | "forbidden_in_body";
  /** Human-readable message from the API */
  message: string;
  /** How this constraint was learned */
  source: "api_error" | "agent";
  /** When this constraint was learned */
  learned_at: string;
}

/** Agent-contributed best practices and tips for using an endpoint */
export interface EndpointAnnotation {
  /** What the agent learned */
  text: string;
  /** Agent that contributed this */
  agent_id?: string;
  /** When this was contributed */
  created_at: string;
}

export interface DiscoveryCost {
  capture_ms: number;
  capture_tokens: number;
  response_bytes: number;
  captured_at: string;
}

export interface OperationBinding {
  key: string;
  description?: string;
  type?: string;
  semantic_type?: string;
  required?: boolean;
  source?: string;
  example_value?: string;
  ttl_ms?: number;
  single_use?: boolean;
  observed_at?: string;
}

export interface SkillOperationNode {
  operation_id: string;
  endpoint_id: string;
  method: string;
  url_template: string;
  trigger_url?: string;
  action_kind: string;
  resource_kind: string;
  description_in?: string;
  description_out?: string;
  response_summary?: string;
  requires: OperationBinding[];
  provides: OperationBinding[];
  negative_tags?: string[];
  example_request?: unknown;
  example_response_compact?: unknown;
  example_fields?: string[];
  confidence: number;
  observed_at?: string;
  auth_required?: boolean;
  page_metadata?: {
    localStorage?: Record<string, string>;
    embedded_json?: Record<string, unknown>[];
    captured_at?: string;
  };
}

export interface SkillOperationEdge {
  edge_id: string;
  from_operation_id: string;
  to_operation_id: string;
  binding_key: string;
  kind: "dependency" | "hint" | "parent_child" | "pagination" | "auth";
  confidence: number;
}

export interface SkillOperationGraph {
  generated_at: string;
  entry_operation_ids: string[];
  operations: SkillOperationNode[];
  edges: SkillOperationEdge[];
}

export interface SkillManifest {
  skill_id: string;
  version: string;
  schema_version: string;
  name: string;
  intent_signature: string;
  domain: string;
  subdomain?: string;
  description: string;
  owner_type: OwnerType;
  execution_type: "http" | "browser-capture";
  auth_profile_ref?: string;
  endpoints: EndpointDescriptor[];
  transform_ref?: string;
  lifecycle: SkillLifecycle;
  changelog?: string;
  created_at: string;
  updated_at: string;
  prev_version?: string;
  discovery_cost?: DiscoveryCost;
  /** Intent strings that contributed endpoints to this domain-level skill */
  /** Intent strings that contributed endpoints to this domain-level skill */
  intents?: string[];
  /** Set when vector indexing failed at publish time — eligible for reindex */
  needs_reindex?: boolean;
  /** Agent ID of the indexer who published this skill — used for Tier 1 attribution */
  indexer_id?: string;
  /**
  /**
   * Agent ID of the original publisher. Server-owned (security/audit-and-patches).
   * Subsequent publishes must come from this agent (or admin), otherwise the
   * publish is rejected. This is the primary ownership gate for PATCH
   * /skills/:id, PATCH /skills/:id/endpoints/:eid, and the domain-level merge
   * in publishSkill. Surfaced on `unbrowse.ai/<domain>` so consumers can see
   * who claimed the domain.
   */
  owner_agent_id?: string;
  /**
   * Whether the publisher has completed the .well-known HTTP probe for this
   * domain. Set by the verification handler, never by the publisher.
   */
  domain_verified?: boolean;
  /** ISO timestamp of the .well-known probe. */
  domain_verified_at?: string;
  /** All agents who contributed endpoints to this skill, with their shares */
  contributors?: SkillContributor[];
  /**
   * Skill-level recipient wallet for x402 payouts (legacy Cascade Split
   * address pre-v6.16; on Flex this is simply the primary contributor's
   * wallet, surfaced as `payTo` in the payment terms).
   */
  split_config?: string;
  /**
   * Site-owner opt-in for revenue sharing.
   * When true, the domain operator will receive a compensation share for
   * traffic routed through their endpoints (Tier 2 site-owner compensation).
   */
  owner_compensation_opt_in?: boolean;
  /**
   * Solana pubkey of the verified domain owner. SERVER-OWNED. Stamped only
   * by the DNS-claim verify endpoint at backend/src/routes/claim.ts after
   * the dual-DoH attestation passes (see backend/src/services/domain-claim.ts
   * for the verification primitive). PATCH /v1/skills/:id MUST reject any
   * user-supplied value for this field.
   */
  owner_wallet_address?: string;
  /**
   * USDC ATA derived from owner_wallet_address. SERVER-OWNED. Required by
   * computeFlexSplits in backend/src/services/flex.ts to route the OWNER_BPS
   * lane; until this field is populated the owner branch is dormant.
   */
  owner_wallet_usdc_ata?: string;
  /**
   * ISO timestamp the DNS-TXT verify succeeded. SERVER-OWNED. Surfaced on
   * the public /v1/claim/status endpoint so a site owner can confirm their
   * binding without re-running the verify flow.
   */
  owner_wallet_verified_at?: string;
  /**
   * Per-skill platform markup in basis points (1 bp = 0.01%).
   *
   * Optional override for the global PLATFORM_BPS constant in
   * services/flex.ts. When set, computeFlexSplits uses this value as
   * the platform cut for THIS skill's x402 settlements; otherwise
   * falls back to PLATFORM_BPS (5000 = 50%).
   *
   * Clamped to [500, 8000] at compute time (5% floor, 80% ceiling)
   * matching the Pontus / ABK Labs 2026-05-21 brief on Flex's
   * configurable markup range. Out-of-range values are coerced rather
   * than rejected so a misconfigured skill still settles cleanly at
   * the nearest bound.
   *
   * Site-owner share (OWNER_BPS) and the indexer pool are computed
   * from the REMAINDER (10000 - effective platform_bps), so this
   * single knob shifts margin between the platform and the
   * indexer+owner pool without touching the owner / indexer math.
   */
  markup_bps?: number;
  /**
   * Optional base price override in USD per execution.
   * If unset, the platform default base price applies.
   */
  base_price_usd?: number;
  /** Server-owned submission provenance for staged promotion and abuse analysis. */
  provenance_events?: SkillSubmissionProvenance[];
  /** Server-owned graph trust state. */
  trust?: SkillTrustMetadata;
  /** Roll-up of ZK proof verification status across endpoints. */
  proof_summary?: ProofSummary;
  /**
   * ISO timestamp when the publishing agent reviewed this skill via
   * `unbrowse_review` before share. Skills missing this field publish
   * with heuristic descriptions and rank below reviewed peers in resolve.
   */
  reviewed_at?: string;
  /**
   * Pricing mode for this skill — additive over the legacy
   * `base_price_usd` field. When present, the route reads from this
   * discriminated union; when absent, the route falls back to
   * `base_price_usd` as `{ mode: "fixed", price_usd }`.
   *
   * - `fixed`: caller is billed a flat `price_usd` per execution.
   * - `metered`: caller authorizes a ceiling
   *   (`max_units * cost_per_unit_uc` µ¢) and is settled for the
   *   actual units consumed.
   */
  pricing?: SkillPricing;
  /**
   * Owner-controlled marketplace visibility. `public` (default) means the
   * skill is surfaced in the public card list and the resolve/search graph
   * index. `private` removes it from every cross-agent surface while the
   * owner still sees it under `GET /v1/account/skills`. Toggled by
   * `PATCH /v1/skills/:id`, which also adds/removes the skill from the
   * graph index so resolve stays consistent.
   */
  visibility?: "public" | "private";
  /**
   * Operation graph for this skill — populated by `buildSkillOperationGraph`
   * at capture time. Exposed verbatim at GET /v1/skills/:id/graph so callers
   * can introspect requires/yields edges and parameter schemas without reading source.
   */
  operation_graph?: SkillOperationGraph;
}

/**
 * Discriminated union for skill pricing. Phase 3 of x402-routing-v6.16.
 *
 * `unit` on metered is a free-form label (e.g. "input_token",
 * "output_token", "page_view") — purely descriptive metadata for
 * accounting + agent UI. The economics use `cost_per_unit_uc` (micro-
 * cents per unit) and `max_units` (the ceiling the caller authorizes
 * at verify time).
 */
export type SkillPricing =
  | { mode: "fixed"; price_usd: number }
  | { mode: "metered"; unit: string; cost_per_unit_uc: number; max_units: number };

export interface SkillListEndpointPreview {
  endpoint_id: string;
  method: EndpointDescriptor["method"];
  verification_status: VerificationStatus;
  reliability_score: number;
}

export interface SkillListItem {
  skill_id: string;
  version: string;
  name: string;
  intent_signature: string;
  domain: string;
  subdomain?: string;
  description: string;
  owner_type: OwnerType;
  execution_type: "http" | "browser-capture";
  lifecycle: SkillLifecycle;
  created_at: string;
  updated_at: string;
  endpoint_count: number;
  avg_reliability_score: number;
  endpoints: SkillListEndpointPreview[];
}

export interface SkillContributor {
  /** Agent ID of the contributor */
  agent_id: string;
  /** Solana wallet address for payouts (from agent registration) */
  wallet_address?: string;
  /** Number of endpoints this agent contributed */
  endpoints_contributed: number;
  /** Cumulative attribution delta score */
  cumulative_delta: number;
  /** Share out of 100 for payout splits (computed from relative contribution; legacy Cascade Split model pre-v6.16, Flex bps-share on Flex). */
  share: number;
  /** When this agent first contributed */
  first_contributed_at: string;
  /** When this agent last contributed */
  last_contributed_at: string;
}
export interface VersionVerification {
  version: string;
  status: "pass" | "fail";
  verified_at: string;
  agent_id?: string;
}

export interface EndpointStats {
  total_executions: number;
  successful_executions: number;
  consecutive_failures: number;
  avg_latency_ms: number;
  feedback_sum: number;
  feedback_count: number;
  drift_count: number;
  last_execution_at?: string;
  last_success_at?: string;
  auto_deprecated_at?: string;
  /** Version-keyed verification history — tracks which CLI versions pass/fail */
  version_history?: VersionVerification[];
}

export interface ExecutionTrace {
  trace_id: string;
  skill_id: string;
  endpoint_id: string;
  started_at: string;
  completed_at: string;
  success: boolean;
  session_id?: string;
  step_index?: number;
  state_hash?: string;
  candidate_count?: number;
  selected_operation_id?: string;
  reachable_operation_count?: number;
  api_call_count?: number;
  status_code?: number;
  error?: string;
  result?: unknown;
  drift?: { drifted: boolean; added_fields: string[]; removed_fields: string[]; type_changes: Array<{ path: string; was: string; now: string }> };
  tokens_used?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
  trace_version?: string;
}

export type RoutingRunType = "single_shot" | "long_running";
export type RoutingTelemetrySource =
  | "route-cache"
  | "marketplace"
  | "graph"
  | "live-capture"
  | "browser-action"
  | "defer";
export type RoutingSessionOutcome = "success" | "failure" | "defer" | "abandon";

export interface RoutingContextBuckets {
  role: "general" | "developer" | "researcher" | "analyst" | "operator" | "unknown";
  cost_sensitivity: "low" | "medium" | "high" | "unknown";
  latency_sensitivity: "low" | "medium" | "high" | "unknown";
  output_preference: "structured" | "raw" | "mixed" | "unknown";
  task_horizon: "short" | "long" | "unknown";
  has_prior_history: boolean;
}

export interface RoutingCandidateSnapshot {
  candidate_id: string;
  rank: number;
  skill_id?: string;
  endpoint_id: string;
  operation_id?: string;
  route_fingerprint: string;
  score: number;
  chosen: boolean;
  reachable: boolean;
  rejection_reason?: string;
  feature_snapshot: {
    method?: string;
    has_response_schema: boolean;
    dom_extraction: boolean;
    verification_status?: string;
    reliability_score?: number;
    unsafe_action_score?: number;
  };
}

export interface RoutingTelemetryBaseEvent {
  event_id: string;
  event_type:
    | "routing_session_started"
    | "routing_candidates_ranked"
    | "routing_step_executed"
    | "routing_session_completed";
  session_id: string;
  created_at: string;
  trace_version?: string;
  anonymized_agent_id?: string;
  top_level_intent: string;
  normalized_domains: string[];
  run_type: RoutingRunType;
}

export interface RoutingSessionEvent extends RoutingTelemetryBaseEvent {
  event_type: "routing_session_started";
  context_buckets: RoutingContextBuckets;
}

export interface RoutingCandidateEvent extends RoutingTelemetryBaseEvent {
  event_type: "routing_candidates_ranked";
  step_id: string;
  step_index: number;
  source: RoutingTelemetrySource;
  state_hash_before: string;
  candidate_count: number;
  reachable_operation_count?: number;
  available_binding_count?: number;
  missing_binding_count?: number;
  selected_endpoint_id?: string;
  selected_operation_id?: string;
  candidates: RoutingCandidateSnapshot[];
}

export interface RoutingStepEvent extends RoutingTelemetryBaseEvent {
  event_type: "routing_step_executed";
  step_id: string;
  step_index: number;
  source: RoutingTelemetrySource;
  state_hash_before: string;
  state_hash_after: string;
  selected_skill_id?: string;
  selected_endpoint_id?: string;
  selected_operation_id?: string;
  reachable_operation_count?: number;
  available_binding_count?: number;
  missing_binding_count?: number;
  candidate_count: number;
  execution_latency_ms?: number;
  status_code?: number;
  success?: boolean;
  failure_reason?: string;
  schema_fingerprint?: string;
  response_hash?: string;
  cross_domain_transition: boolean;
  retry_count: number;
  user_override: boolean;
  did_step_unlock_next_step: boolean;
  required_recovery: boolean;
}

export interface RoutingSessionCompletedEvent extends RoutingTelemetryBaseEvent {
  event_type: "routing_session_completed";
  completed_at: string;
  final_outcome: RoutingSessionOutcome;
  final_success: boolean;
  total_steps: number;
  total_candidates_ranked: number;
  total_api_calls: number;
  retry_count: number;
  user_override: boolean;
  required_recovery: boolean;
}

export type RoutingTelemetryEvent =
  | RoutingSessionEvent
  | RoutingCandidateEvent
  | RoutingStepEvent
  | RoutingSessionCompletedEvent;

export interface RoutingTelemetrySummary {
  generated_at: string;
  window_days: number;
  events: number;
  sessions: number;
  long_running_sessions: number;
  successful_sessions: number;
  avg_steps_per_session: number;
  avg_candidates_per_step: number;
  total_api_calls: number;
  outcomes: Array<{ outcome: RoutingSessionOutcome; count: number }>;
  sources: Array<{ source: RoutingTelemetrySource; count: number }>;
  source_performance: Array<{
    source: RoutingTelemetrySource;
    step_count: number;
    success_count: number;
    success_rate: number;
    avg_latency_ms: number;
    median_latency_ms: number;
  }>;
  top_intents: Array<{
    intent: string;
    sessions: number;
    steps: number;
  }>;
  top_domains: Array<{
    domain: string;
    sessions: number;
    steps: number;
  }>;
}

export interface ValidationResult {
  valid: boolean;
  hardErrors: string[];
  softWarnings: string[];
}

export interface OrchestrationTiming {
  search_ms: number;
  get_skill_ms: number;
  execute_ms: number;
  total_ms: number;
  source: "marketplace" | "live-capture" | "dom-fallback" | "route-cache";
  cache_hit: boolean;
  candidates_found: number;
  candidates_tried: number;
  skill_id?: string;
  tokens_saved: number;
  response_bytes: number;
  time_saved_pct: number;
  tokens_saved_pct: number;
  baseline_total_ms?: number;
  actual_total_ms?: number;
  time_saved_ms?: number;
  baseline_cost_uc?: number;
  actual_cost_uc?: number;
  cost_saved_uc?: number;
  paid_search_uc?: number;
  paid_execution_uc?: number;
}

export interface PerfStats {
  total_resolves: number;
  marketplace_hits: number;
  cache_hits: number;
  live_captures: number;
  dom_fallbacks: number;
  avg_total_ms: number;
  avg_search_ms: number;
  avg_execute_ms: number;
  avg_marketplace_ms: number;
  avg_cache_ms: number;
  avg_live_capture_ms: number;
  p95_total_ms: number;
  total_tokens_saved: number;
  total_response_bytes: number;
  avg_time_saved_pct: number;
  avg_tokens_saved_pct: number;
  last_updated_at: string;
}

export type FunnelEventName =
  | "cli_invoked"
  | "setup_completed"
  | "server_autostart_succeeded"
  | "registration_succeeded"
  | "resolve_started"
  | "resolve_completed"
  | "search_started"
  | "search_completed"
  | "default_browser_set"
  | `${string}_failed`;

export type FunnelEventSource =
  | "host"
  | "setup"
  | "cli-first-seen"
  | "cli"
  | "agent"
  | "server"
  | (string & {});

export interface FunnelEvent {
  event_id: string;
  install_id: string;
  session_id?: string;
  name: FunnelEventName | string;
  source: FunnelEventSource;
  host_type?: string;
  landing_experiment_id?: string;
  landing_variant_id?: string;
  landing_visitor_id?: string;
  landing_session_id?: string;
  landing_token_id?: string;
  created_at: string;
  properties?: Record<string, unknown>;
  agent_id?: string | null;
}

export interface FunnelFailureBucket {
  key: string;
  count: number;
}

export interface FunnelHostSummary {
  host_type: string;
  installs: number;
  registrations: number;
  first_resolve_started: number;
  first_resolve_succeeded: number;
  second_success: number;
  repeat_success: number;
  power_users: number;
}

export interface FunnelSummary {
  generated_at: string;
  window_days: number;
  events: number;
  totals: {
    installs: number;
    cli_invoked: number;
    setup_completed: number;
    server_autostart_succeeded: number;
    registrations: number;
    search_started: number;
    search_completed: number;
    first_resolve_started: number;
    first_resolve_succeeded: number;
    second_success: number;
    repeat_success: number;
    power_users: number;
    abandonment_24h: number;
    default_browser_set: number;
  };
  default_browser_hosts?: FunnelFailureBucket[];
  rates: {
    cli_invoked_from_install: number;
    registration_from_cli: number;
    first_resolve_started_from_registered: number;
    first_resolve_succeeded_from_started: number;
    second_success_from_first_success: number;
    repeat_success_from_first_success: number;
    power_from_first_success: number;
  };
  latency_ms: {
    cli_to_registration_p50: number | null;
    cli_to_first_resolve_start_p50: number | null;
    cli_to_first_success_p50: number | null;
    registration_to_first_success_p50: number | null;
  };
  failures: {
    total: number;
    top_stages: FunnelFailureBucket[];
    top_reasons: FunnelFailureBucket[];
  };
  hosts: FunnelHostSummary[];
}

export interface MinerBounty {
  id: string;
  title: string;
  domain: string;
  description: string;
  reward_multiplier: number;
  difficulty: "easy" | "medium" | "hard";
  category: string;
  claimed: boolean;
}

export interface MinerQuest {
  id: string;
  title: string;
  description: string;
  target_domain?: string;
  reward_multiplier: number;
  type: "first-indexer" | "route-count" | "domain-sprint";
  deadline: string;
  progress?: number;
  goal?: number;
}

export interface InstallTelemetryEvent {
  event_id: string;
  install_id: string;
  source: string;
  host_type?: string;
  landing_experiment_id?: string;
  landing_variant_id?: string;
  landing_visitor_id?: string;
  landing_session_id?: string;
  landing_token_id?: string;
  skill?: string;
  skill_version?: string;
  status?: string;
  created_at: string;
  properties?: Record<string, unknown>;
  agent_id?: string | null;
}

export interface InstallTelemetryHostSummary {
  host_type: string;
  installs: number;
  invoked: number;
  registered: number;
  first_resolve_started: number;
  first_resolve_succeeded: number;
}

export interface InstallTelemetrySummary {
  generated_at: string;
  window_days: number;
  events: number;
  totals: {
    reported_installs: number;
    host_reported_installs: number;
    setup_reported_installs: number;
    cli_first_seen_installs: number;
    invoked_installs: number;
    uninvoked_installs: number;
    registered_installs: number;
    first_resolve_started: number;
    first_resolve_succeeded: number;
  };
  rates: {
    invoked_from_reported_install: number;
    registration_from_reported_install: number;
    first_resolve_started_from_reported_install: number;
    first_resolve_succeeded_from_reported_install: number;
  };
  hosts: InstallTelemetryHostSummary[];
}

export type WebTelemetryEventName =
  | "landing_page_viewed"
  | "install_section_viewed"
  | "first_task_section_viewed"
  | "install_command_copied"
  | "first_task_command_copied"
  | (string & {});

export interface WebTelemetryEvent {
  event_id: string;
  visitor_id: string;
  session_id: string;
  name: WebTelemetryEventName | string;
  experiment_id?: string;
  variant_id?: string;
  path?: string;
  referrer?: string | null;
  ip_prefix_hash?: string;
  created_at: string;
  properties?: Record<string, unknown>;
}

export interface AcquisitionReferrerSummary {
  referrer: string;
  sessions: number;
}

export interface AcquisitionSectionSummary {
  section_id: string;
  sessions: number;
  share_of_landing: number;
  install_copy_rate_after_view: number;
}

export interface AcquisitionClickSummary {
  target_id: string;
  sessions: number;
  click_through_rate_from_landing: number;
}

export interface AcquisitionDimensionSummary {
  value: string;
  sessions: number;
  share_of_landing: number;
  install_copy_rate_after_view: number;
}

export interface AcquisitionSummary {
  generated_at: string;
  window_days: number;
  events: number;
  filters?: {
    variant_id?: string;
    icp?: string;
    experiment_id?: string;
  };
  totals: {
    visitors: number;
    sessions: number;
    landing_views: number;
    install_section_views: number;
    first_task_section_views: number;
    install_command_copies: number;
    first_task_command_copies: number;
    landing_without_install_view: number;
    install_view_without_copy: number;
    first_task_view_without_copy: number;
    install_copy_without_first_task: number;
  };
  rates: {
    install_section_view_from_landing: number;
    install_copy_from_landing: number;
    install_copy_from_install_view: number;
    first_task_view_from_install_copy: number;
    first_task_copy_from_first_task_view: number;
    first_task_copy_from_install_copy: number;
  };
  top_referrers: AcquisitionReferrerSummary[];
  sections: AcquisitionSectionSummary[];
  icp_paths: AcquisitionClickSummary[];
  dimensions: {
    utm_source: AcquisitionDimensionSummary[];
    utm_medium: AcquisitionDimensionSummary[];
    utm_campaign: AcquisitionDimensionSummary[];
    utm_content: AcquisitionDimensionSummary[];
    utm_term: AcquisitionDimensionSummary[];
    inferred_icp: AcquisitionDimensionSummary[];
  };
}

export interface CampaignFeedbackRow {
  channel: string;
  campaign_id: string;
  campaign_name?: string;
  content_id?: string;
  content_type?: string;
  creative_id?: string;
  ad_id?: string;
  adset_id?: string;
  inferred_icp?: string;
  variant_id?: string;
  experiment_id?: string;
  landing_sessions: number;
  content_page_sessions: number;
  install_section_views: number;
  install_command_copies: number;
  reported_installs: number;
  setup_completed: number;
  cli_invoked: number;
  registrations: number;
  first_resolve_started: number;
  first_resolve_succeeded: number;
  default_browser_set: number;
  total_sessions: number;
  successful_sessions: number;
  install_copy_rate_from_landing: number;
  reported_install_rate_from_copy: number;
  first_resolve_success_rate_from_install: number;
  session_success_rate: number;
}

export interface CampaignFeedbackSummary {
  generated_at: string;
  window_days: number;
  filters?: {
    channel?: string;
    campaign_id?: string;
    content_id?: string;
    inferred_icp?: string;
    variant_id?: string;
    experiment_id?: string;
  };
  rows: CampaignFeedbackRow[];
}

export type LandingVariantStatus = "draft" | "active" | "archived";

export interface LandingVariantContent {
  hero_eyebrow?: string;
  hero_title?: string;
  hero_highlight?: string;
  hero_body?: string;
  hero_supporting?: string;
  trust_items?: string[];
  definition_title?: string;
  definition_body?: string;
  install_summary?: string;
}

export interface LandingVariant {
  variant_id: string;
  slug: string;
  name: string;
  icp: string;
  experiment_id: string;
  status: LandingVariantStatus;
  weight: number;
  content: LandingVariantContent;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface LandingVariantSummaryItem {
  variant_id: string;
  slug: string;
  name: string;
  icp: string;
  experiment_id: string;
  status: LandingVariantStatus;
  weight: number;
  landing_views: number;
  install_section_views: number;
  install_command_copies: number;
  install_section_view_rate: number;
  install_command_copy_rate: number;
}

export interface LandingVariantSummary {
  generated_at: string;
  window_days: number;
  variants: LandingVariantSummaryItem[];
}

export interface LandingHomepageAnalyticsSummary {
  generated_at: string;
  window_days: number;
  experiment_id: string;
  control_variant_id: string;
  winner_variant_id?: string;
  winner_angle_family?: string;
  live_weights: Array<{ variant_id: string; status: string; weight: number }>;
  shadow_queue: Array<{ variant_id: string; label: string; source: string; rationale?: string }>;
  canaries: Array<{ variant_id: string; label: string; started_at?: string }>;
  optimizer_runs: Array<{ ran_at: string; winner_variant_id?: string; winner_angle_family?: string; notes?: string }>;
  variants: Array<{
    variant_id: string;
    label: string;
    status: string;
    source: string;
    angle_family: string;
    weight: number;
    rationale?: string;
    canary_started_at?: string;
    disabled_reason?: string;
    generated_at?: string;
    landing_visitors: number;
    landing_sessions: number;
    hero_views: number;
    install_section_views: number;
    install_command_copies: number;
    install_started: number;
    setup_completed: number;
    registrations: number;
    first_resolve_started: number;
    first_resolve_succeeded: number;
    bounce_sessions: number;
    no_exploration_sessions: number;
    avg_exploration_depth: number;
    max_scroll_bucket_reached: number;
    rates: {
      install_copy_from_landing: number;
      install_started_from_landing: number;
      setup_completed_from_landing: number;
      first_resolve_succeeded_from_landing: number;
      first_resolve_succeeded_from_install_started: number;
    };
    top_referrers: Array<{ referrer: string; sessions: number }>;
    top_campaigns: Array<{ campaign: string; sessions: number }>;
  }>;
}

export interface LandingHomepageAnalyticsSummary {
  generated_at: string;
  window_days: number;
  experiment_id: string;
  control_variant_id: string;
  winner_variant_id?: string;
  winner_angle_family?: string;
  live_weights: Array<{ variant_id: string; status: string; weight: number }>;
  shadow_queue: Array<{ variant_id: string; label: string; source: string; rationale?: string }>;
  canaries: Array<{ variant_id: string; label: string; started_at?: string }>;
  optimizer_runs: Array<{ ran_at: string; winner_variant_id?: string; winner_angle_family?: string; notes?: string }>;
  variants: Array<{
    variant_id: string;
    label: string;
    status: string;
    source: string;
    angle_family: string;
    weight: number;
    rationale?: string;
    canary_started_at?: string;
    disabled_reason?: string;
    generated_at?: string;
    landing_visitors: number;
    landing_sessions: number;
    hero_views: number;
    install_section_views: number;
    install_command_copies: number;
    install_started: number;
    setup_completed: number;
    registrations: number;
    first_resolve_started: number;
    first_resolve_succeeded: number;
    bounce_sessions: number;
    no_exploration_sessions: number;
    avg_exploration_depth: number;
    max_scroll_bucket_reached: number;
    rates: {
      install_copy_from_landing: number;
      install_started_from_landing: number;
      setup_completed_from_landing: number;
      first_resolve_succeeded_from_landing: number;
      first_resolve_succeeded_from_install_started: number;
    };
    top_referrers: Array<{ referrer: string; sessions: number }>;
    top_campaigns: Array<{ campaign: string; sessions: number }>;
  }>;
}
