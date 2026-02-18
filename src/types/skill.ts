export type SkillLifecycle = "active" | "deprecated" | "disabled";
export type OwnerType = "agent" | "marketplace" | "user";
export type Idempotency = "safe" | "unsafe";
export type VerificationStatus = "verified" | "unverified" | "failed" | "pending";

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

export interface EndpointDescriptor {
  endpoint_id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url_template: string;
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
}

export type ExecutionType = "http" | "browser-capture";

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
}

export interface DiscoveryCandidate {
  skill_id: string;
  score: number;
  confidence: "high" | "medium" | "low";
  predicted_risk: "safe" | "needs_confirmation";
  skill: SkillManifest;
}
