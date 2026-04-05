import defaultHomepageExperiment from "../config/landing-homepage-experiment.default.json";
import type { Env, FunnelEvent, InstallTelemetryEvent, WebTelemetryEvent } from "../types.js";
import { statsKV } from "./kv.js";

const CONFIG_KEY = "landing-homepage:config";
const INSTALL_ATTRIBUTION_PREFIX = "landing-homepage:install:";
const TOKEN_VERSION = 1;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type LandingVariantStatus = "shadow" | "canary" | "active" | "disabled";
export type LandingVariantSource = "human" | "auto_generated";
export type LandingTrustBarItem = "benchmarks" | "speed" | "paper" | "github" | "npm";
export type LandingAngleFamily =
  | "browser-replacement"
  | "speed-proof"
  | "reliability"
  | "learn-once-reuse-later";

export interface LandingVariantCopy {
  hero_headline: string;
  hero_emphasis: string;
  hero_subheadline: string;
  hero_support_line: string;
  trust_bar_order: LandingTrustBarItem[];
  definition_heading: string;
  definition_body: string;
  install_eyebrow: string;
  install_body: string;
  hero_cta_label?: string;
}

export interface LandingVariantConfig {
  variant_id: string;
  label: string;
  status: LandingVariantStatus;
  source: LandingVariantSource;
  angle_family: LandingAngleFamily;
  weight: number;
  icp?: string | string[];
  rationale?: string;
  generated_at?: string;
  canary_started_at?: string;
  disabled_reason?: string;
  copy: LandingVariantCopy;
}

export interface LandingOptimizerRun {
  ran_at: string;
  winner_variant_id?: string;
  winner_angle_family?: LandingAngleFamily;
  notes?: string;
}

export interface LandingHomepageExperimentConfig {
  experiment_id: string;
  page: "homepage";
  updated_at: string;
  control_variant_id: string;
  assignment_salt: string;
  canary_weight_cap?: number;
  shadow_generation_limit?: number;
  optimizer_runs?: LandingOptimizerRun[];
  variants: LandingVariantConfig[];
}

export interface LandingHomepageAssignment {
  experiment_id: string;
  variant_id: string;
  assigned_at: string;
}

export interface LandingHomepageAssignmentResponse {
  assignment: LandingHomepageAssignment;
  content: LandingVariantCopy;
  status: LandingVariantStatus;
}

export interface LandingTokenClaims {
  version: number;
  token_id: string;
  page: "homepage";
  experiment_id: string;
  variant_id: string;
  visitor_id: string;
  session_id: string;
  issued_at: string;
  expires_at: string;
}

export interface LandingAttributionRecord {
  token_id: string;
  experiment_id: string;
  variant_id: string;
  visitor_id: string;
  session_id: string;
  attributed_at: string;
}

export interface LandingVariantAnalyticsSummary {
  variant_id: string;
  label: string;
  status: LandingVariantStatus;
  source: LandingVariantSource;
  angle_family: LandingAngleFamily;
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

export interface LandingHomepageAnalyticsSummary {
  generated_at: string;
  window_days: number;
  experiment_id: string;
  control_variant_id: string;
  winner_variant_id?: string;
  winner_angle_family?: LandingAngleFamily;
  live_weights: Array<{ variant_id: string; status: LandingVariantStatus; weight: number }>;
  shadow_queue: Array<{ variant_id: string; label: string; source: LandingVariantSource; rationale?: string }>;
  canaries: Array<{ variant_id: string; label: string; started_at?: string }>;
  optimizer_runs: LandingOptimizerRun[];
  variants: LandingVariantAnalyticsSummary[];
}

type LandingSessionState = {
  visitor_id: string;
  session_id: string;
  variant_id: string;
  referrer: string;
  landing_viewed: boolean;
  hero_viewed: boolean;
  install_section_viewed: boolean;
  install_command_copied: boolean;
  max_scroll_bucket: number;
  exploration_targets: Set<string>;
  sections: Set<string>;
  max_depth: number;
  utm_campaign?: string;
};

function base64UrlEncode(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(raw: string): string {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(raw.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signLandingPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToUnitInterval(value: string): Promise<number> {
  const hex = await sha256Hex(value);
  const slice = hex.slice(0, 12);
  const int = Number.parseInt(slice, 16);
  return int / 0xffffffffffff;
}

function normalizeExperiment(raw: LandingHomepageExperimentConfig): LandingHomepageExperimentConfig {
  const variants = raw.variants.map((variant) => ({
    ...variant,
    weight: Number.isFinite(variant.weight) ? Math.max(0, variant.weight) : 0,
  }));
  return {
    ...raw,
    page: "homepage",
    canary_weight_cap: raw.canary_weight_cap ?? 0.1,
    shadow_generation_limit: raw.shadow_generation_limit ?? 3,
    optimizer_runs: raw.optimizer_runs ?? [],
    variants,
  };
}

function getLiveVariants(config: LandingHomepageExperimentConfig): LandingVariantConfig[] {
  return config.variants.filter((variant) => variant.status === "active" || variant.status === "canary");
}

function normalizeWeights(config: LandingHomepageExperimentConfig): Array<{ variant: LandingVariantConfig; weight: number }> {
  const live = getLiveVariants(config);
  if (live.length === 0) return [];
  const canaries = live.filter((variant) => variant.status === "canary");
  const actives = live.filter((variant) => variant.status === "active");
  const canaryCap = Math.max(0, Math.min(0.5, config.canary_weight_cap ?? 0.1));

  const canaryWeightRaw = canaries.reduce((sum, variant) => sum + Math.max(0, variant.weight), 0);
  const activeWeightRaw = actives.reduce((sum, variant) => sum + Math.max(0, variant.weight), 0);

  const effectiveCanaryTotal = Math.min(canaryCap, canaryWeightRaw > 0 ? canaryCap : 0);
  const effectiveActiveTotal = Math.max(0, 1 - effectiveCanaryTotal);

  const normalized: Array<{ variant: LandingVariantConfig; weight: number }> = [];
  for (const variant of actives) {
    const share = activeWeightRaw > 0 ? variant.weight / activeWeightRaw : 1 / Math.max(1, actives.length);
    normalized.push({ variant, weight: share * effectiveActiveTotal });
  }
  for (const variant of canaries) {
    const share = canaryWeightRaw > 0 ? variant.weight / canaryWeightRaw : 1 / Math.max(1, canaries.length);
    normalized.push({ variant, weight: share * effectiveCanaryTotal });
  }

  const total = normalized.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) {
    return live.map((variant) => ({ variant, weight: 1 / live.length }));
  }
  return normalized.map((entry) => ({ ...entry, weight: entry.weight / total }));
}

function parseAssignmentCookie(raw: string | undefined | null): LandingHomepageAssignment | null {
  if (!raw) return null;
  try {
    return JSON.parse(base64UrlDecode(raw)) as LandingHomepageAssignment;
  } catch {
    return null;
  }
}

function stringifyAssignmentCookie(assignment: LandingHomepageAssignment): string {
  return base64UrlEncode(JSON.stringify(assignment));
}

function normalizeReferrer(value: string | null | undefined): string {
  if (!value) return "direct";
  try {
    return new URL(value).hostname || "direct";
  } catch {
    return "direct";
  }
}

function topEntries(map: Map<string, number>, limit = 5): Array<{ key: string; count: number }> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

async function listPrefix<T>(
  env: Env,
  prefix: string,
  guard: (value: unknown) => value is T,
): Promise<T[]> {
  const entries = await statsKV(env).listWithValues(prefix);
  return entries.map((entry) => {
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  }).filter(guard);
}

function isWebEvent(value: unknown): value is WebTelemetryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as WebTelemetryEvent;
  return !!event.event_id && !!event.visitor_id && !!event.session_id && !!event.created_at && !!event.name;
}

function isInstallEvent(value: unknown): value is InstallTelemetryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as InstallTelemetryEvent;
  return !!event.event_id && !!event.install_id && !!event.created_at;
}

function isFunnelEvent(value: unknown): value is FunnelEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as FunnelEvent;
  return !!event.event_id && !!event.install_id && !!event.created_at && !!event.name;
}

export async function getLandingHomepageExperimentConfig(env: Env): Promise<LandingHomepageExperimentConfig> {
  const fromKv = await statsKV(env).get(CONFIG_KEY, "json").catch(() => null) as LandingHomepageExperimentConfig | null;
  return normalizeExperiment(fromKv ?? (defaultHomepageExperiment as LandingHomepageExperimentConfig));
}

export async function saveLandingHomepageExperimentConfig(
  env: Env,
  config: LandingHomepageExperimentConfig,
): Promise<LandingHomepageExperimentConfig> {
  const normalized = normalizeExperiment(config);
  await statsKV(env).put(CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

function variantMatchesIcp(variant: LandingVariantConfig, icp: string): boolean {
  if (!variant.icp) return true;
  const targets = Array.isArray(variant.icp) ? variant.icp : [variant.icp];
  return targets.some((t) => t.toLowerCase() === icp.toLowerCase());
}

function filterVariantsByIcp(
  config: LandingHomepageExperimentConfig,
  icp: string,
): LandingHomepageExperimentConfig {
  const matched = config.variants.filter((v) => variantMatchesIcp(v, icp));
  if (matched.length === 0) return config;
  return { ...config, variants: matched };
}

export async function assignLandingHomepageVariant(
  env: Env,
  visitorId: string,
  currentAssignmentRaw?: string | null,
  visitorIcp?: string | null,
): Promise<LandingHomepageAssignmentResponse> {
  const config = await getLandingHomepageExperimentConfig(env);
  const currentAssignment = parseAssignmentCookie(currentAssignmentRaw);
  if (currentAssignment?.experiment_id === config.experiment_id) {
    const variant = config.variants.find((entry) =>
      entry.variant_id === currentAssignment.variant_id && (entry.status === "active" || entry.status === "canary"));
    if (variant) {
      return {
        assignment: currentAssignment,
        content: variant.copy,
        status: variant.status,
      };
    }
  }

  const filtered = visitorIcp ? filterVariantsByIcp(config, visitorIcp) : config;
  const weighted = normalizeWeights(filtered);
  const hash = await hashToUnitInterval(`${config.experiment_id}:${config.assignment_salt}:${visitorId}`);
  let cursor = 0;
  let chosen = weighted[0]?.variant ?? config.variants.find((variant) => variant.variant_id === config.control_variant_id) ?? config.variants[0];
  for (const entry of weighted) {
    cursor += entry.weight;
    if (hash <= cursor) {
      chosen = entry.variant;
      break;
    }
  }

  const assignment: LandingHomepageAssignment = {
    experiment_id: config.experiment_id,
    variant_id: chosen.variant_id,
    assigned_at: new Date().toISOString(),
  };

  return {
    assignment,
    content: chosen.copy,
    status: chosen.status,
  };
}

export function encodeLandingHomepageAssignmentCookie(assignment: LandingHomepageAssignment): string {
  return stringifyAssignmentCookie(assignment);
}

export async function mintLandingHomepageToken(
  env: Env,
  input: {
    experiment_id: string;
    variant_id: string;
    visitor_id: string;
    session_id: string;
  },
): Promise<{ token: string; claims: LandingTokenClaims }> {
  const config = await getLandingHomepageExperimentConfig(env);
  if (input.experiment_id !== config.experiment_id) {
    throw new Error("experiment_mismatch");
  }
  const variant = config.variants.find((entry) => entry.variant_id === input.variant_id);
  if (!variant || (variant.status !== "active" && variant.status !== "canary")) {
    throw new Error("variant_not_live");
  }
  const issuedAt = new Date();
  const claims: LandingTokenClaims = {
    version: TOKEN_VERSION,
    token_id: crypto.randomUUID(),
    page: "homepage",
    experiment_id: input.experiment_id,
    variant_id: input.variant_id,
    visitor_id: input.visitor_id,
    session_id: input.session_id,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + TOKEN_TTL_MS).toISOString(),
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await signLandingPayload(env.API_KEY, payload);
  return { token: `${payload}.${signature}`, claims };
}

export async function resolveLandingHomepageToken(env: Env, token: string): Promise<LandingTokenClaims | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = await signLandingPayload(env.API_KEY, payload);
  if (expected !== signature) return null;
  try {
    const claims = JSON.parse(base64UrlDecode(payload)) as LandingTokenClaims;
    if (claims.version !== TOKEN_VERSION || claims.page !== "homepage") return null;
    if (Date.parse(claims.expires_at) < Date.now()) return null;
    const config = await getLandingHomepageExperimentConfig(env);
    const variant = config.variants.find((entry) => entry.variant_id === claims.variant_id);
    if (!variant) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function getLandingHomepageInstallAttribution(
  env: Env,
  installId: string,
  landingToken?: string | null,
): Promise<LandingAttributionRecord | null> {
  const existing = await statsKV(env).get(`${INSTALL_ATTRIBUTION_PREFIX}${installId}`, "json").catch(() => null) as LandingAttributionRecord | null;
  if (existing) return existing;
  if (!landingToken) return null;
  const claims = await resolveLandingHomepageToken(env, landingToken);
  if (!claims) return null;
  const record: LandingAttributionRecord = {
    token_id: claims.token_id,
    experiment_id: claims.experiment_id,
    variant_id: claims.variant_id,
    visitor_id: claims.visitor_id,
    session_id: claims.session_id,
    attributed_at: new Date().toISOString(),
  };
  await statsKV(env).put(`${INSTALL_ATTRIBUTION_PREFIX}${installId}`, JSON.stringify(record));
  return record;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
}

export async function getLandingHomepageAnalyticsSummary(env: Env, days = 30): Promise<LandingHomepageAnalyticsSummary> {
  const config = await getLandingHomepageExperimentConfig(env);
  const cutoffMs = Date.now() - Math.max(1, Math.min(180, Math.trunc(days))) * 86400_000;
  const [webEvents, installEvents, funnelEvents] = await Promise.all([
    listPrefix(env, "web-event:", isWebEvent),
    listPrefix(env, "install-event:", isInstallEvent),
    listPrefix(env, "funnel-event:", isFunnelEvent),
  ]);

  const sessions = new Map<string, LandingSessionState>();
  const variantVisitors = new Map<string, Set<string>>();
  const variantInstallIds = new Map<string, Set<string>>();
  const variantSetupIds = new Map<string, Set<string>>();
  const variantRegistrationIds = new Map<string, Set<string>>();
  const variantResolveStartIds = new Map<string, Set<string>>();
  const variantResolveSuccessIds = new Map<string, Set<string>>();

  for (const event of webEvents) {
    const eventMs = Date.parse(event.created_at);
    if (!Number.isFinite(eventMs) || eventMs < cutoffMs) continue;
    if (event.experiment_id !== config.experiment_id || !event.variant_id) continue;
    const key = `${event.visitor_id}:${event.session_id}`;
    const state = sessions.get(key) ?? {
      visitor_id: event.visitor_id,
      session_id: event.session_id,
      variant_id: event.variant_id,
      referrer: normalizeReferrer(event.referrer),
      landing_viewed: false,
      hero_viewed: false,
      install_section_viewed: false,
      install_command_copied: false,
      max_scroll_bucket: 0,
      exploration_targets: new Set<string>(),
      sections: new Set<string>(),
      max_depth: 0,
      utm_campaign: typeof event.properties?.utm_campaign === "string" ? event.properties.utm_campaign : undefined,
    };
    if (event.name === "landing_page_viewed") state.landing_viewed = true;
    if (event.name === "hero_viewed") state.hero_viewed = true;
    if (event.name === "install_section_viewed") state.install_section_viewed = true;
    if (event.name === "install_command_copied") state.install_command_copied = true;
    if (event.name === "scroll_depth_reached") {
      const bucket = Number(event.properties?.bucket ?? 0);
      if (Number.isFinite(bucket)) state.max_scroll_bucket = Math.max(state.max_scroll_bucket, bucket);
    }
    if (event.name === "section_viewed") {
      const sectionId = String(event.properties?.section_id ?? "");
      if (sectionId) state.sections.add(sectionId);
    }
    if (event.name === "exploration_page_clicked") {
      const targetId = String(event.properties?.target_id ?? "");
      if (targetId) state.exploration_targets.add(targetId);
    }
    if (event.name === "page_exploration_depth_updated") {
      const depth = Number(event.properties?.depth ?? 0);
      if (Number.isFinite(depth)) state.max_depth = Math.max(state.max_depth, depth);
    }
    sessions.set(key, state);
  }

  const variantSummaries = new Map<string, LandingVariantAnalyticsSummary>();
  for (const variant of config.variants) {
    variantSummaries.set(variant.variant_id, {
      variant_id: variant.variant_id,
      label: variant.label,
      status: variant.status,
      source: variant.source,
      angle_family: variant.angle_family,
      weight: variant.weight,
      rationale: variant.rationale,
      canary_started_at: variant.canary_started_at,
      disabled_reason: variant.disabled_reason,
      generated_at: variant.generated_at,
      landing_visitors: 0,
      landing_sessions: 0,
      hero_views: 0,
      install_section_views: 0,
      install_command_copies: 0,
      install_started: 0,
      setup_completed: 0,
      registrations: 0,
      first_resolve_started: 0,
      first_resolve_succeeded: 0,
      bounce_sessions: 0,
      no_exploration_sessions: 0,
      avg_exploration_depth: 0,
      max_scroll_bucket_reached: 0,
      rates: {
        install_copy_from_landing: 0,
        install_started_from_landing: 0,
        setup_completed_from_landing: 0,
        first_resolve_succeeded_from_landing: 0,
        first_resolve_succeeded_from_install_started: 0,
      },
      top_referrers: [],
      top_campaigns: [],
    });
  }

  const referrersByVariant = new Map<string, Map<string, number>>();
  const campaignsByVariant = new Map<string, Map<string, number>>();
  const explorationTotals = new Map<string, number>();

  for (const session of sessions.values()) {
    const summary = variantSummaries.get(session.variant_id);
    if (!summary || !session.landing_viewed) continue;
    summary.landing_sessions++;
    summary.hero_views += session.hero_viewed ? 1 : 0;
    summary.install_section_views += session.install_section_viewed ? 1 : 0;
    summary.install_command_copies += session.install_command_copied ? 1 : 0;
    summary.max_scroll_bucket_reached = Math.max(summary.max_scroll_bucket_reached, session.max_scroll_bucket);
    const depth = Math.max(session.max_depth, session.exploration_targets.size + session.sections.size);
    if (depth === 0) summary.no_exploration_sessions++;
    if (!session.install_section_viewed && depth === 0 && session.max_scroll_bucket < 50) {
      summary.bounce_sessions++;
    }
    explorationTotals.set(session.variant_id, (explorationTotals.get(session.variant_id) ?? 0) + depth);
    const visitors = variantVisitors.get(session.variant_id) ?? new Set<string>();
    visitors.add(session.visitor_id);
    variantVisitors.set(session.variant_id, visitors);

    const referrerMap = referrersByVariant.get(session.variant_id) ?? new Map<string, number>();
    referrerMap.set(session.referrer, (referrerMap.get(session.referrer) ?? 0) + 1);
    referrersByVariant.set(session.variant_id, referrerMap);

    const campaign = session.utm_campaign?.trim();
    if (campaign) {
      const campaignMap = campaignsByVariant.get(session.variant_id) ?? new Map<string, number>();
      campaignMap.set(campaign, (campaignMap.get(campaign) ?? 0) + 1);
      campaignsByVariant.set(session.variant_id, campaignMap);
    }
  }

  for (const event of installEvents) {
    const eventMs = Date.parse(event.created_at);
    if (!Number.isFinite(eventMs) || eventMs < cutoffMs) continue;
    if (event.landing_experiment_id !== config.experiment_id || !event.landing_variant_id) continue;
    const installs = variantInstallIds.get(event.landing_variant_id) ?? new Set<string>();
    installs.add(event.install_id);
    variantInstallIds.set(event.landing_variant_id, installs);
  }

  for (const event of funnelEvents) {
    const eventMs = Date.parse(event.created_at);
    if (!Number.isFinite(eventMs) || eventMs < cutoffMs) continue;
    if (event.landing_experiment_id !== config.experiment_id || !event.landing_variant_id) continue;
    const variantId = event.landing_variant_id;
    if (event.name === "setup_completed") {
      const ids = variantSetupIds.get(variantId) ?? new Set<string>();
      ids.add(event.install_id);
      variantSetupIds.set(variantId, ids);
    }
    if (event.name === "registration_succeeded") {
      const ids = variantRegistrationIds.get(variantId) ?? new Set<string>();
      ids.add(event.install_id);
      variantRegistrationIds.set(variantId, ids);
    }
    if (event.name === "resolve_started") {
      const ids = variantResolveStartIds.get(variantId) ?? new Set<string>();
      ids.add(event.install_id);
      variantResolveStartIds.set(variantId, ids);
    }
    if (event.name === "resolve_completed") {
      const ids = variantResolveSuccessIds.get(variantId) ?? new Set<string>();
      ids.add(event.install_id);
      variantResolveSuccessIds.set(variantId, ids);
    }
  }

  let winnerVariantId: string | undefined;
  let winnerAngleFamily: LandingAngleFamily | undefined;
  let winnerRate = -1;

  for (const [variantId, summary] of variantSummaries.entries()) {
    const visitors = variantVisitors.get(variantId)?.size ?? 0;
    summary.landing_visitors = visitors;
    summary.install_started = variantInstallIds.get(variantId)?.size ?? 0;
    summary.setup_completed = variantSetupIds.get(variantId)?.size ?? 0;
    summary.registrations = variantRegistrationIds.get(variantId)?.size ?? 0;
    summary.first_resolve_started = variantResolveStartIds.get(variantId)?.size ?? 0;
    summary.first_resolve_succeeded = variantResolveSuccessIds.get(variantId)?.size ?? 0;
    summary.avg_exploration_depth = summary.landing_sessions > 0
      ? Math.round(((explorationTotals.get(variantId) ?? 0) / summary.landing_sessions) * 100) / 100
      : 0;
    summary.rates.install_copy_from_landing = rate(summary.install_command_copies, visitors);
    summary.rates.install_started_from_landing = rate(summary.install_started, visitors);
    summary.rates.setup_completed_from_landing = rate(summary.setup_completed, visitors);
    summary.rates.first_resolve_succeeded_from_landing = rate(summary.first_resolve_succeeded, visitors);
    summary.rates.first_resolve_succeeded_from_install_started = rate(summary.first_resolve_succeeded, summary.install_started);
    summary.top_referrers = topEntries(referrersByVariant.get(variantId) ?? new Map<string, number>())
      .map((entry) => ({ referrer: entry.key, sessions: entry.count }));
    summary.top_campaigns = topEntries(campaignsByVariant.get(variantId) ?? new Map<string, number>())
      .map((entry) => ({ campaign: entry.key, sessions: entry.count }));

    if (summary.status === "active" && visitors >= 1 && summary.rates.first_resolve_succeeded_from_landing > winnerRate) {
      winnerRate = summary.rates.first_resolve_succeeded_from_landing;
      winnerVariantId = summary.variant_id;
      winnerAngleFamily = summary.angle_family;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    window_days: Math.max(1, Math.min(180, Math.trunc(days))),
    experiment_id: config.experiment_id,
    control_variant_id: config.control_variant_id,
    winner_variant_id: winnerVariantId,
    winner_angle_family: winnerAngleFamily,
    live_weights: config.variants
      .filter((variant) => variant.status === "active" || variant.status === "canary")
      .map((variant) => ({ variant_id: variant.variant_id, status: variant.status, weight: variant.weight })),
    shadow_queue: config.variants
      .filter((variant) => variant.status === "shadow")
      .map((variant) => ({ variant_id: variant.variant_id, label: variant.label, source: variant.source, rationale: variant.rationale })),
    canaries: config.variants
      .filter((variant) => variant.status === "canary")
      .map((variant) => ({ variant_id: variant.variant_id, label: variant.label, started_at: variant.canary_started_at })),
    optimizer_runs: config.optimizer_runs ?? [],
    variants: Array.from(variantSummaries.values()),
  };
}
