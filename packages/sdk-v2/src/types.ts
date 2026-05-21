// Minimal local types for sdk v7. Mirrors backend response shapes from
// backend/src/routes/{resolve,execute,search,health,account}.ts. Kept local
// (not re-exported from packages/sdk) so v7 can ship without depending on the
// legacy package; the legacy package will be deprecated in favor of this one.

export interface ResolveInput {
  intent: string;
  contextUrl?: string;
  domain?: string;
  limit?: number;
}

export interface AvailableEndpoint {
  endpoint_id: string;
  skill_id: string;
  url: string;
  method: string;
  description?: string;
  score?: number;
  schema?: unknown;
  requires?: string[];
  yields?: string[];
  action_kind?: string;
  sample_values?: Record<string, unknown>;
}

export interface ResolveResponse {
  status: "ok" | "empty" | "browse_session_open" | "auth_required" | "no_cached_match";
  available_operations?: AvailableEndpoint[];
  available_endpoints?: AvailableEndpoint[];
  next_step?: string;
  suggested_commands?: string[];
  request_id?: string;
  _request_id?: string;
}

export interface ExecuteInput {
  endpoint_id?: string;
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
  body?: unknown;
  raw?: boolean;
  extract?: string;
  limit?: number;
  idempotency_key?: string;
  // Where the outbound HTTP fetch happens.
  // - "worker-proxy" (default): worker server-side fetches the captured URL.
  //   Hides the user IP, lets the worker apply auth/quota/anti-bot, and is the
  //   only path that supports proxy:"residential". Requires the URL or
  //   endpoint_id to be resolvable into a captured target.
  // - "direct": SDK fetches the URL directly from the client. No worker hop.
  //   Lower latency, but exposes the user IP and bypasses sponsor metering.
  transport?: "worker-proxy" | "direct";
  // Routing for the outbound fetch when transport is "worker-proxy".
  // - "direct" (default): worker fetches from its own egress IP.
  // - "residential": worker tunnels through IProyal residential proxy.
  //   Requires IPROYAL_USER/IPROYAL_PASS to be set on the worker; returns
  //   502 with `error: "upstream_fetch_failed"` if not configured.
  proxy?: "direct" | "residential";
}

export interface ExecuteResponse {
  success: boolean;
  status_code?: number;
  data?: unknown;
  raw?: unknown;
  endpoint_id?: string;
  trace?: unknown;
  request_id?: string;
  _request_id?: string;
}

export interface SearchInput {
  intent: string;
  domain?: string;
  limit?: number;
}

export interface SearchHit {
  endpoint_id: string;
  skill_id: string;
  url: string;
  score: number;
  snippet?: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  _request_id?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version?: string;
  uptime_s?: number;
  _request_id?: string;
}

export interface AccountMe {
  user_id: string;
  email: string;
  email_verified: boolean;
  created_at: string;
  _request_id?: string;
}

export interface AccountCredits {
  user_id: string;
  balance_usd: number;
  used_usd: number;
  granted_usd: number;
  _request_id?: string;
}

export interface SponsorStatus {
  agent_id: string;
  date: string;
  agent_remaining_usd: number;
  agent_cap_usd: number;
  global_remaining_usd: number;
  global_cap_usd: number;
  _request_id?: string;
}

export interface ApiKey {
  keyId: string;
  name: string;
  created_at: string | null;
  revoked_at: string | null;
  funding: ApiKeyFunding | null;
}

export interface ApiKeyFunding {
  wallet_address?: string;
  credit_budget_usd?: number;
  bound_at?: string;
}

export interface ApiKeyCreateInput {
  name?: string;
}

export interface ApiKeyCreateResponse {
  keyId: string;
  key: string;          // plaintext, returned ONCE; store it now
  name: string;
  created_at: string;
  message: string;
  rotated_from?: string;
  _request_id?: string;
}

export interface ApiKeyListResponse {
  keys: ApiKey[];
  _request_id?: string;
}

export interface ApiKeyRevokeResponse {
  ok: true;
  keyId: string;
  revoked: true;
  _request_id?: string;
}

export interface UnbrowseClientOptions {
  apiKey?: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  defaultHeaders?: Record<string, string>;
  logLevel?: "off" | "error" | "warn" | "info" | "debug";
}

export interface RequestOptions {
  timeout?: number;
  maxRetries?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}
