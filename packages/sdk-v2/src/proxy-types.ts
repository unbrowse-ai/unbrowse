// Shape of POST /v1/proxy responses on the worker.

export interface WorkerProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  proxy_used: "direct" | "residential";
  duration_ms: number;
  egress_ip?: string;
  _request_id?: string;
  /** True when a direct 429 was retried via the paid residential fallback. */
  fallback_used?: boolean;
  /** USD toll charged for the paid residential fallback on this call. */
  surcharge_usd?: number;
  /** Solver outcome when captcha auto-solve fired. Present only when captcha was dispatched. */
  captcha_solver_status?: "dispatched" | "token_received" | "replay_success" | "failed_no_sitekey" | "failed_no_wallet" | "failed_solver_error" | "failed_replay_blocked" | "byok_dispatched" | "byok_token_received";
  /** What the SDK did with the on-chain route lookup, when enabled. */
  onchain_decision?: {
    action: "replay" | "live_fetch_direct" | "live_fetch_iproyal" | "live_fetch_with_captcha";
    endpoint_id?: string;
    commitment?: string;
    attested_on_chain?: boolean;
    preference_bias?: "strong" | "weak" | null;
    reason: string;
  };
  /** Which auth path settled this call. Worker surfaces this so the SDK can audit. */
  auth_used?: "api_key" | "x402" | "wallet_only";
}

export interface WorkerProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  /** Existing field — kept for backward compat. `egress.mode = "residential"` is the new form. */
  proxy?: "direct" | "residential";
  timeout_ms?: number;
  /** Egress config (preferred over the legacy `proxy` field when both are present). */
  egress?: EgressConfig;
  /** Captcha auto-solve options. Absent → no auto-solve. */
  captcha?: CaptchaOptions;
  /** On-chain route lookup options. Absent → no on-chain check. */
  onchain?: OnChainRouteLookup;
  /** Per-call wallet override. When set, this wallet signs the x402 payment proof instead of the client-level wallet. */
  wallet?: WalletSigner;
}

export interface EgressConfig {
  /** Egress mode. `direct` = worker's own IP. `residential` = IPRoyal pool. */
  mode: "direct" | "residential";
  /** IPRoyal country-lock suffix (e.g. "my" for Malaysia). Appended to password as `_country-<cc>`. */
  country?: string;
  /** IPRoyal sticky-session id. Appended to password as `_session-<id>`. */
  session_id?: string;
}

/**
 * Captcha solver options. Two modes per the contract:
 *
 * Turnkey (default — charges through the consumer's wallet via pay.sh):
 *   { auto_solve: true, vendor: "auto" | "2captcha" | "capzy" }
 *
 * BYOK (consumer brings their own solver key — calls the solver directly
 * from the SDK runtime; the worker still observes the solved token and
 * replays the original request):
 *   { auto_solve: true, mode: "byok", vendor: "capsolver" | "2captcha", api_key: "..." }
 *
 * Wallet requirement applies regardless of mode: BYOK bypasses the solve
 * dispatch but NOT the underlying /v1/proxy call (the worker hop still
 * settles via the consumer's wallet). A wallet-less BYOK caller returns
 * 402 x402_no_wallet on the relayed fetch.
 */
export interface CaptchaOptions {
  auto_solve: boolean;
  /** Turnkey by default. "byok" makes the SDK call the solver directly. */
  mode?: "turnkey" | "byok";
  /** Solver vendor. Default "auto" picks Capzy when UNBROWSE_CAPZY_KEY is set, else paysponge/2Captcha. */
  vendor?: "auto" | "2captcha" | "capzy" | "capsolver";
  /** Required when mode === "byok". Never echoed back in the response. */
  api_key?: string;
}

/**
 * On-chain route lookup options. When enabled, the worker consults three
 * layers before deciding how to fetch:
 *   1. Route cache ledger (contracts.jsonl) — hash-chained, append-only.
 *   2. Chrome KV-chain preference bias (bookmarkDomains / recentDomains).
 *   3. Solana IQ attestation (IqClient.readRows) — slowest, runs only if 1+2 miss.
 *
 * Each tier is a pointer, not a payload. The decision carries the
 * `commitment` (sha256) of the captured route, never the body.
 */
export interface OnChainRouteLookup {
  lookup: boolean;
  /** Read preference bias from the chrome KV-chain. Default true. */
  use_preferences?: boolean;
  /** Route-cache staleness window in ms. Default 86_400_000 (24h). */
  stale_after_ms?: number;
  /** Intent string, used for tier-1 route-cache matching. */
  intent?: string;
  /** Context URL, used for tier-1 route-cache matching. */
  context_url?: string;
}

export interface WorkerProxyCapabilities {
  modes: Array<"direct" | "residential">;
  residential_configured: boolean;
  max_body_bytes: number;
  default_timeout_ms: number;
  _request_id?: string;
}

/**
 * Wallet signer config. A wallet signature is the PRIMARY credential
 * (backend/src/middleware/auth.ts:89-145); an API key is an optional
 * wrapper that binds a wallet to a sponsor escrow.
 *
 * Provide ONE of:
 *   - `adapter: "pay.sh"` (default) + optional `key_path` — SDK env-driven
 *   - `signature: <pre-signed trio>` — caller already signed externally
 *
 * When neither `wallet` (per-call) nor the client-level wallet is set,
 * paid paths return 402 with the `x402_no_wallet` sub-state.
 */
export interface WalletSigner {
  adapter?: "pay.sh";
  key_path?: string;
  /** Pre-signed auth trio (signature, message, pubkey). When set, `adapter` and `key_path` are ignored. */
  signature?: { signature: string; message: string; pubkey: string };
}
