export type SkillLifecycle = "active" | "deprecated" | "disabled";
export type OwnerType = "agent" | "marketplace" | "user";
export type Idempotency = "safe" | "unsafe";
export type VerificationStatus = "verified" | "unverified" | "failed" | "pending" | "disabled";
export type GraphVisibility = "shadow" | "public";

/**
 * Pointer to another contract's id in the /contract substrate.
 * A ContractRef is the string id of a cell contract whose satisfaction
 * is the precondition for this field's truth claim. See
 * ~/.claude/skills/contract/SKILL.md — "pointer principle". Wave-1
 * carrier of the runtime↔substrate isomorphism (organ b9c8a64d stage 1).
 * Today a bare string alias; future stages may refine to a richer
 * { id, kind, required } record without breaking the wire format.
 */
export type ContractRef = string;

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
  /** Count of submissions that included an independently verified proof */
  zk_verified_count?: number;
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

export interface WsMessage {
  direction: "sent" | "received";
  data: string;
  timestamp: string;
}

export interface OperationBinding {
  key: string;
  description?: string;
  type?: string;
  semantic_type?: string;
  required?: boolean;
  source?: string;
  example_value?: string;
  /**
   * Optional pointer to a producer cell contract whose satisfaction
   * proves this binding's value is available. When present, the DAG
   * walker resolves dependency by querying the substrate ledger rather
   * than inferring from heuristic key-match. Stage 1 (organ b9c8a64d)
   * lands the field as optional; stage 3 wires the walker to consume it.
   */
  contract_ref?: ContractRef;
  // NEW freshness metadata, all optional for backward compat.
  // See .claude/jesus-loop.default.architecture.md and
  // ~/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/memory/project_dag_recompute_north_star.md
  ttl_ms?: number;
  single_use?: boolean;
  observed_at?: string;
}

// Minimal contract for decision-trace steps emitted by the chain walker and
// other executor branches. Day-5 (chain walker implementation) will read and
// write these; richer typing can land later without breaking the shape.
// See .claude/jesus-loop.default.architecture.md for canonical step names
// (chain_walk_refetched_success, chain_walk_depth_exceeded, ...).
export interface DecisionTraceStep {
  step: string;
  [key: string]: unknown;
}

// Walk context threaded through the chain-walk DAG resolver. See
// .claude/jesus-loop.default.architecture.md for the design rationale and the
// invariants Day-5 must preserve (frozen `now`, append-only `trace`,
// single-use markers in `consumed`, cycle detection via `visited`).
export interface ChainWalkContext {
  now: number;                          // epoch ms, frozen at walk start
  consumed: Map<string, boolean>;       // single-use markers by binding key
  depth: number;                        // current walk depth
  visited: Set<string>;                 // endpoint_ids visited (cycle detection)
  maxDepth: number;                     // default 4; injectable for tests
  trace: DecisionTraceStep[];           // append-only
  producerIndex?: Map<string, string>;  // binding.key → producer endpoint_id
}

export interface EndpointSemanticDescriptor {
  action_kind: string;
  resource_kind: string;
  description_in?: string;
  description_out?: string;
  description_source?: "agent" | "auto" | "missing";
  description_needs_review?: boolean;
  description_warning?: string;
  response_summary?: string;
  example_request?: unknown;
  example_response_compact?: unknown;
  example_fields?: string[];
  requires?: OperationBinding[];
  provides?: OperationBinding[];
  negative_tags?: string[];
  confidence?: number;
  observed_at?: string;
  sample_request_url?: string;
  auth_required?: boolean;
}

export interface EndpointPolicyDescriptor {
  requires_third_party_terms_confirmation: boolean;
  policy_domain: string;
  reason: string;
  /** When true, this endpoint requires a live browser session because captured query
   *  parameters are session-bound (e.g. TikTok device_id, WebIdLastTime). Direct API
   *  replay will return empty results. The agent should use `go` + `eval` instead. */
  requires_live_session?: boolean;
  /** Names of the session-bound query parameters detected in this endpoint's query. */
  session_bound_params?: string[];
}

export interface EndpointPathBindingCandidate {
  placeholder: string;
  observed_value: string;
  segment_index: number;
  source: "normalized_placeholder" | "file_basename" | "page_hint" | "context_diff" | "segment_pattern";
  placeholder_hint?: string;
  preceding_segment?: string;
  filename_suffix?: string;
  matched_page_hint?: boolean;
}

export interface AuthTokenSource {
  kind: "cookie" | "html-meta" | "html-inline-script" | "js-bundle" | "observed-request";
  cookie_names?: string[];
  meta_name?: string;
  meta_attr?: "content" | "value";
  inline_script_regex?: string;
  bundle_url_pattern?: string;
  bundle_regex?: string;
}

export interface AuthTokenBinding {
  param_name: string;
  param_location: "header" | "body" | "query";
  sources: AuthTokenSource[];
  refresh_on_401?: boolean;
}

export interface EndpointDescriptor {
  endpoint_id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "WS";
  url_template: string;
  /** LLM-generated description of what this endpoint returns, for semantic matching */
  description?: string;
  ws_messages?: WsMessage[];
  headers_template?: Record<string, string>;
  query?: Record<string, unknown>;
  /** Default values for templatized path segments (e.g. {symbol} → "SPY,QQQ") */
  path_params?: Record<string, string>;
  /** Default values for templatized request-body placeholders */
  body_params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  csrf_plan?: CsrfPlan;
  oauth_plan?: OAuthPlan;
  /** Token bindings discovered during capture — maps auth headers to their page sources */
  auth_tokens?: AuthTokenBinding[];
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
    selector?: string;
  };
  /** The page URL that triggered this API call during capture.
   *  Used for trigger-and-intercept execution: navigate to this page,
   *  let the site's own JS make the API call, and intercept the response. */
  trigger_url?: string;
  /** Server-owned graph visibility. Shadow endpoints are persisted but not indexed. */
  graph_visibility?: GraphVisibility;
  /** Server-owned corroboration counters used for staged promotion. */
  corroboration?: EndpointCorroboration;
  /** Loop 4 (B-023 follow-up): admission-time signal that the captured response
   *  body looked like a login-wall page (HTML + title contains sign in / log in
   *  / signin / login). Set in `extractEndpoints` from the raw response body
   *  shape. Read by `rankEndpoints` to demote auth_walled endpoints below
   *  sibling data XHRs for content-read intents — so x.com/home (LoggedOutShell
   *  HTML, scored ~229 from URL-exact-match against the probe url) stops
   *  outranking HomeTimeline graphql XHRs at the top of the shortlist. */
  auth_walled?: boolean;
  /** Semantic v2 metadata for endpoint-level retrieval and DAG planning */
  semantic?: EndpointSemanticDescriptor;
  /** Path template inferred by batch mining (passive captures without a context page URL).
   *  Internal annotation — not persisted to the skill manifest. */
  _minedTemplate?: string;
  /** Raw path binding evidence captured before semantic naming rewrites placeholders. */
  _path_binding_candidates?: EndpointPathBindingCandidate[];
  /** GraphQL operation metadata — operation name extracted from request body or URL.
   *  Used for deduplication, display, and template matching of GraphQL endpoints. */
  graphql_info?: {
    operation_name: string;
  };
  /** Structured search form spec — when present, indicates this endpoint can be driven
   *  by filling a DOM form rather than a direct API call. Used by isStructuredSearchForm
   *  to gate search-form execution paths. */
  search_form?: import("../execution/search-forms.js").SearchFormSpec;
  /** Optional third-party policy metadata surfaced to callers and enforced at execute time. */
  policy?: EndpointPolicyDescriptor;
  /** GraphQL operation metadata — present when the endpoint is a GraphQL POST */
  graphql_info?: {
    /** The GraphQL operation name (e.g. "UserTweets", "ProfileCometTimelineFeedRefetchQuery") */
    operation_name: string;
  };
  /** Learned constraints from API errors and agent observations */
  constraints?: EndpointConstraint[];
  /** Agent-contributed best practices, tips, and gotchas */
  annotations?: EndpointAnnotation[];
  /** Phase 7.2: Proven recipe — exact request that produced a known-good response.
   *  Replayed first by the executor before any probe/dispatch. */
  proven_recipe?: ProvenRecipe;
  /** Proof metadata or client-side commitment attached to this endpoint */
  zk_proof?: import("./proof.js").ZkProof;
  /**
   * Owner-submitted provenance flag. Set to `true` by the backend
   * `promoteOfficialSubmission` triage helper when a domain owner's canonical
   * x402-supported endpoint is promoted out of the triage queue. Tri-file
   * synced with `backend/src/types.ts` and `frontend/src/lib/api.ts`.
   */
  owner_submitted?: boolean;
  /**
   * pay.sh provider metadata. Present when this endpoint is gated by a pay.sh
   * gateway (MPP or x402 challenge). Lets resolve label the route as paid (with
   * a price, before the agent pays) and lets the client layer route the
   * payment through the `pay` adapter (UNBROWSE_WALLET_ADAPTER=pay). Additive —
   * absent on every non-pay.sh route. See src/payments/pay-sh.ts.
   */
  pay_provider?: PayProviderDescriptor;
}

/**
 * pay.sh provider metadata attached to a pay.sh-gated endpoint. Mirrors the
 * fields pay.sh's catalog / 402 challenge expose; all optional so a route can
 * carry as little as "this is pay.sh-gated".
 */
export interface PayProviderDescriptor {
  /** Provider subdomain / catalog slug (pay.sh stable identifier). */
  subdomain?: string;
  /** Gateway base URL that issues the 402 challenge. */
  gateway_url?: string;
  /** Per-call price in USD, as advertised by the challenge/catalog. */
  price_usd?: number;
  /** Challenge protocol the gateway speaks. */
  protocol?: "mpp" | "x402";
  /** Source of this metadata: observed at execute time vs discovered in catalog. */
  source?: "observed" | "catalog";
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

/**
 * Phase 7.2 — Proven recipe.
 *
 * The exact request that produced a known-good response when the endpoint was
 * captured. Stamped at admission (extractEndpoints) and replayed first by the
 * executor before any probe/dispatch logic. When the replay matches the
 * `response_signal`, we're done in <500ms with no extra HEAD/GET probing.
 */
export interface ProvenRecipeResponseSignal {
  /** Exact status from the proven response (e.g. 200) */
  status: number;
  /** Lowercased content-type, e.g. "application/json" */
  content_type?: string;
  /** 50% of captured byte length (rounded down) — body shrinkage threshold */
  byte_length_min?: number;
  /** 200% of captured byte length (rounded up) — body growth threshold */
  byte_length_max?: number;
  /** Top-level JSON keys for shape comparison (cheap structural fingerprint) */
  json_top_keys?: string[];
}

export interface ProvenRecipe {
  /** "GET" / "POST" / etc. */
  method: string;
  /** Includes {param} slots — entity substitution happens at execute time */
  url_template: string;
  /** Exact headers that produced the proven response, with ephemeral headers stripped */
  headers: Record<string, string>;
  /** Exact body for POST/PUT/PATCH (undefined for GET) */
  body?: unknown;
  response_signal: ProvenRecipeResponseSignal;
  /** ISO-8601 timestamp of capture */
  captured_at: string;
}

export type ExecutionType = "http" | "browser-capture";

/** Cost of the original live capture that discovered this skill */
export interface DiscoveryCost {
  capture_ms: number;
  capture_tokens: number;
  response_bytes: number;
  captured_at: string;
}

export interface SkillOperationNode {
  operation_id: string;
  endpoint_id: string;
  method: EndpointDescriptor["method"];
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

export interface SkillChunk {
  skill_id: string;
  intent?: string;
  available_operation_ids: string[];
  missing_bindings: string[];
  operations: SkillOperationNode[];
  edges: SkillOperationEdge[];
}

export interface AgentAvailableOperation {
  operation_id: string;
  method: EndpointDescriptor["method"];
  action_kind: string;
  resource_kind: string;
  title: string;
  why_available: string;
  url_template: string;
  requires: string[];
  yields: string[];
  example_request?: unknown;
  example_response_compact?: unknown;
  /** Whether this endpoint has proof metadata and its verification status */
  proof_status?: "proven" | "client_commitment" | "unverified_proof" | "no_proof";
}

export interface AgentPrefetchOperation {
  operation_id: string;
  endpoint_id: string;
  method: EndpointDescriptor["method"];
  action_kind: string;
  resource_kind: string;
  reason: string;
  binding_key: string;
  edge_kind: SkillOperationEdge["kind"];
  confidence: number;
}

export interface AgentWorkflowDagOperation {
  operation_id: string;
  endpoint_id: string;
  method: EndpointDescriptor["method"];
  action_kind: string;
  resource_kind: string;
  title: string;
  url_template: string;
  description_out?: string;
  requires: string[];
  yields: string[];
  runnable: boolean;
  prefetch_get_operations: AgentPrefetchOperation[];
  /** Whether this endpoint has proof metadata and its verification status */
  proof_status?: "proven" | "client_commitment" | "unverified_proof" | "no_proof";
}

export interface AgentWorkflowDagView {
  skill_id: string;
  intent?: string;
  missing_bindings: string[];
  suggested_next_operation_id?: string;
  operations: AgentWorkflowDagOperation[];
  edges: Array<{
    edge_id: string;
    from_operation_id: string;
    to_operation_id: string;
    binding_key: string;
    kind: SkillOperationEdge["kind"];
    confidence: number;
  }>;
}

export interface AgentSkillChunkView {
  skill_id: string;
  intent?: string;
  missing_bindings: string[];
  suggested_next_operation_id?: string;
  available_operations: AgentAvailableOperation[];
}

/** One step of a composite: a prerequisite endpoint that ran and the binding keys it yielded. */
export interface SkillCompositeStep {
  endpoint_id: string;
  ok: boolean;
  yielded: string[];
}

/** A binding edge of a composite: a prerequisite yielded `binding`, threaded into the target. */
export interface SkillCompositeEdge {
  from: string;
  binding: string;
  to: string;
}

/**
 * A discovered composite contract — the persisted, replayable form of a walked prerequisite DAG.
 * Carries no secrets (endpoint ids + binding key NAMES only), so it publishes alongside routes.
 * `composite_id` is the structural identity; replay is looked up by (domain, target).
 */
export interface SkillComposite {
  composite_id: string;
  intent_signature?: string;
  domain: string;
  target: string;
  steps: SkillCompositeStep[];
  edges: SkillCompositeEdge[];
  created_at?: string;
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
  /** Intent strings that contributed endpoints to this domain-level skill */
  intents?: string[];
  /** Agent ID of the indexer who published this skill - used for Tier 1 attribution */
  indexer_id?: string;
  /** All agents who contributed endpoints to this skill */
  contributors?: Array<{
    agent_id: string;
    wallet_address?: string;
    endpoints_contributed: number;
    cumulative_delta: number;
    share: number;
    first_contributed_at: string;
    last_contributed_at: string;
  }>;
  /** Cascade Split address — x402 payments route here for multi-contributor skills */
  split_config?: string;
  /** Graph v2: endpoint dependencies, semantic summaries, and dynamic availability */
  operation_graph?: SkillOperationGraph;
  /**
   * Discovered composites — multi-step contract sub-DAGs a prior resolve walked to satisfy a
   * target endpoint (ordered constituent endpoints + binding edges). Travel with the skill so a
   * FOREIGN agent that never walked the chain can replay the recorded order (always-on, ungated —
   * the local-disk composite cache is the gated mirror). Structural identity is `composite_id`.
   */
  composites?: SkillComposite[];
  /** Price in USD per execution; undefined or 0 = free */
  base_price_usd?: number;
  /** Whether the skill owner has opted into compensation */
  owner_compensation_opt_in?: boolean;
  /**
   * Solana pubkey of the verified domain owner. SERVER-OWNED — populated
   * by the DNS-claim verify endpoint, never user-supplied. See
   * backend/src/types.ts for the full server-side docstring.
   */
  owner_wallet_address?: string;
  /** USDC ATA derived from owner_wallet_address. SERVER-OWNED. */
  owner_wallet_usdc_ata?: string;
  /** ISO timestamp the DNS-TXT verify succeeded. SERVER-OWNED. */
  owner_wallet_verified_at?: string;
  /**
   * Per-skill platform markup in basis points (1 bp = 0.01%).
   * Optional override for the global PLATFORM_BPS constant in
   * backend/src/services/flex.ts. Clamped to [500, 8000] at compute
   * time (5%-80% per the Pontus / ABK Labs 2026-05-21 brief).
   * When unset, falls back to PLATFORM_BPS=5000 (50%).
   */
  markup_bps?: number;
  /** Server-owned submission provenance for staged promotion and abuse analysis. */
  provenance_events?: SkillSubmissionProvenance[];
  /** Server-owned graph trust state. */
  trust?: SkillTrustMetadata;
  /**
   * ISO timestamp when the calling agent ACTUALLY reviewed this skill via
   * `unbrowse_review` — provenance, never forged. With `auto_review=false`
   * it gates public marketplace publish (unreviewed skills are held back);
   * with `auto_review=true` skills publish without it, and the manifest
   * honestly shows no review happened. See `shouldPublishAfterIndex` in
   * src/lib/indexer-core/index.ts.
   */
  reviewed_at?: string;
  /**
   * Owner-controlled marketplace visibility. `public` (default) is surfaced
   * in resolve/search and the public card list; `private` is excluded from
   * every cross-agent surface while still owned by the publisher. Mirrors
   * `SkillManifest.visibility` in backend/src/types.ts and
   * frontend/src/lib/api.ts (tri-file sync; see CLAUDE.md).
   */
  visibility?: "public" | "private";
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
  har_lineage_id?: string;
  drift?: DriftResult;
  /** AC3 lane-04: re_capture signal surfaced when drift is detected so
   *  the calling agent can dispatch unbrowse_go in headful-as-learning
   *  mode against the contextUrl. Substrate emits truth; agent judges. */
  re_capture_signal?: import("../execution/drift-recapture-signal.js").DriftRecaptureSignal;
  /** Set when response_schema was backfilled from this execution's response */
  schema_backfilled?: boolean;
  /** Estimated tokens consumed by the response */
  tokens_used?: number;
  /** Tokens saved vs original capture cost (0 for live captures) */
  tokens_saved?: number;
  /** Percentage tokens saved vs original capture cost */
  tokens_saved_pct?: number;
  /** Code version hash + git SHA — tracks which code produced this trace */
  trace_version?: string;
  /** Ordered decision-step ledger from the executor / orchestrator (see
   *  CLAUDE.md "Decision-trace step naming convention"). Each entry has a
   *  `step` string plus arbitrary signal fields the agent reads in-thread.
   *  Already populated by executeBrowserCapture (no_progress_bail_*,
   *  recipe_replay, 5xx_ssr_fastpath_*) and the orchestrator vendor-block
   *  + empty-capture curl_cffi rescues. */
  decision_trace?: Array<{ step: string } & Record<string, unknown>>;
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
  description?: string;
  enum_values?: Array<string | number | boolean>;
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
  /** When true, skip server-side projection and return raw response data */
  raw?: boolean;
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

export interface ResolveResultDiagnostic {
  confidence: number;
  top_reasoning: string;
  known_issues: string[];
  endpoint_count: number;
  cache_source: string;
  suggested_next_actions?: string[];
}

export interface ExecutionOptions {
  confirm_unsafe?: boolean;
  /** Caller-supplied request headers (e.g. an explicit `--header "Authorization: Bearer …"`).
   *  Merged into the request's auth headers AFTER stored vault creds, so an agent can
   *  authenticate a write/read it already holds a token for, without a prior auth-capture. */
  authHeaders?: Record<string, string>;
  /** Explicit user confirmation for domains/actions that may violate third-party site terms. */
  confirm_third_party_terms?: boolean;
  dry_run?: boolean;
  /** User's request intent — used for endpoint ranking instead of skill.intent_signature */
  intent?: string;
  /** The page URL the user is asking about — used to boost endpoints captured from that page */
  contextUrl?: string;
  /** Skip marketplace search and caches — go straight to browser capture */
  force_capture?: boolean;
  /** Skip the remote marketplace search entirely, resolve against local
   *  caches + browser capture only. Set by callers that already hold
   *  the relevant local skill in hand (e.g. 404-recovery in the
   *  /v1/skills/:id/execute route — we already KNOW the local skill
   *  exists with possible sibling endpoints; waiting 2500ms for a
   *  remote round-trip we'd ignore anyway is pure latency tax). */
  local_skills_only?: boolean;
  /** Request/client namespace for isolating local server state across concurrent CLI users */
  client_scope?: string;
  /** Set only when the caller has already completed payment verification for a paid run */
  payment_verified?: boolean;
  /** Phase 8.1 — wall-clock budget in ms for the parallel resolve race. Default 8000. */
  budget_ms?: number;
  /** Test seam: override the Exa probe-fallback search. Production leaves this
   *  undefined and uses the real searchIntentResolve. Tests inject deterministic
   *  exa_results to exercise the probe-fallback routing without a live network. */
  exaSearchOverride?: (
    intent: string,
    domain: string | undefined,
    domainK: number,
    globalK: number,
  ) => Promise<{ exa_results?: Array<{ url: string; title?: string; score: number; highlights?: string[] }> }>;
  /** When true, the resolve shortlist is filtered to only independently verified proofs. */
  require_proof?: boolean;
  /** Per-walk session yield cache. Map from binding `key` → cached value + freshness
   *  metadata produced by an earlier call in the same chain walk. Threaded by
   *  `executeEndpointWithChain`. Optional — when absent, the wrapper has no prior
   *  cached values to evaluate and effectively delegates to `executeEndpoint`. */
  session_yields?: SessionYieldCache;
  /** Phase: opt-in paid residential-proxy fallback on HTTP 429. When set on a
   *  per-request basis OR when `consent:proxy_fallback:<agent>` is "yes" in
   *  the backend KV, executeEndpoint retries the outbound fetch through the
   *  IProyal residential proxy on 429 and POSTs a per-call surcharge
   *  (~$0.01) to the backend sponsor ledger. Plan slug:
   *  add-an-opt-in-paid-residential-proxy-fallback-fo. */
  paid_proxy_fallback?: boolean;
  /** Test seam: force the proxy dispatch on the next outbound fetch even when
   *  the target did not 429. Used ONLY by tests/proxy-fallback-429.test.ts to
   *  assert egress IP changes through the dispatcher. Never set in product
   *  flow. */
  __forceProxy?: boolean;
}

/** Single cached binding value carrying the freshness metadata `isBindingStale` needs. */
export interface SessionYield {
  value: unknown;
  observed_at: string;
  ttl_ms?: number;
  single_use?: boolean;
  /** In-memory marker: this yield came from a sensitive-named field. On disk
   *  persistence it is committed (hashed), never written in clear. */
  sensitive?: boolean;
  /** Persisted/loaded marker: `value` is a sha256 commitment, not the real value
   *  (the producer was sensitive). A committed yield cannot fill a hole — the caller
   *  must re-supply the real secret. Keeps secrets off disk in clear across processes. */
  committed?: boolean;
}

/** Walk-scoped cache: binding `key` → most-recently observed yield. */
export type SessionYieldCache = Map<string, SessionYield>;

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
  source: "marketplace" | "live-capture" | "dom-fallback" | "route-cache" | "browser-action" | "exa" | "direct-fetch" | "direct-document";
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
  /** Real capture baseline in ms when known */
  baseline_total_ms?: number;
  /** Actual runtime latency in ms for this resolve */
  actual_total_ms?: number;
  /** Real time saved in ms when baseline is known */
  time_saved_ms?: number;
  /** Real baseline cost in micro-cents when known */
  baseline_cost_uc?: number;
  /** Real amount charged for this run in micro-cents */
  actual_cost_uc?: number;
  /** Real cost saved in micro-cents when baseline is known */
  cost_saved_uc?: number;
  /** Tier 3 search fee charged during this resolve */
  paid_search_uc?: number;
  /** Paid execution fee charged during this resolve */
  paid_execution_uc?: number;
  /** Code version hash + git SHA — tracks which code produced this timing */
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

export type WorkflowStepStrategy = "server" | "trigger-intercept" | "browser-action" | "browser-fetch";

export interface WorkflowActionStep {
  action: string;
  selector?: string;
  value?: string;
  ref?: string;
  step_index?: number;
}

export interface WorkflowTokenCandidate {
  source_kind: "cookie" | "request_header" | "response_header" | "request_body" | "hidden_input" | "meta" | "bootstrap_json";
  source_name: string;
  source_path?: string;
  observed_value?: string;
  confidence: number;
}

export interface TokenBinding {
  binding_id: string;
  target_location: "header" | "body";
  target_name: string;
  refresh_on_statuses: number[];
  candidates: WorkflowTokenCandidate[];
  selected_source_kind?: WorkflowTokenCandidate["source_kind"];
  selected_source_name?: string;
}

export interface MutationGuard {
  confirm_unsafe_required: boolean;
  provenance_backed: boolean;
  auth_required: boolean;
  parameter_mapping_confident: boolean;
  block_reason?: string;
}

export interface WorkflowStep {
  step_id: string;
  strategy: WorkflowStepStrategy;
  provenance: "observed-request" | "bundle-inferred" | "dom-form" | "trigger-url" | "learned-runtime";
  trigger_url?: string;
  action_sequence?: WorkflowActionStep[];
  success_count?: number;
  failure_count?: number;
  last_status?: number;
  last_error?: string;
  last_used_at?: string;
}

export interface WorkflowRecipe {
  recipe_id: string;
  endpoint_id: string;
  operation_id?: string;
  preferred: boolean;
  provenance_backed: boolean;
  steps: WorkflowStep[];
  token_bindings: TokenBinding[];
  mutation_guard: MutationGuard;
  replay_contract: WorkflowReplayContract;
  last_successful_strategy?: WorkflowStepStrategy;
  last_used_at?: string;
}

export interface WorkflowDomFieldHint {
  form_selector?: string;
  field_name: string;
  value?: string;
  field_type?: string;
  selector?: string;
  required?: boolean;
  pattern?: string;
  min?: string;
  max?: string;
}

export interface WorkflowMetaHint {
  key: string;
  value: string;
}

export interface WorkflowBootstrapHint {
  path: string;
  value: string;
}

export interface WorkflowDomOptionHint {
  form_selector?: string;
  field_name: string;
  values: string[];
  labels?: string[];
  field_type?: string;
}

export interface WorkflowParameterSourceHint {
  source_kind:
    | WorkflowTokenCandidate["source_kind"]
    | "path_template"
    | "query_default"
    | "body_default"
    | "observed_query"
    | "observed_body"
    | "semantic_requires";
  source_name: string;
  source_path?: string;
  confidence?: number;
}

export interface WorkflowParameterConstraint {
  kind: "enum" | "format" | "pattern" | "min" | "max";
  value?: string | number | boolean;
  description?: string;
}

export interface WorkflowParameterSpec {
  name: string;
  location: "path" | "query" | "body" | "header";
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  required: boolean;
  user_supplied: boolean;
  default_value?: unknown;
  example_value?: unknown;
  format?: string;
  enum_values?: Array<string | number | boolean>;
  derived_from?: string[];
  constraints?: WorkflowParameterConstraint[];
  source_hints: WorkflowParameterSourceHint[];
}

export interface EndpointParameterReview {
  name: string;
  location: "path" | "query" | "body" | "header";
  description?: string;
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
  required?: boolean;
  user_supplied?: boolean;
  format?: string;
  enum_values?: Array<string | number | boolean>;
  derived_from?: string[];
}

export interface EndpointResponseFieldReview {
  path: string;
  description?: string;
  type?: string;
  enum_values?: Array<string | number | boolean>;
}

export interface EndpointReviewPayload {
  endpoint_id: string;
  description?: string;
  action_kind?: string;
  resource_kind?: string;
  example_request?: unknown;
  example_response?: unknown;
  parameter_reviews?: EndpointParameterReview[];
  response_reviews?: EndpointResponseFieldReview[];
}

export interface WorkflowPrerequisiteSpec {
  prerequisite_id: string;
  kind: "authenticated-session" | "token-binding" | "hidden-field" | "page-context" | "browser-action" | "submit-blocker";
  name: string;
  description?: string;
  required: boolean;
  selector?: string;
  source_kind?: string;
  source_name?: string;
  derived_from?: string;
}

export interface WorkflowNextStateSpec {
  kind: "page_url" | "response_schema" | "dom_selector";
  value: string;
  description?: string;
}

export interface WorkflowPaymentRequirementSpec {
  status: "free" | "x402_optional" | "x402_required";
  price_usd?: string;
  currency?: string;
  wallet_required: boolean;
  provider_hint?: string;
  confirmation_field?: "payment_verified";
  reason?: string;
}

export interface WorkflowReplayContract {
  explicit_replay_only: boolean;
  exposure_stage: "publish";
  dependency_bindings: string[];
  search_terms: string[];
  parameter_specs: WorkflowParameterSpec[];
  prerequisite_specs: WorkflowPrerequisiteSpec[];
  next_state: WorkflowNextStateSpec[];
  payment_requirement: WorkflowPaymentRequirementSpec;
}

export interface WorkflowEvidence {
  observed_request_count: number;
  observed_request_urls: string[];
  har_lineage_ids: Array<string | undefined>;
  trigger_urls: string[];
  js_bundle_urls: string[];
  dom_form_hints: WorkflowDomFieldHint[];
  dom_option_hints: WorkflowDomOptionHint[];
  meta_hints: WorkflowMetaHint[];
  bootstrap_hints: WorkflowBootstrapHint[];
}

export interface WorkflowArtifact {
  artifact_version: string;
  skill_id: string;
  domain: string;
  intent_signature: string;
  captured_at: string;
  final_url: string;
  auth_state: {
    auth_profile_ref?: string;
    cookie_names: string[];
    header_names: string[];
    authenticated: boolean;
  };
  evidence: WorkflowEvidence;
  recipes: WorkflowRecipe[];
}

export type WorkflowPublishStatus = "captured" | "indexed" | "blocked-validation" | "published";

export interface WorkflowPublishBindingSource {
  source_kind: WorkflowTokenCandidate["source_kind"];
  source_name: string;
  source_path?: string;
  confidence: number;
}

export interface WorkflowPublishBinding {
  target_location: TokenBinding["target_location"];
  target_name: string;
  refresh_on_statuses: number[];
  selected_source_kind?: TokenBinding["selected_source_kind"];
  selected_source_name?: string;
  candidates: WorkflowPublishBindingSource[];
}

export interface WorkflowPublishRecipe {
  endpoint_id: string;
  operation_id?: string;
  preferred: boolean;
  provenance_backed: boolean;
  last_successful_strategy?: WorkflowStepStrategy;
  steps: Array<{
    strategy: WorkflowStepStrategy;
    provenance: WorkflowStep["provenance"];
    trigger_url?: string;
    action_count: number;
  }>;
  mutation_guard: MutationGuard;
  token_bindings: WorkflowPublishBinding[];
  replay_contract: WorkflowReplayContract;
  usage_notes: string[];
}

export interface WorkflowPublishArtifact {
  export_version: string;
  generated_at: string;
  publish_status: WorkflowPublishStatus;
  published_at?: string;
  validation_errors?: string[];
  skill_id: string;
  domain: string;
  intent_signature: string;
  sanitized_endpoints: EndpointDescriptor[];
  workflow_summary: {
    recipe_count: number;
    preferred_endpoint_ids: string[];
    authenticated_capture: boolean;
    token_binding_count: number;
    trigger_url_count: number;
    included_endpoint_count: number;
    root_endpoint_ids: string[];
    closure_added_count: number;
  };
  auth_summary: WorkflowArtifact["auth_state"];
  recipes: WorkflowPublishRecipe[];
  docs: {
    headline: string;
    bullets: string[];
  };
}
