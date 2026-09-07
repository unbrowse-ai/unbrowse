/* Marketplace helpers for worker + browser.
 *
 * Browser: same-origin /api/hero-chat/marketplace (no CORS).
 * Worker: direct beta-api with unbrowse@latest release attestation.
 *
 * Search: marketplace index → domain-filtered → /v1/search/resolve → cold seed.
 */

import { releaseAttestationHeaders } from "./unbrowse-release-attestation";

export interface SearchRow {
  skill_id: string;
  endpoint_id: string;
  domain: string;
  title: string;
  score: number;
  url?: string;
  source?: "marketplace" | "resolve" | "web";
}

export function domainHintFromIntent(intent: string): string | null {
  const t = intent.toLowerCase();
  const host = t.match(/\b([a-z0-9-]+\.(?:com|org|net|io|co|ai|gov|edu)(?:\.[a-z]{2})?)\b/);
  if (host?.[1]) return host[1].replace(/^www\./, "");
  const MAP: Record<string, string> = {
    zillow: "zillow.com",
    trulia: "trulia.com",
    redfin: "redfin.com",
    realtor: "realtor.com",
    airbnb: "airbnb.com",
    "hacker news": "news.ycombinator.com",
    hackernews: "news.ycombinator.com",
    amazon: "amazon.com",
    ebay: "ebay.com",
    github: "github.com",
    reddit: "reddit.com",
  };
  for (const [name, domain] of Object.entries(MAP)) {
    if (t.includes(name)) return domain;
  }
  return null;
}

function marketplaceHeaders(json = true): Record<string, string> {
  const h: Record<string, string> = { ...releaseAttestationHeaders() };
  if (json) h["content-type"] = "application/json";
  else h.accept = "application/json";
  return h;
}

function rowsFromSearchResults(
  results: { id?: string; score?: number; metadata?: Record<string, unknown> }[] | undefined,
  source: SearchRow["source"] = "marketplace",
): SearchRow[] {
  return (results ?? []).slice(0, 8).map((r) => {
    const m = r.metadata ?? {};
    let inner: Record<string, unknown> = {};
    try {
      inner = JSON.parse(String(m.content ?? "{}"));
    } catch {
      /* not json */
    }
    return {
      skill_id: String(inner.skill_id ?? (r.id ?? "").split(":")[0] ?? ""),
      endpoint_id: String(inner.endpoint_id ?? (r.id ?? "").split(":")[1] ?? ""),
      domain: String(inner.domain ?? m.source_url ?? "").replace(/^www\./, ""),
      title: String(m.title ?? inner.name ?? ""),
      score: Number((r.score ?? 0).toFixed(3)),
      source,
    };
  });
}

function domainMatches(rowDomain: string, hint: string): boolean {
  const d = rowDomain.toLowerCase().replace(/^www\./, "");
  const h = hint.toLowerCase().replace(/^www\./, "");
  const stem = h.split(".")[0] ?? h;
  return d === h || d.endsWith(`.${h}`) || h.endsWith(`.${d}`) || d.includes(stem);
}

async function resolveSearch(
  apiOrigin: string,
  intent: string,
  timeoutMs: number,
  domainHint: string | null,
): Promise<{ rows: SearchRow[]; note?: string }> {
  const body: Record<string, unknown> = { intent: intent.slice(0, 300) };
  if (domainHint) body.domain = domainHint;

  const res = await fetch(`${apiOrigin}/v1/search/resolve`, {
    method: "POST",
    headers: marketplaceHeaders(true),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { rows: [], note: `resolve HTTP ${res.status}` };

  const data = (await res.json()) as {
    domain_results?: { id?: string; score?: number; metadata?: Record<string, unknown> }[];
    global_results?: { id?: string; score?: number; metadata?: Record<string, unknown> }[];
    exa_results?: { url?: string; title?: string; score?: number }[];
    confidence?: { recommended_action?: string };
  };

  let market = [
    ...rowsFromSearchResults(data.domain_results, "resolve"),
    ...rowsFromSearchResults(data.global_results, "resolve"),
  ];
  if (domainHint) market = market.filter((r) => r.domain && domainMatches(r.domain, domainHint));
  market = market.slice(0, 6);
  if (market.length) return { rows: market };

  let web: SearchRow[] = (data.exa_results ?? [])
    .filter((r) => typeof r.url === "string" && r.url.startsWith("https://"))
    .map((r) => {
      let domain = "";
      try {
        domain = new URL(String(r.url)).hostname.replace(/^www\./, "");
      } catch {
        domain = "";
      }
      return {
        skill_id: "",
        endpoint_id: "",
        domain,
        title: String(r.title ?? r.url ?? ""),
        score: Number((r.score ?? 0).toFixed(3)),
        url: String(r.url),
        source: "web" as const,
      };
    });
  if (domainHint) {
    const pinned = web.filter((r) => r.domain && domainMatches(r.domain, domainHint));
    if (pinned.length) web = pinned;
  }
  web = web.slice(0, 6);
  if (web.length) {
    return {
      rows: web,
      note: "no marketplace skill — web candidates for cold-path execute_route (pass url)",
    };
  }
  return {
    rows: [],
    note: data.confidence?.recommended_action
      ? `resolve empty (recommend: ${data.confidence.recommended_action})`
      : "resolve empty",
  };
}

/** Direct beta-api search (worker / Node only). Exported for the marketplace proxy. */
export async function searchRoutesDirect(
  apiOrigin: string,
  intent: string,
  timeoutMs = 14000,
): Promise<{ output: string; ok: boolean }> {
  const q = intent.slice(0, 300);
  const domainHint = domainHintFromIntent(q);
  try {
    const res = await fetch(`${apiOrigin}/v1/search`, {
      method: "POST",
      headers: marketplaceHeaders(true),
      body: JSON.stringify({ intent: q, k: 8 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        results?: { id?: string; score?: number; metadata?: Record<string, unknown> }[];
      };
      let rows = rowsFromSearchResults(data.results, "marketplace");
      if (domainHint) {
        const pinned = rows.filter((r) => r.domain && domainMatches(r.domain, domainHint));
        rows = pinned; // drop off-domain noise (github for "zillow", etc.)
      }
      if (rows.length) return { output: JSON.stringify(rows), ok: true };
    }

    const resolved = await resolveSearch(apiOrigin, q, timeoutMs, domainHint);
    if (resolved.rows.length) {
      return {
        output: JSON.stringify(
          resolved.note ? { results: resolved.rows, note: resolved.note } : resolved.rows,
        ),
        ok: true,
      };
    }

    if (domainHint === "zillow.com") {
      return {
        output: JSON.stringify({
          results: [
            {
              skill_id: "",
              endpoint_id: "",
              domain: "zillow.com",
              title: "Zillow homes for sale",
              score: 1,
              url: "https://www.zillow.com/homes/for_sale/",
              source: "web",
            },
          ],
          note: "marketplace miss — cold-path seed. execute_route with the url (client-first uses the user browser).",
        }),
        ok: true,
      };
    }

    return {
      output: JSON.stringify({
        results: [],
        note: resolved.note ?? "no captured routes matched this intent",
      }),
      ok: true,
    };
  } catch (e) {
    return { output: `search failed: ${e instanceof Error ? e.message : String(e)}`, ok: false };
  }
}

export async function getRouteDirect(
  apiOrigin: string,
  skillId: string,
  timeoutMs = 12000,
): Promise<{ output: string; ok: boolean; domain: string }> {
  const id = encodeURIComponent(skillId);
  try {
    const res = await fetch(`${apiOrigin}/v1/skills/${id}`, {
      headers: marketplaceHeaders(false),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 402) return { output: "this skill is payment-gated for anonymous calls", ok: false, domain: skillId };
    if (!res.ok) return { output: `manifest fetch failed: HTTP ${res.status}`, ok: false, domain: skillId };
    const skill = (await res.json()) as Record<string, unknown>;
    const endpoints = (Array.isArray(skill.endpoints) ? skill.endpoints : []).slice(0, 10).map((e) => {
      const ep = e as Record<string, unknown>;
      return {
        endpoint_id: ep.endpoint_id ?? ep.id,
        method: ep.method,
        url: ep.url ?? ep.url_template ?? ep.path,
        description: ep.description ?? ep.intent ?? "",
        headers: ep.headers ?? ep.headers_template ?? undefined,
        query: ep.query ?? undefined,
        params: ep.params ?? ep.query_params ?? undefined,
      };
    });
    return {
      output: JSON.stringify({ skill_id: skill.skill_id, domain: skill.domain, endpoints }),
      ok: true,
      domain: String(skill.domain ?? skillId),
    };
  } catch (e) {
    return { output: `manifest fetch failed: ${e instanceof Error ? e.message : String(e)}`, ok: false, domain: skillId };
  }
}

export async function searchRoutes(apiOrigin: string, intent: string, timeoutMs = 9000): Promise<{ output: string; ok: boolean }> {
  if (typeof window !== "undefined") {
    try {
      const res = await fetch("/api/hero-chat/marketplace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "search", intent }),
        signal: AbortSignal.timeout(Math.max(timeoutMs, 16000)),
      });
      if (!res.ok) {
        const errText = (await res.text().catch(() => "")).slice(0, 200);
        return { output: `search failed: proxy HTTP ${res.status} ${errText}`, ok: false };
      }
      const data = (await res.json()) as { output?: string; ok?: boolean };
      return { output: data.output ?? "search failed", ok: !!data.ok };
    } catch (e) {
      const direct = await searchRoutesDirect(apiOrigin, intent, timeoutMs);
      if (direct.ok) return direct;
      return { output: `search failed: ${e instanceof Error ? e.message : String(e)}`, ok: false };
    }
  }
  return searchRoutesDirect(apiOrigin, intent, timeoutMs);
}

export async function getRoute(apiOrigin: string, skillId: string, timeoutMs = 9000): Promise<{ output: string; ok: boolean; domain: string }> {
  if (typeof window !== "undefined") {
    try {
      const res = await fetch("/api/hero-chat/marketplace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "get", skill_id: skillId }),
        signal: AbortSignal.timeout(Math.max(timeoutMs, 14000)),
      });
      if (!res.ok) return { output: `manifest fetch failed: proxy HTTP ${res.status}`, ok: false, domain: skillId };
      const data = (await res.json()) as { output?: string; ok?: boolean; domain?: string };
      return { output: data.output ?? "manifest fetch failed", ok: !!data.ok, domain: data.domain ?? skillId };
    } catch (e) {
      const direct = await getRouteDirect(apiOrigin, skillId, timeoutMs);
      if (direct.ok) return direct;
      return { output: `manifest fetch failed: ${e instanceof Error ? e.message : String(e)}`, ok: false, domain: skillId };
    }
  }
  return getRouteDirect(apiOrigin, skillId, timeoutMs);
}
