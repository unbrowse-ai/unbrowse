import type {
  Env,
  LandingVariant,
  LandingVariantContent,
  LandingVariantStatus,
  LandingVariantSummary,
  LandingVariantSummaryItem,
  WebTelemetryEvent,
} from "../types.js";
import { statsKV } from "./kv.js";

const VARIANT_PREFIX = "landing:variant:";
const VARIANT_INDEX_KEY = "landing:variant:_index";
const WEB_EVENT_PREFIX = "web-event:";

type LandingVariantInput = {
  variant_id?: string;
  slug?: string;
  name: string;
  icp: string;
  experiment_id?: string;
  status?: LandingVariantStatus;
  weight?: number;
  content?: LandingVariantContent;
  notes?: string;
};

type LandingVariantPatch = {
  slug?: string;
  name?: string;
  icp?: string;
  experiment_id?: string;
  status?: LandingVariantStatus;
  weight?: number;
  content?: LandingVariantContent;
  notes?: string;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clampDays(days: number | undefined, fallback = 30): number {
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(365, Math.trunc(days!)));
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function sanitizeWeight(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.round(value! * 1000) / 1000);
}

function normalizeContent(content?: LandingVariantContent): LandingVariantContent {
  if (!content) return {};
  const out: LandingVariantContent = {};
  if (typeof content.hero_eyebrow === "string") out.hero_eyebrow = content.hero_eyebrow.trim();
  if (typeof content.hero_title === "string") out.hero_title = content.hero_title.trim();
  if (typeof content.hero_highlight === "string") out.hero_highlight = content.hero_highlight.trim();
  if (typeof content.hero_body === "string") out.hero_body = content.hero_body.trim();
  if (typeof content.hero_supporting === "string") out.hero_supporting = content.hero_supporting.trim();
  if (Array.isArray(content.trust_items)) out.trust_items = content.trust_items.map((item) => String(item).trim()).filter(Boolean);
  if (typeof content.definition_title === "string") out.definition_title = content.definition_title.trim();
  if (typeof content.definition_body === "string") out.definition_body = content.definition_body.trim();
  if (typeof content.install_summary === "string") out.install_summary = content.install_summary.trim();
  return out;
}

async function readVariantIndex(env: Env): Promise<string[]> {
  const raw = await statsKV(env).get(VARIANT_INDEX_KEY) as string | null;
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? ids.map((value) => String(value)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function writeVariantIndex(env: Env, ids: string[]): Promise<void> {
  await statsKV(env).put(VARIANT_INDEX_KEY, JSON.stringify(ids));
}

export async function getLandingVariant(env: Env, variantId: string): Promise<LandingVariant | null> {
  const raw = await statsKV(env).get(`${VARIANT_PREFIX}${variantId}`) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LandingVariant;
  } catch {
    return null;
  }
}

export async function listLandingVariants(
  env: Env,
  filters?: { icp?: string; experiment_id?: string; status?: LandingVariantStatus; include_inactive?: boolean },
): Promise<LandingVariant[]> {
  const ids = await readVariantIndex(env);
  const variants = (await Promise.all(ids.map((id) => getLandingVariant(env, id)))).filter((variant): variant is LandingVariant => !!variant);
  return variants
    .filter((variant) => filters?.icp ? variant.icp === filters.icp : true)
    .filter((variant) => filters?.experiment_id ? variant.experiment_id === filters.experiment_id : true)
    .filter((variant) => {
      if (filters?.status) return variant.status === filters.status;
      if (filters?.include_inactive) return true;
      return variant.status === "active";
    })
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return b.updated_at.localeCompare(a.updated_at);
    });
}

export async function publishLandingVariant(env: Env, input: LandingVariantInput): Promise<LandingVariant> {
  const now = new Date().toISOString();
  const icp = input.icp.trim();
  const name = input.name.trim();
  const variantId = slugify(input.variant_id ?? input.slug ?? `${icp}-${name}`) || crypto.randomUUID();
  const existing = await getLandingVariant(env, variantId);
  const variant: LandingVariant = {
    variant_id: variantId,
    slug: slugify(input.slug ?? variantId) || variantId,
    name,
    icp,
    experiment_id: (input.experiment_id ?? "homepage").trim(),
    status: input.status ?? "active",
    weight: sanitizeWeight(input.weight),
    content: normalizeContent(input.content),
    notes: input.notes?.trim(),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  await statsKV(env).put(`${VARIANT_PREFIX}${variant.variant_id}`, JSON.stringify(variant));
  const ids = await readVariantIndex(env);
  if (!ids.includes(variant.variant_id)) {
    ids.push(variant.variant_id);
    await writeVariantIndex(env, ids);
  }
  return variant;
}

export async function updateLandingVariant(env: Env, variantId: string, patch: LandingVariantPatch): Promise<LandingVariant | null> {
  const existing = await getLandingVariant(env, variantId);
  if (!existing) return null;
  const updated: LandingVariant = {
    ...existing,
    slug: patch.slug ? slugify(patch.slug) || existing.slug : existing.slug,
    name: patch.name?.trim() || existing.name,
    icp: patch.icp?.trim() || existing.icp,
    experiment_id: patch.experiment_id?.trim() || existing.experiment_id,
    status: patch.status ?? existing.status,
    weight: patch.weight != null ? sanitizeWeight(patch.weight) : existing.weight,
    content: patch.content ? { ...existing.content, ...normalizeContent(patch.content) } : existing.content,
    notes: patch.notes != null ? patch.notes.trim() : existing.notes,
    updated_at: new Date().toISOString(),
  };
  await statsKV(env).put(`${VARIANT_PREFIX}${variantId}`, JSON.stringify(updated));
  return updated;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function chooseWeightedVariant(variants: LandingVariant[], seed?: string): LandingVariant | null {
  if (variants.length === 0) return null;
  const ranked = [...variants].sort((a, b) => a.variant_id.localeCompare(b.variant_id));
  if (!seed) return ranked.sort((a, b) => b.weight - a.weight || b.updated_at.localeCompare(a.updated_at))[0] ?? null;

  const weighted = ranked.map((variant) => ({ variant, weight: variant.weight > 0 ? variant.weight : 1 }));
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return weighted[0]?.variant ?? null;
  let cursor = (hashSeed(seed) / 4294967296) * total;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.variant;
  }
  return weighted[weighted.length - 1]?.variant ?? null;
}

export async function resolveLandingVariant(
  env: Env,
  opts?: { variant_id?: string; icp?: string; experiment_id?: string; seed?: string },
): Promise<LandingVariant | null> {
  if (opts?.variant_id) {
    const exact = await getLandingVariant(env, opts.variant_id);
    return exact?.status === "active" ? exact : null;
  }
  const variants = await listLandingVariants(env, {
    icp: opts?.icp,
    experiment_id: opts?.experiment_id,
  });
  return chooseWeightedVariant(variants, opts?.seed);
}

async function loadRecentWebEvents(env: Env, days: number): Promise<WebTelemetryEvent[]> {
  const cutoffMs = Date.now() - clampDays(days) * 86400_000;
  const entries = await statsKV(env).listWithValues(WEB_EVENT_PREFIX);
  return entries
    .map((entry) => {
      try {
        return JSON.parse(entry.value) as WebTelemetryEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is WebTelemetryEvent => {
      if (!event?.visitor_id || !event?.session_id || !event?.created_at) return false;
      const eventMs = Date.parse(event.created_at);
      return Number.isFinite(eventMs) && eventMs >= cutoffMs;
    });
}

export async function getLandingVariantSummary(
  env: Env,
  opts?: { days?: number; icp?: string; experiment_id?: string },
): Promise<LandingVariantSummary> {
  const windowDays = clampDays(opts?.days);
  const [variants, events] = await Promise.all([
    listLandingVariants(env, { icp: opts?.icp, experiment_id: opts?.experiment_id, include_inactive: true }),
    loadRecentWebEvents(env, windowDays),
  ]);

  const byVariant = new Map<string, LandingVariantSummaryItem>();
  for (const variant of variants) {
    byVariant.set(variant.variant_id, {
      variant_id: variant.variant_id,
      slug: variant.slug,
      name: variant.name,
      icp: variant.icp,
      experiment_id: variant.experiment_id,
      status: variant.status,
      weight: variant.weight,
      landing_views: 0,
      install_section_views: 0,
      install_command_copies: 0,
      install_section_view_rate: 0,
      install_command_copy_rate: 0,
    });
  }

  const sessionState = new Map<string, { variant_id: string; viewed: boolean; install_viewed: boolean; copied: boolean }>();
  for (const event of events) {
    const properties = event.properties ?? {};
    const variantId = typeof properties.variant_id === "string" ? properties.variant_id : "default";
    const icp = typeof properties.icp === "string" ? properties.icp : undefined;
    const experimentId = typeof properties.experiment_id === "string" ? properties.experiment_id : undefined;
    if (opts?.icp && icp !== opts.icp) continue;
    if (opts?.experiment_id && experimentId !== opts.experiment_id) continue;

    if (!byVariant.has(variantId)) {
      byVariant.set(variantId, {
        variant_id: variantId,
        slug: variantId,
        name: variantId === "default" ? "Default landing copy" : variantId,
        icp: icp ?? "default",
        experiment_id: experimentId ?? "homepage",
        status: "active",
        weight: 1,
        landing_views: 0,
        install_section_views: 0,
        install_command_copies: 0,
        install_section_view_rate: 0,
        install_command_copy_rate: 0,
      });
    }

    const key = `${variantId}:${event.visitor_id}:${event.session_id}`;
    const state = sessionState.get(key) ?? { variant_id: variantId, viewed: false, install_viewed: false, copied: false };
    if (event.name === "landing_page_viewed") state.viewed = true;
    if (event.name === "install_section_viewed") state.install_viewed = true;
    if (event.name === "install_command_copied") state.copied = true;
    sessionState.set(key, state);
  }

  for (const state of sessionState.values()) {
    const bucket = byVariant.get(state.variant_id);
    if (!bucket) continue;
    if (state.viewed) bucket.landing_views += 1;
    if (state.install_viewed) bucket.install_section_views += 1;
    if (state.copied) bucket.install_command_copies += 1;
  }

  const ranked = Array.from(byVariant.values())
    .map((item) => ({
      ...item,
      install_section_view_rate: item.landing_views > 0 ? roundRate(item.install_section_views / item.landing_views) : 0,
      install_command_copy_rate: item.landing_views > 0 ? roundRate(item.install_command_copies / item.landing_views) : 0,
    }))
    .sort((a, b) => {
      if (b.install_command_copies !== a.install_command_copies) return b.install_command_copies - a.install_command_copies;
      if (b.landing_views !== a.landing_views) return b.landing_views - a.landing_views;
      return a.variant_id.localeCompare(b.variant_id);
    });

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    variants: ranked,
  };
}
