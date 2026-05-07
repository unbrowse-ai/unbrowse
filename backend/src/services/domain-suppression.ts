import type { Env } from "../types.js";

const EMERGENCY_SUPPRESSED_DOMAINS = [
  "pearlpediatric.curvehero.com",
];

function normalizeDomain(value: string): string {
  let domain = value.trim().toLowerCase();
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    try {
      domain = new URL(domain).hostname.toLowerCase();
    } catch {
      domain = domain.replace(/^https?:\/\//, "");
    }
  }
  return domain.split("/")[0]?.replace(/:\d+$/, "").replace(/^www\./, "") ?? "";
}

function configuredSuppressedDomains(env: Env): string[] {
  const raw = (env as unknown as { SUPPRESSED_MARKETPLACE_DOMAINS?: string }).SUPPRESSED_MARKETPLACE_DOMAINS;
  return raw?.split(",").map(normalizeDomain).filter(Boolean) ?? [];
}

export function isMarketplaceDomainSuppressed(env: Env, domain?: string | null): boolean {
  const normalized = normalizeDomain(domain ?? "");
  if (!normalized) return false;
  const suppressed = new Set([
    ...EMERGENCY_SUPPRESSED_DOMAINS,
    ...configuredSuppressedDomains(env),
  ]);
  for (const rule of suppressed) {
    if (normalized === rule || normalized.endsWith(`.${rule}`)) return true;
  }
  return false;
}

export function filterSuppressedDomains<T extends { domain?: string | null }>(env: Env, items: T[]): T[] {
  return items.filter((item) => !isMarketplaceDomainSuppressed(env, item.domain));
}
