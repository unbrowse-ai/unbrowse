/**
 * pay-provider — skill-layer helpers for pay.sh-gated routes.
 *
 *   - describePayProvider(): resolve-time label so the agent knows a route is
 *     pay.sh-gated (and at what price) BEFORE paying — honoring the agent rule
 *     "make the smallest useful paid call first, ask before unclear pricing".
 *   - payProviderFromObservation(): derive a PayProviderDescriptor from a 402
 *     observed at execute time, so the route remembers it's paid for next time.
 *   - payShDiscover(): FLAGGED (UNBROWSE_PAY_DISCOVERY=1, default-off) discovery
 *     rung over the pay.sh catalog (`pay skills search <q> --json`). Off by
 *     default; catalog output is treated as untrusted external content.
 */
import { execFile } from "node:child_process";

import type { PayProviderDescriptor } from "../types/skill.js";

/** Human-readable label for a pay.sh-gated route, surfaced in resolve output. */
export function describePayProvider(p: PayProviderDescriptor): string {
  const parts: string[] = ["pay.sh-gated"];
  const meta: string[] = [];
  if (p.protocol) meta.push(p.protocol);
  if (typeof p.price_usd === "number") meta.push(`$${p.price_usd}`);
  if (p.subdomain) meta.push(`via ${p.subdomain}`);
  if (meta.length) parts.push(`(${meta.join(", ")})`);
  parts.push("— pay with UNBROWSE_WALLET_ADAPTER=pay");
  return parts.join(" ");
}

/** Derive a descriptor from a 402 observed at execute time. */
export function payProviderFromObservation(args: {
  url: string;
  amountUsd?: number;
  protocol?: "mpp" | "x402";
  subdomain?: string;
}): PayProviderDescriptor {
  let gateway_url = args.url;
  try {
    const u = new URL(args.url);
    gateway_url = `${u.protocol}//${u.host}`;
  } catch { /* keep raw url */ }
  return {
    gateway_url,
    subdomain: args.subdomain,
    price_usd: args.amountUsd,
    protocol: args.protocol,
    source: "observed",
  };
}

/** UNBROWSE_PAY_DISCOVERY=1|true|yes enables the catalog discovery rung. */
export function payDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.UNBROWSE_PAY_DISCOVERY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export interface PayDiscoveryCandidate {
  method: string;
  url: string;
  description?: string;
  provider: PayProviderDescriptor;
}

interface PaySkillsSearchEntry {
  service?: string;
  title?: string;
  url?: string;
  endpoints?: Array<{
    method?: string;
    url?: string;
    path?: string;
    description?: string;
    resource?: string;
    metered?: boolean;
  }>;
}

/**
 * Discover pay.sh catalog providers for an intent via `pay skills search`.
 * Returns [] when the flag is off, `pay` is absent, the query is empty, or the
 * output is unparseable — never throws, so a resolve caller can fold it in
 * opportunistically. `limit` caps candidates (default 10).
 */
export async function payShDiscover(
  query: string,
  opts: { env?: NodeJS.ProcessEnv; limit?: number; timeoutMs?: number } = {},
): Promise<PayDiscoveryCandidate[]> {
  const env = opts.env ?? process.env;
  if (!payDiscoveryEnabled(env)) return [];
  const q = query.trim();
  if (!q) return [];
  const limit = opts.limit ?? 10;
  const timeout = opts.timeoutMs ?? 8_000;

  const raw = await new Promise<string | null>((resolve) => {
    execFile(
      "pay",
      ["skills", "search", q, "--json"],
      { timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", env },
      (err, stdout) => resolve(err ? null : (stdout ?? "")),
    );
  });
  if (raw == null) return [];

  let parsed: PaySkillsSearchEntry[];
  try {
    const j = JSON.parse(raw.trim() || "[]");
    parsed = Array.isArray(j) ? j : [];
  } catch {
    return [];
  }

  const out: PayDiscoveryCandidate[] = [];
  for (const entry of parsed) {
    const subdomain = typeof entry.service === "string" ? entry.service : undefined;
    let gateway_url: string | undefined = typeof entry.url === "string" ? entry.url : undefined;
    for (const ep of entry.endpoints ?? []) {
      if (out.length >= limit) return out;
      if (typeof ep.url !== "string" || typeof ep.method !== "string") continue;
      out.push({
        method: ep.method.toUpperCase(),
        url: ep.url,
        description: typeof ep.description === "string" ? ep.description : undefined,
        provider: {
          subdomain,
          gateway_url,
          protocol: "x402",
          source: "catalog",
        },
      });
    }
  }
  return out;
}
