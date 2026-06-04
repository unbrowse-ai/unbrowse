export const TELEMETRY_ATTRIBUTION_KEYS = [
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
  "variant_id",
  "experiment_id",
  "icp",
] as const;

export type TelemetryAttributionKey = (typeof TELEMETRY_ATTRIBUTION_KEYS)[number];

export interface TelemetryAttribution {
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
}

const MAX_ATTRIBUTION_VALUE_LENGTH = 160;

export function sanitizeAttributionValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_ATTRIBUTION_VALUE_LENGTH);
}

export function hasTelemetryAttribution(value: Partial<TelemetryAttribution> | null | undefined): boolean {
  if (!value) return false;
  return TELEMETRY_ATTRIBUTION_KEYS.some((key) => Boolean(sanitizeAttributionValue(value[key])));
}

export function sanitizeTelemetryAttribution(
  raw: Partial<Record<TelemetryAttributionKey, unknown>> | null | undefined,
): TelemetryAttribution | undefined {
  if (!raw) return undefined;
  const cleaned: TelemetryAttribution = {};
  for (const key of TELEMETRY_ATTRIBUTION_KEYS) {
    const value = sanitizeAttributionValue(raw[key]);
    if (value) cleaned[key] = value;
  }
  return hasTelemetryAttribution(cleaned) ? cleaned : undefined;
}

export function mergeTelemetryAttribution(
  base?: Partial<TelemetryAttribution> | null,
  incoming?: Partial<TelemetryAttribution> | null,
): TelemetryAttribution | undefined {
  const merged = sanitizeTelemetryAttribution({
    ...(base ?? {}),
    ...(incoming ?? {}),
  });
  return merged;
}

export function mergeTelemetryProperties(
  properties?: Record<string, unknown>,
  attribution?: Partial<TelemetryAttribution> | null,
): Record<string, unknown> | undefined {
  const cleanedAttribution = sanitizeTelemetryAttribution(attribution);
  if (!cleanedAttribution) return properties;
  return {
    ...cleanedAttribution,
    ...(properties ?? {}),
  };
}

export function decodeTelemetryAttribution(value: string | undefined): TelemetryAttribution | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return sanitizeTelemetryAttribution(JSON.parse(decoded) as Partial<Record<TelemetryAttributionKey, unknown>>);
  } catch {
    return undefined;
  }
}
