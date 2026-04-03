import type {
  CampaignFeedbackRow,
  CampaignFeedbackSummary,
  Env,
  FunnelEvent,
  InstallTelemetryEvent,
  WebTelemetryEvent,
} from "../types.js";
import { statsKV } from "./kv.js";

const WEB_EVENT_PREFIX = "web-event:";
const INSTALL_EVENT_PREFIX = "install-event:";
const FUNNEL_EVENT_PREFIX = "funnel-event:";
const SESSION_PREFIX = "analytics:session:";

type StoredSessionSummary = {
  session_id: string;
  started_at: string;
  success?: boolean;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  utm_id?: string;
  gclid?: string;
  wbraid?: string;
  gbraid?: string;
  fbclid?: string;
  twclid?: string;
  ttclid?: string;
  msclkid?: string;
  li_fat_id?: string;
  referrer_host?: string;
  channel?: string;
  campaign_id?: string;
  campaign_name?: string;
  content_id?: string;
  content_type?: string;
  creative_id?: string;
  ad_id?: string;
  adset_id?: string;
  inferred_icp?: string;
  variant_id?: string;
  experiment_id?: string;
  icp?: string;
};

type CampaignFeedbackFilters = {
  channel?: string;
  campaign_id?: string;
  content_id?: string;
  inferred_icp?: string;
  variant_id?: string;
  experiment_id?: string;
};

type CampaignAttribution = {
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
};

type CampaignRowState = {
  attribution: CampaignAttribution;
  landing_sessions: Set<string>;
  content_page_sessions: Set<string>;
  install_section_views: Set<string>;
  install_command_copies: Set<string>;
  reported_installs: Set<string>;
  setup_completed: Set<string>;
  cli_invoked: Set<string>;
  registrations: Set<string>;
  first_resolve_started: Set<string>;
  first_resolve_succeeded: Set<string>;
  total_sessions: Set<string>;
  successful_sessions: Set<string>;
};

function clampDays(days: number | undefined, fallback = 30): number {
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(365, Math.trunc(days!)));
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

function sanitizeValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 160);
}

function normalizeReferrer(value: string | null | undefined): string | undefined {
  const referrer = sanitizeValue(value);
  if (!referrer) return undefined;
  try {
    return new URL(referrer).hostname || undefined;
  } catch {
    return referrer;
  }
}

function extractAttribution(
  properties?: Record<string, unknown>,
  referrer?: string | null,
): CampaignAttribution {
  const utmSource = sanitizeValue(properties?.utm_source);
  const utmCampaign = sanitizeValue(properties?.utm_campaign);
  const utmContent = sanitizeValue(properties?.utm_content);
  const channel =
    sanitizeValue(properties?.channel) ??
    utmSource ??
    sanitizeValue(properties?.referrer_host) ??
    normalizeReferrer(referrer) ??
    "direct";

  return {
    channel,
    campaign_id: sanitizeValue(properties?.campaign_id) ?? utmCampaign ?? "unattributed",
    campaign_name: sanitizeValue(properties?.campaign_name),
    content_id: sanitizeValue(properties?.content_id) ?? utmContent,
    content_type: sanitizeValue(properties?.content_type),
    creative_id: sanitizeValue(properties?.creative_id) ?? sanitizeValue(properties?.ad_id),
    ad_id: sanitizeValue(properties?.ad_id),
    adset_id: sanitizeValue(properties?.adset_id),
    inferred_icp: sanitizeValue(properties?.inferred_icp) ?? sanitizeValue(properties?.icp),
    variant_id: sanitizeValue(properties?.variant_id),
    experiment_id: sanitizeValue(properties?.experiment_id),
  };
}

function extractSessionAttribution(session: StoredSessionSummary): CampaignAttribution {
  return extractAttribution(session as unknown as Record<string, unknown>);
}

function matchesFilters(attribution: CampaignAttribution, filters?: CampaignFeedbackFilters): boolean {
  if (!filters) return true;
  if (filters.channel && attribution.channel !== filters.channel) return false;
  if (filters.campaign_id && attribution.campaign_id !== filters.campaign_id) return false;
  if (filters.content_id && attribution.content_id !== filters.content_id) return false;
  if (filters.inferred_icp && attribution.inferred_icp !== filters.inferred_icp) return false;
  if (filters.variant_id && attribution.variant_id !== filters.variant_id) return false;
  if (filters.experiment_id && attribution.experiment_id !== filters.experiment_id) return false;
  return true;
}

function campaignKey(attribution: CampaignAttribution): string {
  return [
    attribution.channel,
    attribution.campaign_id,
    attribution.content_id ?? "",
    attribution.content_type ?? "",
    attribution.variant_id ?? "",
    attribution.experiment_id ?? "",
    attribution.inferred_icp ?? "",
  ].join("::");
}

function ensureRow(
  rows: Map<string, CampaignRowState>,
  attribution: CampaignAttribution,
): CampaignRowState {
  const key = campaignKey(attribution);
  const existing = rows.get(key);
  if (existing) return existing;

  const created: CampaignRowState = {
    attribution,
    landing_sessions: new Set<string>(),
    content_page_sessions: new Set<string>(),
    install_section_views: new Set<string>(),
    install_command_copies: new Set<string>(),
    reported_installs: new Set<string>(),
    setup_completed: new Set<string>(),
    cli_invoked: new Set<string>(),
    registrations: new Set<string>(),
    first_resolve_started: new Set<string>(),
    first_resolve_succeeded: new Set<string>(),
    total_sessions: new Set<string>(),
    successful_sessions: new Set<string>(),
  };
  rows.set(key, created);
  return created;
}

async function loadEntries<T extends { created_at?: string; started_at?: string }>(
  env: Env,
  prefix: string,
  days: number,
): Promise<T[]> {
  const cutoffMs = Date.now() - clampDays(days) * 86400_000;
  const entries = await statsKV(env).listWithValues(prefix);
  return entries.flatMap((entry) => {
    try {
      return [JSON.parse(entry.value) as T];
    } catch {
      return [];
    }
  }).filter((entry) => {
    const raw = entry.created_at ?? entry.started_at;
    if (!raw) return false;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) && ms >= cutoffMs;
  });
}

export async function getCampaignFeedbackSummary(
  env: Env,
  opts?: { days?: number; filters?: CampaignFeedbackFilters },
): Promise<CampaignFeedbackSummary> {
  const windowDays = clampDays(opts?.days);
  const [webEvents, installEvents, funnelEvents, sessions] = await Promise.all([
    loadEntries<WebTelemetryEvent>(env, WEB_EVENT_PREFIX, windowDays),
    loadEntries<InstallTelemetryEvent>(env, INSTALL_EVENT_PREFIX, windowDays),
    loadEntries<FunnelEvent>(env, FUNNEL_EVENT_PREFIX, windowDays),
    loadEntries<StoredSessionSummary>(env, SESSION_PREFIX, windowDays),
  ]);

  const rows = new Map<string, CampaignRowState>();

  for (const event of webEvents) {
    const attribution = extractAttribution(event.properties, event.referrer);
    if (!matchesFilters(attribution, opts?.filters)) continue;
    const row = ensureRow(rows, attribution);
    const sessionKey = `${event.visitor_id}:${event.session_id}`;

    switch (event.name) {
      case "landing_page_viewed":
        row.landing_sessions.add(sessionKey);
        break;
      case "content_page_viewed":
        row.content_page_sessions.add(sessionKey);
        break;
      case "install_section_viewed":
        row.install_section_views.add(sessionKey);
        break;
      case "install_command_copied":
        row.install_command_copies.add(sessionKey);
        break;
    }
  }

  for (const event of installEvents) {
    const attribution = extractAttribution(event.properties);
    if (!matchesFilters(attribution, opts?.filters)) continue;
    const row = ensureRow(rows, attribution);
    row.reported_installs.add(event.install_id);
  }

  for (const event of funnelEvents) {
    const attribution = extractAttribution(event.properties);
    if (!matchesFilters(attribution, opts?.filters)) continue;
    const row = ensureRow(rows, attribution);

    switch (event.name) {
      case "setup_completed":
        row.setup_completed.add(event.install_id);
        break;
      case "cli_invoked":
        row.cli_invoked.add(event.install_id);
        break;
      case "registration_succeeded":
        row.registrations.add(event.install_id);
        break;
      case "resolve_started":
        row.first_resolve_started.add(event.install_id);
        break;
      case "resolve_completed":
        row.first_resolve_succeeded.add(event.install_id);
        break;
    }
  }

  for (const session of sessions) {
    const attribution = extractSessionAttribution(session);
    if (!matchesFilters(attribution, opts?.filters)) continue;
    const row = ensureRow(rows, attribution);
    row.total_sessions.add(session.session_id);
    if (session.success !== false) {
      row.successful_sessions.add(session.session_id);
    }
  }

  const outputRows: CampaignFeedbackRow[] = Array.from(rows.values())
    .map((row) => ({
      channel: row.attribution.channel,
      campaign_id: row.attribution.campaign_id,
      campaign_name: row.attribution.campaign_name,
      content_id: row.attribution.content_id,
      content_type: row.attribution.content_type,
      creative_id: row.attribution.creative_id,
      ad_id: row.attribution.ad_id,
      adset_id: row.attribution.adset_id,
      inferred_icp: row.attribution.inferred_icp,
      variant_id: row.attribution.variant_id,
      experiment_id: row.attribution.experiment_id,
      landing_sessions: row.landing_sessions.size,
      content_page_sessions: row.content_page_sessions.size,
      install_section_views: row.install_section_views.size,
      install_command_copies: row.install_command_copies.size,
      reported_installs: row.reported_installs.size,
      setup_completed: row.setup_completed.size,
      cli_invoked: row.cli_invoked.size,
      registrations: row.registrations.size,
      first_resolve_started: row.first_resolve_started.size,
      first_resolve_succeeded: row.first_resolve_succeeded.size,
      total_sessions: row.total_sessions.size,
      successful_sessions: row.successful_sessions.size,
      install_copy_rate_from_landing: rate(row.install_command_copies.size, row.landing_sessions.size),
      reported_install_rate_from_copy: rate(row.reported_installs.size, row.install_command_copies.size),
      first_resolve_success_rate_from_install: rate(row.first_resolve_succeeded.size, row.reported_installs.size),
      session_success_rate: rate(row.successful_sessions.size, row.total_sessions.size),
    }))
    .sort((a, b) =>
      b.first_resolve_succeeded - a.first_resolve_succeeded ||
      b.reported_installs - a.reported_installs ||
      b.install_command_copies - a.install_command_copies ||
      b.content_page_sessions - a.content_page_sessions ||
      a.channel.localeCompare(b.channel) ||
      a.campaign_id.localeCompare(b.campaign_id),
    );

  const filters = opts?.filters && Object.keys(opts.filters).length > 0 ? opts.filters : undefined;

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    filters,
    rows: outputRows,
  };
}
