/**
 * Cloudflare challenge bundle detection + retry helpers (plan-v13 Tier 2A seed).
 *
 * This module exposes the minimal surface needed by the executor to (eventually)
 * solve a Cloudflare JS challenge ("jsd" bundle) and retry the original request
 * with the resulting clearance cookies. The Land step (plan-v13 Day 3) ships:
 *
 *   - `extractCfBundleUrl` — REAL implementation. Parses the challenge HTML
 *     for the `/cdn-cgi/challenge-platform/h/{g,b}/scripts/jsd/<hash>/main.js`
 *     script reference and returns it absolute to `requestUrl`. Rejects sibling
 *     CDN paths (`/cdn-cgi/scripts/email-decode/...` etc.) that are NOT the
 *     challenge runtime.
 *   - `solveCfAndRetry` — STUB. Signature is final; body returns `null` until
 *     plan-v13 step 6 wires bundle fetch + `runBundleReplay` + armed serverFetch.
 *
 * See plan-v13 §"Detection helper" and §"Step 6 — wiring".
 */

import { runBundleReplay, type SeedCookie } from "../sandbox/bundle-replay-client.js";

// ---------------------------------------------------------------------------
// extractCfBundleUrl
// ---------------------------------------------------------------------------

// The challenge bundle path Cloudflare serves for JS challenges. The `[gb]`
// segment is either `g` (general) or `b` (bot management); the hash is a
// hex blob identifying the bundle version. Only this exact shape counts —
// `/cdn-cgi/scripts/email-decode/...` and other `/cdn-cgi/...` assets are
// NOT challenge runtimes and must be rejected.
const CF_BUNDLE_RE =
  /\/cdn-cgi\/challenge-platform\/h\/[gb]\/scripts\/jsd\/[a-f0-9]+\/main\.js/i;

/**
 * Extract the absolute URL of the Cloudflare JS challenge bundle from a
 * challenge response body. Returns `null` if the body does not contain a
 * recognizable challenge bundle reference.
 *
 * `requestUrl` is the URL whose response is `body` — used to resolve
 * relative paths.
 */
export function extractCfBundleUrl(
  body: string,
  requestUrl: string,
): string | null {
  if (!body || typeof body !== "string") return null;
  const match = body.match(CF_BUNDLE_RE);
  if (!match) return null;
  const path = match[0];
  try {
    return new URL(path, requestUrl).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// solveCfAndRetry — STUB until plan-v13 step 6
// ---------------------------------------------------------------------------

export interface SolveCfRetryInput {
  url: string;
  body: string;
  cookies?: SeedCookie[];
  kuriBase?: string;
  proxy?: string;
  timeoutMs?: number;
}

export interface SolveCfRetryResult {
  status: number;
  html: string;
  cookies: SeedCookie[];
}

/**
 * Solve a Cloudflare JS challenge and retry the original request with the
 * resulting clearance cookies.
 *
 * Flow:
 *   1. extractCfBundleUrl(body, url) → bundleUrl
 *   2. fetch(bundleUrl) → bundle source (public CF asset, plain fetch is fine)
 *   3. runBundleReplay({ bundleSource, seedCookies, ... }) → solved cookies
 *   4. globalThis.fetch(url, { headers: { cookie: <merged> } }) → final HTML
 *
 * Returns null on any failure path; caller falls through to vendor_blocked.
 *
 * Note on retry transport: `serverFetch` in src/execution/index.ts is a local
 * closure (not exported). Using `globalThis.fetch` keeps this module
 * dependency-free and avoids a circular import. The cookie jar is reconstructed
 * via a `Cookie:` header.
 */
export async function solveCfAndRetry(
  input: SolveCfRetryInput,
): Promise<SolveCfRetryResult | null> {
  // 1. Extract the challenge bundle URL from the response body.
  const bundleUrl = extractCfBundleUrl(input.body, input.url);
  if (!bundleUrl) return null;

  // 2. Fetch the bundle source. Public CF asset, no auth needed.
  let bundleSource: string;
  try {
    const bundleResp = await globalThis.fetch(bundleUrl, {
      method: "GET",
      // Proxy is only honored by the sandbox runtime; bundle fetch goes direct.
    });
    if (bundleResp.status !== 200) return null;
    bundleSource = await bundleResp.text();
    if (!bundleSource || bundleSource.length < 1024) return null;
  } catch {
    return null;
  }

  // 3. Run the bundle in the Kuri sandbox to obtain cf_clearance.
  let targetOrigin: string;
  try {
    targetOrigin = new URL(input.url).origin;
  } catch {
    return null;
  }

  let solvedCookies: SeedCookie[] = [];
  try {
    const replay = await runBundleReplay(
      {
        targetOrigin,
        targetHref: input.url,
        bundleSource,
        seedCookies: input.cookies ?? [],
        timeoutMs: input.timeoutMs ?? 15_000,
        ...(input.proxy ? { proxy: input.proxy } : {}),
      },
      { kuriBase: input.kuriBase },
    );
    if (!replay || !Array.isArray(replay.cookies) || replay.cookies.length === 0) {
      return null;
    }
    solvedCookies = replay.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      http_only: c.http_only,
      same_site: c.same_site,
      expires: c.expires,
    }));
  } catch {
    return null;
  }

  // 4. Verify cf_clearance is present — otherwise the challenge didn't solve.
  const hasClearance = solvedCookies.some((c) => c.name === "cf_clearance");
  if (!hasClearance) return null;

  // 5. Merge seed cookies with solved cookies (solved wins on name collision)
  // and retry the original URL.
  const merged = mergeCookieJar(input.cookies ?? [], solvedCookies);
  const cookieHeader = merged
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  try {
    const retry = await globalThis.fetch(input.url, {
      method: "GET",
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    // Anything 4xx/5xx is treated as still-blocked; caller handles fallthrough.
    if (retry.status < 200 || retry.status >= 400) return null;
    const html = await retry.text();
    return {
      status: retry.status,
      html,
      cookies: merged,
    };
  } catch {
    return null;
  }
}

/**
 * Merge two cookie jars; entries from `b` override `a` on `name` collision.
 */
function mergeCookieJar(a: SeedCookie[], b: SeedCookie[]): SeedCookie[] {
  const byName = new Map<string, SeedCookie>();
  for (const c of a) byName.set(c.name, c);
  for (const c of b) byName.set(c.name, c);
  return Array.from(byName.values());
}
