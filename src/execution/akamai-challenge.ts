/**
 * Akamai Bot Manager challenge bundle detection + retry helpers
 * (plan-v15 Tier 2A seed — Step 3 Land).
 *
 * Mirrors `cf-challenge.ts` field-for-field. Akamai's equivalent of
 * `cf_clearance` is the `_abck` cookie set by the sensor-data bundle once
 * it posts a valid sensor payload back to the protected origin.
 *
 * Land step ships:
 *   - `extractAkamaiBundleUrl` — REAL regex over a few known Akamai script
 *     conventions (akamaihd.net CDN, generic `akam` substring, `/akam-<hex>.js`).
 *   - `solveAkamaiAndRetry` — STUB. Signature is final; body returns `null`
 *     until Step 6 Dominion wires bundle fetch + `runBundleReplay` + retry.
 *
 * Step 4 Luminaries adds tests; Step 5 Creatures chases the JS-sensor-gen
 * fallback (Akamai sometimes ships sensor data via inline obfuscated script
 * rather than a separately-fetched bundle); Step 6 Dominion wires the call.
 */

import { runBundleReplay, type SeedCookie } from "../sandbox/bundle-replay-client.js";

// ---------------------------------------------------------------------------
// extractAkamaiBundleUrl
// ---------------------------------------------------------------------------

// Akamai sensor bundle paths come in a few conventions across protected sites:
//   - `<script src="/akam-<hex>.js">` (per-site rotated path)
//   - `<script src="https://*.akamaihd.net/.../sensor.js">` (legacy CDN-served)
//   - Generic `<script src="...akam...js">` catch-all for sites that proxy
//     the sensor under their own path containing the `akam` substring.
// `src=` prefix gate (mirrors CF) prunes false positives in HTML comments,
// JSON-encoded payloads, and other non-script contexts.
const AKAMAI_BUNDLE_REGEXES: RegExp[] = [
  // domain-specific (akamaihd.net CDN) — most reliable, runs first
  /src=["']([^"']*\.akamaihd\.net[^"']*\.js)["']/i,
  // path-anchored akam-<token>.js (Step 5 fix: alphanumeric+symbol token, was hex-only and shadowed by broader regex)
  /src=["']([^"']*\/akam-[a-z0-9._-]+\.js)["']/i,
];
/**
 * Extract the absolute URL of an Akamai sensor-data bundle from a challenge
 * response body. Returns `null` if no recognizable bundle reference is found.
 *
 * `requestUrl` (optional) is the URL whose response is `html` — used to
 * resolve relative paths. If omitted, only absolute URLs round-trip.
 */
export function extractAkamaiBundleUrl(
  html: string,
  requestUrl?: string,
): string | null {
  if (!html || typeof html !== "string") return null;
  for (const re of AKAMAI_BUNDLE_REGEXES) {
    const match = html.match(re);
    if (!match) continue;
    const path = match[1] ?? match[0];
    try {
      return requestUrl
        ? new URL(path, requestUrl).toString()
        : new URL(path).toString();
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// solveAkamaiAndRetry — STUB until Step 6 Dominion
// ---------------------------------------------------------------------------

export interface SolveAkamaiRetryInput {
  url: string;
  body: string;
  cookies?: SeedCookie[];
  kuriBase?: string;
  proxy?: string;
  timeoutMs?: number;
}

export interface SolveAkamaiRetryResult {
  status: number;
  html: string;
  cookies: SeedCookie[];
}

/**
 * Solve an Akamai Bot Manager challenge and retry the original request with
 * the resulting `_abck` cookie.
 *
 * Planned flow (Step 6 Dominion will wire this):
 *   1. extractAkamaiBundleUrl(body, url) → bundleUrl
 *   2. fetch(bundleUrl) → sensor bundle source
 *   3. runBundleReplay({ bundleSource, seedCookies, ... }) → solved cookies
 *      (must include `_abck` — Akamai's clearance cookie)
 *   4. globalThis.fetch(url, { headers: { cookie: <merged> } }) → final HTML
 *
 * Returns null on any failure path; caller falls through to vendor_blocked.
 *
 * Currently stubbed: performs the bundle URL extraction + fetch sanity gate
 * so callers can wire the call site without behavior change, then returns null.
 */
export async function solveAkamaiAndRetry(
  input: SolveAkamaiRetryInput,
): Promise<SolveAkamaiRetryResult | null> {
  const bundleUrl = extractAkamaiBundleUrl(input.body, input.url);
  if (!bundleUrl) return null;

  // Bundle fetch sanity gate (mirrors CF 1024-byte minimum).
  let bundleSource: string;
  try {
    const bundleResp = await globalThis.fetch(bundleUrl, { method: "GET" });
    if (bundleResp.status !== 200) return null;
    bundleSource = await bundleResp.text();
    if (!bundleSource || bundleSource.length < 1024) return null;
  } catch {
    return null;
  }

  let targetOrigin: string;
  try {
    targetOrigin = new URL(input.url).origin;
  } catch {
    return null;
  }

  // TODO Step 6 Dominion: wire real call.
  // Reference signature for when the stub is removed:
  //   const replay = await runBundleReplay(
  //     {
  //       targetOrigin,
  //       targetHref: input.url,
  //       bundleSource,
  //       seedCookies: input.cookies ?? [],
  //       timeoutMs: input.timeoutMs ?? 15_000,
  //       ...(input.proxy ? { proxy: input.proxy } : {}),
  //     },
  //     { kuriBase: input.kuriBase },
  //   );
  //   const hasAbck = replay?.cookies?.some((c) => c.name === "_abck") ?? false;
  //   if (!hasAbck) return null;
  //   ... merge + retry as in CF ...
  void runBundleReplay;
  void targetOrigin;
  void bundleSource;
  void mergeCookieJar;
  return null;
}

/**
 * Merge two cookie jars; entries from `b` override `a` on `name` collision.
 * Kept private and ready for Step 6 wiring.
 */
function mergeCookieJar(a: SeedCookie[], b: SeedCookie[]): SeedCookie[] {
  const byName = new Map<string, SeedCookie>();
  for (const c of a) byName.set(c.name, c);
  for (const c of b) byName.set(c.name, c);
  return Array.from(byName.values());
}
