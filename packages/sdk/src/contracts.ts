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

export interface ResponseSchema {
  type: string;
  description?: string;
  properties?: Record<string, ResponseSchema>;
  items?: ResponseSchema;
  required?: string[];
  anyOf?: ResponseSchema[];
  inferred_from_samples: number;
}

export interface ProjectionOptions {
  fields?: string[];
  compact?: boolean;
  max_depth?: number;
  raw?: boolean;
}

export interface EndpointDescriptor {
  endpoint_id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "WS";
  url_template: string;
  description?: string;
  query?: Record<string, unknown>;
  path_params?: Record<string, string>;
  body_params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  idempotency: Idempotency;
  verification_status: VerificationStatus;
  reliability_score: number;
  last_verified_at?: string;
  response_schema?: ResponseSchema;
  trigger_url?: string;
  exec_strategy?: "server" | "trigger-intercept" | "browser";
  graph_visibility?: GraphVisibility;
  corroboration?: EndpointCorroboration;
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
  lifecycle: SkillLifecycle;
  created_at: string;
  updated_at: string;
  intents?: string[];
  base_price_usd?: number;
  owner_compensation_opt_in?: boolean;
  provenance_events?: SkillSubmissionProvenance[];
  trust?: SkillTrustMetadata;
}

export interface ExecutionTrace {
  trace_id: string;
  skill_id: string;
  endpoint_id: string;
  started_at: string;
  completed_at: string;
  success: boolean;
  status_code?: number;
  error?: string;
  result?: unknown;
  tokens_used?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
  trace_version?: string;
}

export interface OrchestrationTiming {
  search_ms: number;
  get_skill_ms: number;
  execute_ms: number;
  total_ms: number;
  source: "marketplace" | "live-capture" | "dom-fallback" | "route-cache" | "browser-action";
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
  trace_version?: string;
}

export interface AgentImpact {
  source: string;
  cache_hit: boolean;
  browser_avoided: boolean;
  baseline_total_ms?: number;
  actual_total_ms?: number;
  time_saved_ms?: number;
  time_saved_pct: number;
  tokens_saved: number;
  tokens_saved_pct: number;
  baseline_cost_uc?: number;
  actual_cost_uc?: number;
  cost_saved_uc?: number;
}

export interface AgentNextAction {
  endpoint_id: string;
  operation_id: string;
  title: string;
  why: string;
  command: string;
}

export interface RequestOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ResolveInput {
  intent: string;
  url?: string;
  params?: Record<string, unknown>;
  context?: {
    url?: string;
    domain?: string;
  };
  projection?: ProjectionOptions;
  confirmUnsafe?: boolean;
  confirmThirdPartyTerms?: boolean;
  dryRun?: boolean;
  forceCapture?: boolean;
}

export interface ExecuteInput {
  skillId: string;
  params?: Record<string, unknown>;
  projection?: ProjectionOptions;
  confirmUnsafe?: boolean;
  confirmThirdPartyTerms?: boolean;
  dryRun?: boolean;
  intent?: string;
  contextUrl?: string;
}

export interface LoginInput {
  url: string;
}

export interface StealAuthInput {
  url: string;
  browser?: "auto" | "firefox" | "chrome" | "chromium";
  chromeProfile?: string;
  firefoxProfile?: string;
  chromiumProfile?: string;
  chromiumUserDataDir?: string;
  chromiumCookieDbPath?: string;
  safeStorageService?: string;
  browserName?: string;
}

export interface SearchInput {
  intent: string;
  k?: number;
}

export interface SearchDomainInput extends SearchInput {
  domain: string;
}

export interface FeedbackInput {
  skillId: string;
  endpointId: string;
  rating: number;
  outcome?: string;
  diagnostics?: {
    total_ms?: number;
    bottleneck?: string;
    wrong_endpoint?: boolean;
    expected_data?: string;
    got_data?: string;
    trace_version?: string;
  };
}

export interface AvailableEndpoint {
  endpoint_id: string;
  score?: number;
  method?: string;
  url_template?: string;
  description?: string;
  schema_summary?: Record<string, unknown> | null;
  example_fields?: string[];
  input_params?: Array<{
    key: string;
    type?: string;
    required?: boolean;
    example_value?: string;
  }>;
  requires_third_party_terms_confirmation?: boolean;
  third_party_terms_policy_domain?: string;
  third_party_terms_policy_reason?: string;
  [key: string]: unknown;
}

export interface ResolveResponse {
  result: unknown;
  trace: ExecutionTrace;
  source: "marketplace" | "live-capture" | "dom-fallback" | "first-pass";
  skill?: SkillManifest;
  timing?: OrchestrationTiming;
  available_endpoints?: AvailableEndpoint[];
  impact?: AgentImpact;
  next_actions?: AgentNextAction[];
  _recovery?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExecuteResponse {
  result: unknown;
  trace: ExecutionTrace;
  skill?: SkillManifest;
  timing?: OrchestrationTiming;
  source?: string;
  impact?: AgentImpact;
  next_actions?: AgentNextAction[];
  _recovery?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SearchHit {
  skill_id?: string;
  score?: number;
  confidence?: string;
  skill?: SkillManifest;
  [key: string]: unknown;
}

export interface SearchResponse {
  results?: SearchHit[];
  [key: string]: unknown;
}

/**
 * Flat endpoint-shaped search hit. Returned by Unbrowse.searchEndpoints().
 *
 * Each row is ONE endpoint from the global marketplace graph, ranked by
 * semantic match against the intent string. Use this when you want to
 * pick endpoints across many skills (vs SearchHit which groups by skill).
 *
 * No JSON-parsing required by the caller -- the backend unwraps the
 * canonical content schema server-side.
 */
export interface EndpointSearchHit {
  endpoint_id: string;
  skill_id: string;
  domain: string;
  subdomain?: string;
  description: string;
  score: number;
  tags: string[];
  name?: string;
  avg_reliability?: number;
  verified_ratio?: number;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SearchEndpointsInput {
  intent: string;
  k?: number;
  domain?: string;
}

export interface SearchEndpointsResponse {
  endpoints: EndpointSearchHit[];
  [key: string]: unknown;
}


export interface LoginResponse {
  success?: boolean;
  cookies_stored?: number;
  [key: string]: unknown;
}

export interface StealAuthResponse {
  success?: boolean;
  cookies_stored?: number;
  [key: string]: unknown;
}

export interface FeedbackResponse {
  ok: boolean;
  avg_rating?: number;
  [key: string]: unknown;
}

export interface StatsResponse {
  npm?: Record<string, unknown>;
  github?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  fetched_at?: string;
  [key: string]: unknown;
}

export interface HealthResponse {
  status: string;
  trace_version?: string;
  code_hash?: string;
  git_sha?: string;
  [key: string]: unknown;
}

// Earnings & dashboard surface.
// Backend handlers: backend/src/routes/{dashboard,transactions,attribution}.ts
export interface DashboardEarnings {
  total_usd?: number;
  unsettled_usd?: number;
  by_skill?: Array<{ skill_id: string; executions: number; usd: number }>;
  [key: string]: unknown;
}

export interface DashboardSpending {
  total_usd?: number;
  by_skill?: Array<{ skill_id: string; executions: number; usd: number }>;
  [key: string]: unknown;
}

export interface DashboardContributions {
  routes_published?: number;
  routes_active?: number;
  unique_domains?: number;
  [key: string]: unknown;
}

export interface Dashboard {
  agent_id?: string;
  wallet_address?: string;
  earnings?: DashboardEarnings;
  spending?: DashboardSpending;
  contributions?: DashboardContributions;
  [key: string]: unknown;
}

export interface CreatorTransaction {
  tx_id: string;
  skill_id?: string;
  endpoint_id?: string;
  amount_usd?: number;
  amount_uc?: number;
  settled_at?: string;
  [key: string]: unknown;
}

export interface CreatorTransactionsResponse {
  ledger?: {
    total_usd?: number;
    unsettled_usd?: number;
    [key: string]: unknown;
  };
  transactions?: CreatorTransaction[];
  [key: string]: unknown;
}

export interface AttributionLedger {
  indexer_id?: string;
  total_usd?: number;
  by_skill?: Array<{ skill_id: string; usd: number; executions: number }>;
  [key: string]: unknown;
}

export interface WalletInfo {
  wallet_address?: string;
  wallet_provider?: string;
  [key: string]: unknown;
}


export interface UnbrowseClientOptions {
  baseUrl?: string;
  apiKey?: string;
  headers?: HeadersInit;
  fetch?: typeof fetch;
  timeoutMs?: number;
  clientId?: string;
}



// ---------------------------------------------------------------------------
// SDK gap-fill (Wave 2 of rebuild-the-unbrowse-sdk-as-a-thin-http-first-ty).
// Types for publish / annotate / paymentProvider methods added to Unbrowse.
// Mirror the on-the-wire shape of the backend routes the SDK now wraps.
// ---------------------------------------------------------------------------

export interface PublishSkillInput {
  skill_id?: string;
  name: string;
  intent_signature: string;
  domain: string;
  description: string;
  endpoints: unknown[];
  /** Optional per-skill platform markup in bps. [500, 8000] clamped. */
  markup_bps?: number;
  [extra: string]: unknown;
}

export interface PublishResponse {
  skill_id: string;
  version: string;
  publish_status: "published" | "failed" | "rejected" | string;
  [extra: string]: unknown;
}

export interface AnnotateInput {
  skillId: string;
  endpointId: string;
  text: string;
  /** Optional structured constraint: `param:rule:message`. */
  constraint?: string;
}

export interface AnnotateResponse {
  ok: boolean;
  annotation_id?: string;
  [extra: string]: unknown;
}

export type PaymentProvider =
  | "pay_sh"
  | "lobster_cash"
  | "external_solana"
  | "privy_embedded"
  | "privy_embedded_solana"
  | "skip";

export interface PaymentProviderResponse {
  agent_id: string;
  wallet_provider: string | null;
  wallet_address: string | null;
}
