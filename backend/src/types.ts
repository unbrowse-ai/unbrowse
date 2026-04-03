export interface Env {
  API_KEY: string;
  UNKEY_ROOT_KEY: string;
  UNKEY_API_ID: string;
  DATABASE_URL?: string;
  EMERGENTDB_API_KEY: string;
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
  STATS_KV: KVNamespace;
  ENVIRONMENT?: string; // "production" | "staging"
  PAYMENTS_ENABLED?: string;
  X402_NETWORK_MODE?: string;
  /** Wallet address that receives x402 skill-access payments. */
  PAYMENT_RECIPIENT?: string;
  CASCADE_PLATFORM_WALLET?: string;
  CASCADE_SIGNER_SECRET_KEY?: string;
  CASCADE_RPC_URL?: string;
  CASCADE_RPC_WS_URL?: string;
}

// --- Agent identity ---

export interface AgentProfile {
  agent_id: string;       // Unkey keyId
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
}

// --- Shared types (mirrored from src/types/skill.ts) ---

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

export interface ResponseSchema {
  type: string;
  properties?: Record<string, ResponseSchema>;
  items?: ResponseSchema;
  required?: string[];
  anyOf?: ResponseSchema[];
  inferred_from_samples: number;
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
  trigger_url?: string;
}

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
  /** All agents who contributed endpoints to this skill, with their shares */
  contributors?: SkillContributor[];
  /** Cascade Split address for this skill — x402 payments route here */
  split_config?: string;
  /**
   * Site-owner opt-in for revenue sharing.
   * When true, the domain operator will receive a compensation share for
   * traffic routed through their endpoints (Tier 2 site-owner compensation).
   */
  owner_compensation_opt_in?: boolean;
  /**
   * Optional base price override in USD per execution.
   * If unset, the platform default base price applies.
   */
  base_price_usd?: number;
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
  /** Share out of 100 for Cascade Split (computed from relative contribution) */
  share: number;
  /** When this agent first contributed */
  first_contributed_at: string;
  /** When this agent last contributed */
  last_contributed_at: string;
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
  drift?: { drifted: boolean; added_fields: string[]; removed_fields: string[]; type_changes: Array<{ path: string; was: string; now: string }> };
  tokens_used?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
  trace_version?: string;
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
  };
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

export interface AcquisitionSummary {
  generated_at: string;
  window_days: number;
  events: number;
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
