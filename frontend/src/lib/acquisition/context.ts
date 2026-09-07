export const VISITOR_ID_COOKIE = "ub_vid";
export const FIRST_TOUCH_COOKIE = "ub_ft";
export const LANDING_ASSIGNMENT_COOKIE = "ub_la";

const MAX_VALUE_LENGTH = 160;

const ACQUISITION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_id",
  "gclid",
  "wbraid",
  "gbraid",
  "fbclid",
  "twclid",
  "ttclid",
  "msclkid",
  "li_fat_id",
  "referrer_host",
  "channel",
  "campaign_id",
  "campaign_name",
  "content_id",
  "content_type",
  "creative_id",
  "ad_id",
  "adset_id",
  "inferred_icp",
] as const;

export type AcquisitionKey = (typeof ACQUISITION_KEYS)[number];

export interface AcquisitionContext {
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
}

export interface LandingAssignment {
  variant_id: string;
  icp?: string;
  experiment_id?: string;
}

export interface LandingRequestContext {
  variantId?: string;
  icp?: string;
  experimentId?: string;
  seed?: string;
}

function sanitizeValue(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_VALUE_LENGTH);
}

function hostnameFromReferrer(referrer: string | null | undefined): string | undefined {
  const value = sanitizeValue(referrer);
  if (!value) return undefined;
  try {
    const hostname = new URL(value).hostname.trim();
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

function normalizeNeedle(value: string | undefined): string {
  return value?.toLowerCase() ?? "";
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function inferChannel(context: Partial<AcquisitionContext>): string | undefined {
  const source = normalizeNeedle(context.channel ?? context.utm_source);
  const referrer = normalizeNeedle(context.referrer_host);
  const medium = normalizeNeedle(context.utm_medium);
  const haystack = [source, referrer, medium].filter(Boolean).join(" ");

  if (!haystack) return undefined;
  if (includesAny(haystack, ["x", "twitter", "t.co", "x.com"])) return "x";
  if (includesAny(haystack, ["google", "gclid"])) return "google";
  if (includesAny(haystack, ["linkedin", "li_fat_id"])) return "linkedin";
  if (includesAny(haystack, ["meta", "facebook", "instagram", "fbclid"])) return "meta";
  if (includesAny(haystack, ["tiktok", "ttclid"])) return "tiktok";
  if (includesAny(haystack, ["bing", "microsoft", "msclkid"])) return "bing";
  if (includesAny(haystack, ["email", "newsletter"])) return "email";
  if (includesAny(haystack, ["reddit"])) return "reddit";
  if (includesAny(haystack, ["hackernews", "news.ycombinator.com", "hn"])) return "hackernews";
  return context.utm_source ?? context.referrer_host;
}

export function inferIcpFromContext(context: Partial<AcquisitionContext>): string | undefined {
  const haystack = [
    context.utm_source,
    context.utm_medium,
    context.utm_campaign,
    context.utm_content,
    context.utm_term,
    context.referrer_host,
  ]
    .map(normalizeNeedle)
    .filter(Boolean)
    .join(" ");

  if (!haystack) return undefined;

  if (includesAny(haystack, ["openclaw", "personal agent", "plugin"])) {
    return "openclaw-normie";
  }

  if (includesAny(haystack, ["mcp", "claude code", "cursor", "tool calling"])) {
    return "mcp-host";
  }

  if (includesAny(haystack, ["playwright", "puppeteer", "browser-use", "browser automation", "agent builder", "automation"])) {
    return "agent-builder";
  }

  return undefined;
}

export function extractAcquisitionContext(url: URL, referrer?: string | null): AcquisitionContext {
  const context: AcquisitionContext = {
    utm_source: sanitizeValue(url.searchParams.get("utm_source")),
    utm_medium: sanitizeValue(url.searchParams.get("utm_medium")),
    utm_campaign: sanitizeValue(url.searchParams.get("utm_campaign")),
    utm_content: sanitizeValue(url.searchParams.get("utm_content")),
    utm_term: sanitizeValue(url.searchParams.get("utm_term")),
    utm_id: sanitizeValue(url.searchParams.get("utm_id")),
    gclid: sanitizeValue(url.searchParams.get("gclid")),
    wbraid: sanitizeValue(url.searchParams.get("wbraid")),
    gbraid: sanitizeValue(url.searchParams.get("gbraid")),
    fbclid: sanitizeValue(url.searchParams.get("fbclid")),
    twclid: sanitizeValue(url.searchParams.get("twclid")),
    ttclid: sanitizeValue(url.searchParams.get("ttclid")),
    msclkid: sanitizeValue(url.searchParams.get("msclkid")),
    li_fat_id: sanitizeValue(url.searchParams.get("li_fat_id")),
    referrer_host: hostnameFromReferrer(referrer),
    channel: sanitizeValue(url.searchParams.get("channel")),
    campaign_id: sanitizeValue(url.searchParams.get("campaign_id")),
    campaign_name: sanitizeValue(url.searchParams.get("campaign_name")),
    content_id: sanitizeValue(url.searchParams.get("content_id")),
    content_type: sanitizeValue(url.searchParams.get("content_type")),
    creative_id: sanitizeValue(url.searchParams.get("creative_id")),
    ad_id: sanitizeValue(url.searchParams.get("ad_id")),
    adset_id: sanitizeValue(url.searchParams.get("adset_id")),
  };
  context.channel = inferChannel(context);
  if (!context.campaign_id) context.campaign_id = context.utm_campaign;
  if (!context.content_id) context.content_id = context.utm_content;
  if (!context.creative_id) context.creative_id = context.ad_id;
  const inferredIcp = inferIcpFromContext(context);
  if (inferredIcp) context.inferred_icp = inferredIcp;
  return context;
}

export function hasAcquisitionSignals(context: Partial<AcquisitionContext> | null | undefined): boolean {
  if (!context) return false;
  return ACQUISITION_KEYS.some((key) => typeof context[key] === "string" && Boolean(context[key]));
}

function serializeJsonCookie(value: object): string {
  return encodeURIComponent(JSON.stringify(value));
}

function parseJsonCookie<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
}

export function serializeAcquisitionContext(context: AcquisitionContext): string {
  const sanitized: AcquisitionContext = {};
  for (const key of ACQUISITION_KEYS) {
    const value = sanitizeValue(context[key]);
    if (value) sanitized[key] = value;
  }
  return serializeJsonCookie(sanitized);
}

export function parseAcquisitionContext(value: string | undefined): AcquisitionContext | null {
  const parsed = parseJsonCookie<Record<string, unknown>>(value);
  if (!parsed) return null;
  const context: AcquisitionContext = {};
  for (const key of ACQUISITION_KEYS) {
    const cleaned = sanitizeValue(typeof parsed[key] === "string" ? parsed[key] : undefined);
    if (cleaned) context[key] = cleaned;
  }
  return hasAcquisitionSignals(context) ? context : null;
}

export function serializeLandingAssignment(assignment: LandingAssignment): string {
  return serializeJsonCookie({
    variant_id: sanitizeValue(assignment.variant_id),
    icp: sanitizeValue(assignment.icp),
    experiment_id: sanitizeValue(assignment.experiment_id),
  });
}

export function parseLandingAssignment(value: string | undefined): LandingAssignment | null {
  const parsed = parseJsonCookie<Record<string, unknown>>(value);
  if (!parsed) return null;
  const variantId = sanitizeValue(typeof parsed.variant_id === "string" ? parsed.variant_id : undefined);
  if (!variantId) return null;
  const icp = sanitizeValue(typeof parsed.icp === "string" ? parsed.icp : undefined);
  const experimentId = sanitizeValue(typeof parsed.experiment_id === "string" ? parsed.experiment_id : undefined);
  return {
    variant_id: variantId,
    icp,
    experiment_id: experimentId,
  };
}

export function readNamedCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (!part) continue;
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    if (key !== name) continue;
    return part.slice(eqIndex + 1).trim();
  }
  return undefined;
}

export function resolveLandingRequestContext(args: {
  searchParams?: { variantId?: string; icp?: string; experimentId?: string; seed?: string };
  visitorId?: string;
  inferredIcp?: string;
  firstTouch?: AcquisitionContext | null;
  assignment?: LandingAssignment | null;
}): LandingRequestContext {
  const variantId = sanitizeValue(args.searchParams?.variantId) ?? args.assignment?.variant_id;
  const icp =
    sanitizeValue(args.searchParams?.icp) ??
    args.assignment?.icp ??
    args.firstTouch?.inferred_icp ??
    sanitizeValue(args.inferredIcp);
  const experimentId =
    sanitizeValue(args.searchParams?.experimentId) ??
    args.assignment?.experiment_id ??
    "homepage";
  const seed = sanitizeValue(args.searchParams?.seed) ?? sanitizeValue(args.visitorId);

  return {
    variantId,
    icp,
    experimentId,
    seed,
  };
}
