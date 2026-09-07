/**
 * Structural URL-shape signals for "this path is probably a JSON API leaf".
 *
 * Path/host *shape* only — never a host allowlist (CLAUDE.md: zero new
 * per-site entries). Used by free direct-JSON fetch and public-API endpoint
 * derivation so new sites are recognized for free.
 *
 * Matches:
 *  - `*.json` / `*.geojson` leaves
 *  - `/api/` path segments (REST)
 *  - versioned REST `/v1|v2|…/` with resource-like depth (e.g. /v5/launches/latest)
 *  - `api.*` / `*.api.*` host with a non-root resource path (structural subdomain)
 *  - REST resource leaf `/{collection}/{numeric|uuid}` (jsonplaceholder-class free APIs)
 *  - `/graphql` leaves
 */
export function urlLooksLikeJsonApi(url: string): boolean {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (!p || p === "/") return false;
    if (/\.(json|geojson)(?:$|\?)/i.test(p) || p.endsWith(".json") || p.endsWith(".geojson")) {
      return true;
    }
    if (/\/api(\/|$)/.test(p)) return true;
    // /v5/launches/latest, /v1/simple/price — versioned REST with ≥2 segments after vN
    const ver = p.match(/\/v\d+(\/.*)?$/);
    if (ver && (ver[1] ?? "").split("/").filter(Boolean).length >= 2) return true;
    if (/\/graphql\/?$/.test(p)) return true;
    // Structural host shape: api.<domain> or <svc>.api.<domain> with a resource path.
    // Not a host allowlist — any api.* subdomain with depth ≥ 1 is JSON-API-shaped.
    const host = u.hostname.toLowerCase();
    const segs = p.split("/").filter(Boolean);
    if ((host.startsWith("api.") || host.includes(".api.")) && segs.length >= 1) {
      return true;
    }
    // REST resource leaf: /{collection}/{id} where id is numeric or UUID.
    // Catches jsonplaceholder-class free APIs without per-host entries.
    // Skip marketing/www hosts (www./m./blog.) so /rooms/12345 HTML pages do not
    // force a free JSON GET — those remain probe/CT driven.
    const marketingHost =
      host.startsWith("www.") || host.startsWith("m.") || host.startsWith("blog.");
    if (!marketingHost && segs.length >= 2) {
      const leaf = segs[segs.length - 1]!;
      const parent = segs[segs.length - 2]!;
      const numericId = /^\d+$/.test(leaf);
      const uuidId =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leaf);
      if (
        (numericId || uuidId) &&
        /^[a-z][a-z0-9_-]*$/i.test(parent) &&
        !/\.(html?|php|aspx?|jsp)$/i.test(parent)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Normalize path for structural compare (lowercase, strip trailing slash). */
export function normalizeApiPath(url: string): string | null {
  try {
    const p = new URL(url).pathname.toLowerCase().replace(/\/+$/, "");
    return p || null;
  } catch {
    return null;
  }
}

/**
 * True when candidate is a JSON-API-shaped URL whose resource path is
 * compatible with the requested leaf — same path, or matching last 2–3
 * segments (people/1, v5/launches/latest). No host allowlist.
 */
export function jsonApiPathCompatible(requested: string, candidate: string): boolean {
  if (!urlLooksLikeJsonApi(candidate)) return false;
  const a = normalizeApiPath(requested);
  const b = normalizeApiPath(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const as = a.split("/").filter(Boolean);
  const bs = b.split("/").filter(Boolean);
  if (as.length >= 2 && bs.length >= 2) {
    const n = Math.min(as.length, bs.length, 3);
    return as.slice(-n).join("/") === bs.slice(-n).join("/");
  }
  return false;
}

/**
 * Free residual recovery for origin-down JSON APIs: from web-search hits,
 * build candidate URLs that either (1) already carry a path-compatible
 * JSON-API leaf, or (2) are off-origin hosts where we transplant the
 * requested path (structural mirror discovery — not a host allowlist).
 *
 * Bounded, de-duplicated. Caller tryDirectJsonFetch each; non-JSON fails closed.
 */
export function structuralJsonApiMirrorUrls(
  requested: string,
  hits: ReadonlyArray<{ url: string }>,
  max = 5,
): string[] {
  if (!urlLooksLikeJsonApi(requested)) return [];
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return [];
  }
  const reqReg = req.hostname.toLowerCase().replace(/^www\./, "");
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    const key = u.replace(/\/+$/, "");
    if (seen.has(key)) return;
    if (!urlLooksLikeJsonApi(u)) return;
    seen.add(key);
    out.push(u);
  };

  for (const h of hits) {
    if (!h?.url || out.length >= max) break;
    let cand: URL;
    try {
      cand = new URL(h.url);
    } catch {
      continue;
    }
    // Same-origin already failed in the early path — skip exact host match.
    const candHost = cand.hostname.toLowerCase().replace(/^www\./, "");
    if (candHost === reqReg) {
      // Only keep if path differs (unlikely win) and is still JSON-API.
      if (jsonApiPathCompatible(requested, h.url) && normalizeApiPath(h.url) !== normalizeApiPath(requested)) {
        push(h.url);
      }
      continue;
    }
    if (jsonApiPathCompatible(requested, h.url)) {
      push(h.url);
    }
    // Path transplant onto off-origin hit: https://mirror.example + /api/people/1/
    try {
      const transplanted = new URL(req.pathname + req.search, cand.origin).href;
      if (transplanted.replace(/\/+$/, "") !== requested.replace(/\/+$/, "")) {
        push(transplanted);
      }
    } catch {
      /* ignore */
    }
  }
  return out.slice(0, max);
}
