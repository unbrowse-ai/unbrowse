/**
 * Sitemap / robots.txt source for W22 `unbrowse eval spec`.
 *
 * Sitemap.xml IS the URL-graph AST. We parse `<loc>` entries into a
 * tree-by-first-path-segment count so an agent can navigate semantically
 * without crawling. Hard cap at 10K parsed entries — sitemaps for
 * Wikipedia-class sites carry millions and we MUST NOT block on a
 * 200MB XML stream.
 *
 * Always-wrap rule (Pro 25:2): finding sitemap.xml IS searching out the matter.
 */

/** Hard cap on parsed `<loc>` entries. Phil 4:8 — discipline in bounds. */
export const SITEMAP_LOC_CAP = 10_000;

export interface SitemapHit {
  readonly source: "sitemap";
  readonly url: string;
  readonly loc_count: number;
  readonly loc_count_truncated: boolean;
  /** Map of first-path-segment → count of locs under that segment. */
  readonly path_tree: Record<string, number>;
}

/**
 * Cheap streaming-shaped XML loc parser. We don't pull a full XML
 * dependency — we regex out `<loc>...</loc>` tokens. Sitemap.xml is a
 * fixed shape: a flat list of `<url><loc>...</loc>...</url>` entries
 * (or `<sitemapindex>` for index files). Both are loc-shaped at the leaf.
 *
 * Stops parsing after SITEMAP_LOC_CAP matches.
 */
export function parseSitemapXml(xml: string, url: string): SitemapHit {
  const locs: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  let truncated = false;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(xml)) !== null) {
    if (locs.length >= SITEMAP_LOC_CAP) {
      truncated = true;
      break;
    }
    locs.push(m[1].trim());
  }

  const tree: Record<string, number> = {};
  for (const loc of locs) {
    let firstSeg = "/";
    try {
      const u = new URL(loc);
      const parts = u.pathname.split("/").filter(Boolean);
      firstSeg = parts.length > 0 ? `/${parts[0]}/...` : "/";
    } catch {
      firstSeg = "/<unparseable>";
    }
    tree[firstSeg] = (tree[firstSeg] ?? 0) + 1;
  }

  return {
    source: "sitemap",
    url,
    loc_count: locs.length,
    loc_count_truncated: truncated,
    path_tree: tree,
  };
}

async function fetchSameOriginText(
  url: string,
  budgetMs: number,
): Promise<{ text: string; finalUrl: string } | null> {
  const originHost = (() => {
    try { return new URL(url).host; } catch { return ""; }
  })();
  if (!originHost) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    let resp = await fetch(url, {
      method: "GET",
      headers: { accept: "text/xml, application/xml, text/plain" },
      redirect: "manual",
      signal: ctrl.signal,
    });
    let hops = 0;
    let currentUrl = url;
    while (resp.status >= 300 && resp.status < 400 && hops < 3) {
      const loc = resp.headers.get("location");
      if (!loc) break;
      const nextUrl = new URL(loc, currentUrl).toString();
      const nextHost = new URL(nextUrl).host;
      if (nextHost !== originHost) return null; // refuse cross-domain
      currentUrl = nextUrl;
      resp = await fetch(nextUrl, { method: "GET", redirect: "manual", signal: ctrl.signal });
      hops += 1;
    }
    if (resp.status !== 200) return null;
    const text = await resp.text();
    // Soft size cap — read the body fully (fetch already buffered) but
    // refuse to process beyond ~20MB worth of XML to bound regex work.
    if (text.length > 20 * 1024 * 1024) return null;
    return { text, finalUrl: currentUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe a sitemap URL. Returns null on any miss path (timeout / non-200 /
 * cross-domain redirect / unparseable XML).
 */
export async function probeSitemapUrl(
  url: string,
  budgetMs: number,
): Promise<SitemapHit | null> {
  const result = await fetchSameOriginText(url, budgetMs);
  if (!result) return null;
  const hit = parseSitemapXml(result.text, result.finalUrl);
  // If we got zero locs the XML was probably not a sitemap — treat as miss.
  if (hit.loc_count === 0) return null;
  return hit;
}

/**
 * Probe robots.txt + follow any `Sitemap:` directives it advertises.
 * Returns the union of sitemap hits discovered through this path.
 */
export async function probeRobotsForSitemaps(
  robotsUrl: string,
  budgetMs: number,
): Promise<SitemapHit[]> {
  const result = await fetchSameOriginText(robotsUrl, budgetMs);
  if (!result) return [];
  const sitemapLines = result.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^sitemap\s*:/i.test(l))
    .map((l) => l.replace(/^sitemap\s*:\s*/i, "").trim())
    .filter(Boolean);

  // Refuse cross-domain sitemap URLs (same security posture).
  const originHost = (() => {
    try { return new URL(robotsUrl).host; } catch { return ""; }
  })();
  const sameOrigin = sitemapLines.filter((u) => {
    try { return new URL(u).host === originHost; } catch { return false; }
  });

  // Probe each in parallel with its own budget.
  const hits = await Promise.all(
    sameOrigin.map((u) => probeSitemapUrl(u, budgetMs)),
  );
  return hits.filter((h): h is SitemapHit => h !== null);
}
