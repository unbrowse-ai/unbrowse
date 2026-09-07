import type { Env } from "../types.js";

/**
 * Admin-curated list of domains that only admin keys may publish skills for.
 * High-impact brand and infra domains where a squatter could do real damage
 * via prompt injection in description / annotations or by pre-claiming the
 * skill (the ownership gate freezes the squat in place; this list prevents
 * the squat in the first place).
 *
 * Pre-blast seed: payments, identity, banking, and the high-traffic domains
 * a malicious publisher would target first. Override / extend at runtime via
 * the `RESERVED_DOMAINS` env var (comma-separated).
 *
 * Subdomains are auto-included: reserving `stripe.com` reserves
 * `api.stripe.com`, `dashboard.stripe.com`, etc.
 */
const RESERVED_DOMAIN_SEED = [
  // Payments / financial infra
  "stripe.com",
  "checkout.com",
  "paypal.com",
  "venmo.com",
  "wise.com",
  "plaid.com",

  // Identity / auth
  "auth0.com",
  "okta.com",
  "clerk.com",
  "clerk.dev",

  // Cloud & infra dashboards (privileged actions)
  "console.aws.amazon.com",
  "aws.amazon.com",
  "console.cloud.google.com",
  "portal.azure.com",
  "dashboard.cloudflare.com",
  "vercel.com",
  "netlify.com",
  "render.com",
  "fly.io",
  "supabase.com",
  "neon.tech",

  // Source-of-truth dev infra
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.com",

  // Comms
  "slack.com",
  "discord.com",

  // High-volume social / mail (cookie-replay risk)
  "mail.google.com",
  "calendar.google.com",
  "drive.google.com",
  "x.com",
  "twitter.com",
  "linkedin.com",

  // The unbrowse own domain (don't let anyone publish over us)
  "unbrowse.ai",
];

function normalizeDomain(value: string): string {
  let domain = value.trim().toLowerCase();
  if (!domain) return "";
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    try {
      domain = new URL(domain).hostname.toLowerCase();
    } catch {
      domain = domain.replace(/^https?:\/\//, "");
    }
  }
  return domain.split("/")[0]?.replace(/:\d+$/, "").replace(/^www\./, "") ?? "";
}

function configuredReservedDomains(env: Env): string[] {
  const raw = (env as unknown as { RESERVED_DOMAINS?: string }).RESERVED_DOMAINS;
  return raw?.split(",").map(normalizeDomain).filter(Boolean) ?? [];
}

/** Returns the matched reserved suffix if `domain` is reserved, otherwise null. */
export function matchedReservedDomain(env: Env, domain?: string | null): string | null {
  const normalized = normalizeDomain(domain ?? "");
  if (!normalized) return null;
  const reserved = new Set<string>([
    ...RESERVED_DOMAIN_SEED.map(normalizeDomain),
    ...configuredReservedDomains(env),
  ]);
  for (const suffix of reserved) {
    if (!suffix) continue;
    if (normalized === suffix) return suffix;
    if (normalized.endsWith(`.${suffix}`)) return suffix;
  }
  return null;
}

export function isReservedDomain(env: Env, domain?: string | null): boolean {
  return matchedReservedDomain(env, domain) !== null;
}
