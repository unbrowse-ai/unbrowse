export interface Env {
  API_KEY: string;
  LANDING_PUBLISH_KEY?: string;
  /** Shared secret for /v1/blog/publish. Set via `wrangler secret put BLOG_PUBLISH_KEY`. */
  BLOG_PUBLISH_KEY?: string;
  DATABASE_URL?: string;
  EMERGENTDB_API_KEY: string;
  EMERGENTDB_TIMEOUT_MS?: string;
  NEBIUS_API_KEY: string;
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
  ENVIRONMENT?: string; // "production" | "staging"
  PAYMENTS_ENABLED?: string;
  CREDITS_ENABLED?: string;
  X402_SEARCH_ENABLED?: string;
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
  /** Wallet address that receives x402 skill-access payments. */
  PAYMENT_RECIPIENT?: string;
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
