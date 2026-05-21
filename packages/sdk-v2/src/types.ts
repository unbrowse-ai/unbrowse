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

export interface AccountUsage {
  agent_id: string;
  daily_usd_spent: number;
  daily_usd_cap: number;
  daily_executions: number;
  sponsor_remaining_usd: number;
  _request_id?: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;          // e.g. "ubr_live_AB12"
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyCreateInput {
  name: string;
  scopes?: string[];
}

export interface ApiKeyCreateResponse {
  key: ApiKey;
  plaintext: string;       // only returned on create
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
