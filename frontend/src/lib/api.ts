import { getConfiguredApiOrigin } from "@/lib/api-base";

const API_URL = getConfiguredApiOrigin();
const SUPPRESSED_MARKETPLACE_DOMAINS = new Set(["pearlpediatric.curvehero.com"]);

function normalizeDomain(value?: string | null): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.trim().toLowerCase().split("/")[0]?.replace(/:\d+$/, "").replace(/^www\./, "") ?? "";
  }
}

function isSuppressedDomain(domain?: string | null): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  for (const rule of SUPPRESSED_MARKETPLACE_DOMAINS) {
    if (normalized === rule || normalized.endsWith(`.${rule}`)) return true;
  }
  return false;
}

function searchResultDomain(result: SearchResult): string | null {
  if (typeof result.metadata.source_url === "string") return result.metadata.source_url;
  const content = result.metadata.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as { domain?: unknown };
    return typeof parsed.domain === "string" ? parsed.domain : null;
  } catch {
    return null;
  }
}

export interface ProofCommitment {
  response_body_hash: string;
  domain: string;
  url_template: string;
  method: string;
  response_status: number;
  captured_at: string;
}

export interface ZkProof {
  proof_type: "tlsnotary" | "reclaim" | "commitment_only";
  verified: boolean;
  verified_at?: string;
  verification_failure?: string;
  commitment: ProofCommitment;
  notary_id: string;
  generated_at: string;
}

export interface ProofSummary {
  total_endpoints: number;
  endpoints_with_proof: number;
  verified_proofs: number;
  proof_types: Record<string, number>;
}

export interface SkillManifest {
  skill_id: string;
  version: string;
  name: string;
  intent_signature: string;
  domain: string;
  subdomain?: string;
  description: string;
  owner_type: "agent" | "marketplace" | "user";
  execution_type: "http" | "browser-capture";
  endpoints: EndpointDescriptor[];
  lifecycle: "active" | "deprecated" | "disabled";
  created_at: string;
  updated_at: string;
  proof_summary?: ProofSummary;
}

export interface PopularSkillSummary {
  skill_id: string;
  name: string;
  domain: string;
  description: string;
  version: string;
  execution_type: "http" | "browser-capture";
  endpoint_count: number;
  total_executions: number;
  successful_executions: number;
  avg_reliability_score: number;
  updated_at: string;
  last_execution_at?: string;
}

export interface EndpointDescriptor {
  endpoint_id: string;
  method: string;
  url_template: string;
  idempotency: "safe" | "unsafe";
  verification_status: "verified" | "unverified" | "failed" | "pending";
  reliability_score: number;
  response_schema?: unknown;
  zk_proof?: ZkProof;
}

export interface SkillListEndpointPreview {
  endpoint_id: string;
  method: string;
  verification_status: "verified" | "unverified" | "failed" | "pending" | "disabled";
  reliability_score: number;
  zk_proof?: { verified: boolean };
}

export interface SkillListItem {
  skill_id: string;
  version: string;
  name: string;
  intent_signature: string;
  domain: string;
  subdomain?: string;
  description: string;
  owner_type: "agent" | "marketplace" | "user";
  execution_type: "http" | "browser-capture";
  lifecycle: "active" | "deprecated" | "disabled";
  created_at: string;
  updated_at: string;
  endpoint_count: number;
  avg_reliability_score: number;
  endpoints: SkillListEndpointPreview[];
  proof_summary?: ProofSummary;
}

export interface SearchResult {
  id: number;
  score: number;
  metadata: Record<string, unknown>;
}

export interface AgentProfile {
  agent_id: string;
  name: string;
  created_at: string;
  wallet_address?: string | null;
  wallet_provider?: string | null;
  skills_discovered: string[];
  total_executions: number;
  total_feedback_given: number;
  tos_accepted_version?: string | null;
  tos_accepted_at?: string | null;
  last_active_at?: string;
}

export interface StatsSummary {
  skills: number;
  endpoints: number;
  domains: number;
  executions: number;
  agents: number;
}

export interface AgentHealth {
  total_agents: number;
  active_today: number;
  active_this_week: number;
  active_this_month: number;
  churned_30d: number;
  avg_executions_per_agent: number;
  median_executions_per_agent: number;
  top_agents: Array<{
    agent_id: string;
    name: string;
    executions: number;
    skills_discovered: number;
    last_active: string | null;
  }>;
}

export interface ActivationFunnel {
  total_registered: number;
  executed_once: number;
  discovered_skill: number;
  repeat_user: number;
  power_user: number;
  rates: {
    registration_to_first_exec: number;
    first_exec_to_discovery: number;
    discovery_to_repeat: number;
    repeat_to_power: number;
  };
}

export interface EngagementMetrics {
  dau: number;
  wau: number;
  mau: number;
  dau_wau_ratio: number;
  dau_mau_ratio: number;
  daily_trend: Array<{ date: string; active: number }>;
}

export interface LandingVariantAnalytics {
  variant_id: string;
  label: string;
  status: "shadow" | "canary" | "active" | "disabled";
  source: "human" | "auto_generated";
  angle_family: "browser-replacement" | "speed-proof" | "reliability" | "learn-once-reuse-later";
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
}

export interface LandingFunnelAnalytics {
  generated_at: string;
  window_days: number;
  experiment_id: string;
  control_variant_id: string;
  winner_variant_id?: string;
  winner_angle_family?: LandingVariantAnalytics["angle_family"];
  live_weights: Array<{ variant_id: string; status: LandingVariantAnalytics["status"]; weight: number }>;
  shadow_queue: Array<{ variant_id: string; label: string; source: LandingVariantAnalytics["source"]; rationale?: string }>;
  canaries: Array<{ variant_id: string; label: string; started_at?: string }>;
  optimizer_runs: Array<{ ran_at: string; winner_variant_id?: string; winner_angle_family?: LandingVariantAnalytics["angle_family"]; notes?: string }>;
  variants: LandingVariantAnalytics[];
}

export interface CurrentTos {
  version: string;
  summary: string;
  url: string;
}

export interface DashboardTransaction {
  transaction_id: string;
  direction: "spent" | "earned";
  skill_id: string;
  endpoint_id?: string;
  amount_usd: number;
  platform_fee_usd: number;
  counterparty_agent_id: string;
  status: string;
  created_at: string;
}

export interface DashboardData {
  profile: AgentProfile;
  economics: {
    spent_usd: number;
    creator_earned_usd: number;
    attribution_earned_usd: number;
    total_earned_usd: number;
    platform_fees_paid_usd: number;
    graph_fees_paid_usd: number;
    skill_spend_usd: number;
    paid_execution_usd: number;
  };
  savings: {
    baseline_time_ms: number | null;
    actual_time_ms: number | null;
    time_saved_ms: number | null;
    time_saved_hours: number | null;
    speedup_ratio: number | null;
    baseline_cost_uc: number | null;
    baseline_cost_usd: number | null;
    actual_cost_uc: number | null;
    actual_cost_usd: number | null;
    cost_saved_uc: number | null;
    cost_saved_usd: number | null;
  };
  activity: {
    total_executions: number;
    skills_discovered: number;
    total_feedback_given: number;
  };
  rank: {
    contribution_score: number;
    position: number | null;
  };
  recent_transactions: DashboardTransaction[];
}

export interface LeaderboardEntry {
  agent_id: string;
  name: string;
  wallet_address?: string;
  created_at: string;
  contribution_score: number;
  creator_earned_usd: number;
  attribution_earned_usd: number;
  total_earned_usd: number;
  executions: number;
  skills_discovered: number;
  time_saved_hours: number | null;
  cost_saved_usd: number | null;
  score_components: {
    earned_norm: number;
    execution_norm: number;
    discovery_norm: number;
  };
}

interface StoredAuth {
  apiKey?: string;
}

function readStoredAuth(): StoredAuth | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem("unbrowse_auth");
    return stored ? JSON.parse(stored) as StoredAuth : null;
  } catch {
    return null;
  }
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { apiKey?: string | null; revalidate?: number },
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    next: opts?.revalidate != null ? { revalidate: opts.revalidate } : undefined,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body, { revalidate: 30 });
}

export async function authApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const apiKey = readStoredAuth()?.apiKey ?? null;
  return request<T>(method, path, body, { apiKey });
}

export async function verifyAgentApiKey(apiKey: string): Promise<AgentProfile> {
  return request<AgentProfile>("GET", "/v1/agents/me", undefined, { apiKey: apiKey.trim() });
}

export async function listSkills(): Promise<SkillManifest[]> {
  const data = await api<{ skills: SkillManifest[] }>("GET", "/v1/skills");
  return data.skills.filter((skill) => !isSuppressedDomain(skill.domain));
}

export async function listSkillCards(opts?: {
  limit?: number;
  includeDeprecated?: boolean;
  revalidate?: number;
}): Promise<SkillListItem[]> {
  const params = new URLSearchParams({ view: "card" });
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.includeDeprecated) params.set("include_deprecated", "1");
  const data = await request<{ skills: SkillListItem[] }>(
    "GET",
    `/v1/skills?${params.toString()}`,
    undefined,
    { revalidate: opts?.revalidate ?? 300 },
  );
  return data.skills.filter((skill) => !isSuppressedDomain(skill.domain));
}

export async function listPopularSkills(limit = 8, opts?: { revalidate?: number }): Promise<PopularSkillSummary[]> {
  const data = await request<{ skills: PopularSkillSummary[] }>(
    "GET",
    `/v1/skills/popular?limit=${limit}`,
    undefined,
    { revalidate: opts?.revalidate ?? 300 },
  );
  return data.skills.filter((skill) => !isSuppressedDomain(skill.domain));
}

export async function getSkill(id: string): Promise<SkillManifest | null> {
  try {
    return await api<SkillManifest>("GET", `/v1/skills/${id}`);
  } catch {
    // Backend gates /v1/skills/{id} behind auth/x402; fall back to anonymous popular list.
    try {
      const popular = await listPopularSkills(50);
      const match = popular.find((p) => p.skill_id === id);
      if (!match) return null;
      return {
        skill_id: match.skill_id,
        version: match.version,
        name: match.name,
        intent_signature: "",
        domain: match.domain,
        description: match.description,
        owner_type: "marketplace",
        execution_type: match.execution_type,
        endpoints: [],
        lifecycle: "active",
        created_at: match.updated_at,
        updated_at: match.updated_at,
      };
    } catch {
      return null;
    }
  }
}

export async function getStatsSummary(): Promise<StatsSummary> {
  return api<StatsSummary>("GET", "/v1/stats/summary");
}

export async function getCurrentTos(): Promise<CurrentTos> {
  return api<CurrentTos>("GET", "/v1/tos/current");
}

export async function searchSkills(intent: string, domain?: string): Promise<SearchResult[]> {
  const path = domain ? "/v1/search/domain" : "/v1/search";
  const body = domain ? { intent, domain } : { intent };
  try {
    const data = await api<{ results: SearchResult[] }>("POST", path, body);
    return data.results.filter((result) => !isSuppressedDomain(searchResultDomain(result)));
  } catch {
    return [];
  }
}

export async function registerAgent(name: string, tosVersion?: string): Promise<{ agent_id: string; api_key: string }> {
  return api<{ agent_id: string; api_key: string }>("POST", "/v1/agents/register", {
    name,
    ...(tosVersion ? { tos_version: tosVersion } : {}),
  });
}

export async function getAgent(agentId: string): Promise<AgentProfile> {
  return api<AgentProfile>("GET", `/v1/agents/${agentId}`);
}

export async function listAgents(limit = 20): Promise<AgentProfile[]> {
  const data = await api<{ agents: AgentProfile[] }>("GET", `/v1/agents?limit=${limit}`);
  return data.agents;
}

export async function getMyProfile(): Promise<AgentProfile> {
  return authApi<AgentProfile>("GET", "/v1/agents/me");
}

export async function getMyDashboard(): Promise<DashboardData> {
  return authApi<DashboardData>("GET", "/v1/dashboard/me");
}

export interface OpsPayload {
  stats: StatsSummary;
  skills: SkillManifest[];
  agents: AgentProfile[];
}

export async function getOps(): Promise<OpsPayload> {
  return authApi<OpsPayload>("GET", "/v1/ops");
}

export async function getAnalyticsAgents(): Promise<AgentHealth> {
  return authApi<AgentHealth>("GET", "/v1/analytics/agents");
}

export async function getAnalyticsActivation(): Promise<ActivationFunnel> {
  return authApi<ActivationFunnel>("GET", "/v1/analytics/activation");
}

export async function getAnalyticsEngagement(): Promise<EngagementMetrics> {
  return authApi<EngagementMetrics>("GET", "/v1/analytics/engagement");
}

export async function getDashboardByWallet(walletAddress: string): Promise<DashboardData> {
  return api<DashboardData>("GET", `/v1/dashboard/wallet/${encodeURIComponent(walletAddress.trim())}`);
}

// --- Credits / Earnings ---

export interface CreditBalance {
  agent_id: string;
  granted_uc: number;
  earned_uc: number;
  consumed_uc: number;
  balance_uc: number;
  is_self_sustaining: boolean;
}

export async function getCreditBalance(): Promise<CreditBalance> {
  return authApi<CreditBalance>("GET", "/v1/credits/balance");
}

export async function getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  const data = await api<{ entries: LeaderboardEntry[] }>("GET", `/v1/leaderboard?limit=${limit}`);
  return data.entries;
}

export interface DomainCoverage {
  domain: string;
  skills: number;
  endpoints: number;
  updated_at: string;
}

export interface NetworkStats {
  total_routes: number;
  total_skills: number;
  total_agents: number;
  total_executions: number;
  total_earned_usd: number;
  marketplace_hit_rate: number;
  total_resolves: number;
  total_tokens_saved: number;
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

export interface MinerStats {
  network: NetworkStats;
  domains: DomainCoverage[];
  leaderboard: LeaderboardEntry[];
  bounties: MinerBounty[];
  quests: MinerQuest[];
}

export async function getMinerStats(): Promise<MinerStats> {
  const data = await api<MinerStats>("GET", "/v1/miners/stats");
  return {
    ...data,
    domains: data.domains.filter((domain) => !isSuppressedDomain(domain.domain)),
    bounties: data.bounties.filter((bounty) => !isSuppressedDomain(bounty.domain)),
    quests: data.quests.filter((quest) => !isSuppressedDomain(quest.target_domain)),
  };
}

// --- Skill Execution ---

export interface SkillExecuteResult {
  status: string;
  data?: unknown;
  error?: string;
  execution_time_ms?: number;
}

export async function executeSkill(skillId: string, params: Record<string, unknown> = {}): Promise<SkillExecuteResult> {
  return authApi<SkillExecuteResult>("POST", `/v1/skills/${skillId}/execute`, { params });
}

// --- Chat / Resolve ---

export interface ChatResolveResult {
  skill_id?: string;
  skill_name?: string;
  endpoint?: string;
  output?: string;
  error?: string;
  raw_result?: unknown;
}

export async function resolveIntent(intent: string): Promise<ChatResolveResult[]> {
  const results = await searchSkills(intent);
  return results
    .filter((r) => r.metadata && (r.metadata as Record<string, unknown>).skill_id)
    .map((r) => {
      const meta = r.metadata as Record<string, unknown>;
      return {
        skill_id: String(meta.skill_id ?? ""),
        skill_name: String(meta.name ?? meta.intent_signature ?? ""),
        endpoint: String(meta.domain ?? ""),
        output: `Found skill: ${meta.name ?? meta.intent_signature ?? ""} (${r.score.toFixed(4)})`,
      };
    });
}

// --- Account-bound key helpers ---

export interface AccountMe {
  user_id: string;
  email: string;
  created_at: string;
  verified_at?: string;
  keys_count: number;
  skills_count: number;
}

export interface AccountKey {
  keyId: string;
}

async function authRequestOrAccountRequired<T>(path: string): Promise<T | null> {
  const apiKey = readStoredAuth()?.apiKey ?? null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${API_URL}${path}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 403) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    if (data.error === "account_required") return null;
    throw new Error(data.error ?? `HTTP 403`);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getAccountMe(): Promise<AccountMe | null> {
  return authRequestOrAccountRequired<AccountMe>("/v1/account/me");
}

export async function getAccountKeys(): Promise<AccountKey[]> {
  const data = await authRequestOrAccountRequired<{ keys: AccountKey[] }>("/v1/account/keys");
  return data?.keys ?? [];
}

export async function getAccountSkills(): Promise<SkillManifest[]> {
  const data = await authRequestOrAccountRequired<{ skills: SkillManifest[] }>("/v1/account/skills");
  return data?.skills ?? [];
}

export interface AccountPreferences {
  share_pointers: boolean;
}

export async function getAccountPreferences(): Promise<AccountPreferences | null> {
  return authRequestOrAccountRequired<AccountPreferences>("/v1/account/preferences");
}

export async function updateAccountPreferences(
  patch: Partial<AccountPreferences>,
): Promise<AccountPreferences> {
  const apiKey = readStoredAuth()?.apiKey ?? null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${API_URL}/v1/account/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<AccountPreferences>;
}
