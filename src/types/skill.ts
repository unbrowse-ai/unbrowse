export type SkillLifecycle = "active" | "deprecated" | "disabled";
export type OwnerType = "agent" | "marketplace" | "user";
export type Idempotency = "safe" | "unsafe";
export type VerificationStatus = "verified" | "unverified" | "failed" | "pending" | "disabled";

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

export interface WsMessage {
  direction: "sent" | "received";
  data: string;
  timestamp: string;
}

export interface EndpointDescriptor {
  endpoint_id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "WS";
  url_template: string;
  ws_messages?: WsMessage[];
  headers_template?: Record<string, string>;
  query?: Record<string, unknown>;
  /** Default values for templatized path segments (e.g. {symbol} → "SPY,QQQ") */
  path_params?: Record<string, string>;
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
  /** When set, endpoint returns HTML — apply DOM extraction with this config */
  dom_extraction?: {
    extraction_method: string;
    confidence: number;
  };
  /** The page URL that triggered this API call during capture.
   *  Used for trigger-and-intercept execution: navigate to this page,
   *  let the site's own JS make the API call, and intercept the response. */
  trigger_url?: string;
  /** Learned execution strategy — set after first successful execution.
   *  Skips doomed server-fetch on sites that need browser execution (e.g. LinkedIn). */
  exec_strategy?: "server" | "trigger-intercept" | "browser";
}

export type ExecutionType = "http" | "browser-capture";

/** Cost of the original live capture that discovered this skill */
export interface DiscoveryCost {
  capture_ms: number;
  capture_tokens: number;
  response_bytes: number;
  captured_at: string;
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
  execution_type: ExecutionType;
  auth_profile_ref?: string;
  endpoints: EndpointDescriptor[];
  transform_ref?: string;
  lifecycle: SkillLifecycle;
  changelog?: string;
  created_at: string;
  updated_at: string;
  prev_version?: string;
  discovery_cost?: DiscoveryCost;
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
  har_lineage_id?: string;
  drift?: DriftResult;
  /** Estimated tokens consumed by the response */
  tokens_used?: number;
  /** Tokens saved vs original capture cost (0 for live captures) */
  tokens_saved?: number;
  /** Percentage tokens saved vs original capture cost */
  tokens_saved_pct?: number;
  /** Code version hash + git SHA — tracks which code produced this trace */
  trace_version?: string;
}

export interface DiscoveryCandidate {
  skill_id: string;
  score: number;
  confidence: "high" | "medium" | "low";
  predicted_risk: "safe" | "needs_confirmation";
  skill: SkillManifest;
}

// --- Response Schema & Projection Types ---

export interface ResponseSchema {
  type: string;
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
}

export interface DriftResult {
  drifted: boolean;
  added_fields: string[];
  removed_fields: string[];
  type_changes: Array<{ path: string; was: string; now: string }>;
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
}

export interface ExecutionOptions {
  confirm_unsafe?: boolean;
  dry_run?: boolean;
  /** User's request intent — used for endpoint ranking instead of skill.intent_signature */
  intent?: string;
  /** The page URL the user is asking about — used to boost endpoints captured from that page */
  contextUrl?: string;
}

export interface ValidationResult {
  valid: boolean;
  hardErrors: string[];
  softWarnings: string[];
}

/** Orchestrator-level timing breakdown for a single resolve call */
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
  /** Estimated agent context tokens saved vs manual browsing */
  tokens_saved: number;
  /** Size of the structured response in bytes */
  response_bytes: number;
  /** Percentage time saved vs estimated live capture baseline */
  time_saved_pct: number;
  /** Percentage token saved vs estimated full-page browsing cost */
  tokens_saved_pct: number;
  /** Code version hash + git SHA — tracks which code produced this timing */
  trace_version?: string;
}
