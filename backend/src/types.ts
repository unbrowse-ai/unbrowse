export interface Env {
  API_KEY: string;
  LANDING_PUBLISH_KEY?: string;
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
  STATS_KV: KVNamespace;
  ENVIRONMENT?: string; // "production" | "staging"
  PAYMENTS_ENABLED?: string;
  CREDITS_ENABLED?: string;
  X402_SEARCH_ENABLED?: string;
  X402_NETWORK_MODE?: string;
  /** Wallet address that receives x402 skill-access payments. */
  PAYMENT_RECIPIENT?: string;
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
  /** Exa web search — parallel step in resolve, surfaces highlights when marketplace misses. */
  EXA_API_KEY?: string;
  /**
   * Comma-separated list of additional reserved domains. Non-admin publishers
   * cannot publish skills for these domains (or their subdomains). Combined
   * with the seed list in `services/domain-reservations.ts`.
   */
  RESERVED_DOMAINS?: string;
  /**
   * Comma-separated list of domains where the well-known HTTP probe is
   * waived (test fixtures, internal hosts). Most operators leave this empty.
   */
  DOMAIN_VERIFY_SKIP?: string;
  /** Set to "1"/"true" to require .well-known probe before any non-admin publish. */
  REQUIRE_DOMAIN_VERIFICATION?: string;
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
  /** Learned constraints from API errors and agent observations */
  constraints?: EndpointConstraint[];
  /** Agent-contributed best practices, tips, and gotchas */
  annotations?: EndpointAnnotation[];
  /** Optional proof metadata or client-side commitment */
  zk_proof?: ZkProof;
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
   * Agent ID of the original publisher. Server-owned. Surfaced on
   * `unbrowse.ai/<domain>` so consumers can see who claimed the domain.
   * Set by the publish handler on first non-admin publish; subsequent
   * publishes from the same agent preserve it.
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
}

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
  /** Share out of 100 for Cascade Split (computed from relative contribution) */
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
