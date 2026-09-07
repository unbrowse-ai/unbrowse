/**
 * Kasada challenge sensor solver (plan-v15 Tier 2C).
 *
 * Mirrors src/execution/px-challenge.ts. Kasada injects a sensor script
 * (commonly /ips.js or /x/{TOKEN}/p.js) whose execution sets x-kpsdk-cd /
 * x-kpsdk-ct cookies. Both required to satisfy the armed-retry gate.
 *
 * Uses bundle-replay to execute the sensor in the Kuri sandbox. If the
 * sensor requires live DOM fingerprints that bundle-replay cannot provide,
 * the solver gracefully returns null and the caller falls through to
 * browser-based capture.
 */

import { runBundleReplay, type SeedCookie } from "../sandbox/bundle-replay-client.js";

// Known Kasada sensor path shapes.
//   /ips.js                       — legacy entry
//   /x/{TOKEN}/p.js               — modern per-tenant sensor
//   *kasada*.js                   — explicit vendor-named build
const KASADA_BUNDLE_RE = new RegExp(
  `<script\\b[^>]*\\bsrc=["']([^"']*(?:kasada[^"']*\\.js|/ips\\.js|/x/[a-zA-Z0-9_]+/p\\.js))["']`,
  "i",
);

export function extractKasadaBundleUrl(html: string, requestUrl?: string): string | null {
  if (!html || typeof html !== "string") return null;
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  const m = stripped.match(KASADA_BUNDLE_RE);
  if (!m) return null;
  const path = m[1];
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!requestUrl) return path;
  try {
    return new URL(path, requestUrl).toString();
  } catch {
    return null;
  }
}

export interface SolveKasadaRetryInput {
  url: string;
  body: string;
  cookies?: SeedCookie[];
  kuriBase?: string;
  proxy?: string;
  timeoutMs?: number;
  /** Optional response headers from the gating request — Kasada often surfaces x-kpsdk-block. */
  responseHeaders?: Record<string, string>;
}

export interface SolveKasadaRetryResult {
  status: number;
  html: string;
  cookies: SeedCookie[];
}

/**
 * Solve a Kasada challenge and retry the original request with armed
 * x-kpsdk-cd + x-kpsdk-ct cookies. Mirrors solvePxAndRetry.
 *
 * Bundle-replay path: extracts the Kasada sensor script URL, fetches it,
 * runs it in the Kuri sandbox via runBundleReplay to obtain the
 * x-kpsdk-cd + x-kpsdk-ct cookies, then retries the original request
 * with the armed cookie jar. Both cookies required (AND not OR).
 *
 * NOTE: Kasada sensors may require live DOM + crypto.subtle + canvas/webgl
 * fingerprints that bundle-replay cannot provide. If bundle-replay fails
 * to produce both cookies, the solver returns null and the caller falls
 * through to browser-based capture. This is the same graceful-degrade
 * pattern used by cf-challenge.ts and px-challenge.ts.
 */
export async function solveKasadaAndRetry(
  input: SolveKasadaRetryInput,
): Promise<SolveKasadaRetryResult | null> {
  // 1. Self-verify gate: confirm input shape + Kasada signatures.
  if (!input || typeof input.url !== "string" || input.url.length === 0) {
    return null;
  }
  const body = typeof input.body === "string" ? input.body : "";
  const headers = input.responseHeaders ?? {};
  const hasKpsdkBlockHeader = Object.keys(headers).some(
    (k) => k.toLowerCase() === "x-kpsdk-block",
  );
  const isKasadaBody = body.length > 0 && (
    /kpsdk/i.test(body) ||
    /\/x\/[a-zA-Z0-9_]+\/p\.js/i.test(body) ||
    /\/ips\.js/i.test(body) ||
    KASADA_BUNDLE_RE.test(body)
  );
  const hasKasadaCookie = Array.isArray(input.cookies)
    ? input.cookies.some(
        (c) => c && typeof c.name === "string" && /^x-kpsdk-(cd|ct)$/i.test(c.name),
      )
    : false;
  // some Kasada tenants emit x-kpsdk-cd/ct as plain response headers (not Set-Cookie); accept either path
  const hasKpsdkHeaderToken = Object.keys(headers).some(
    (k) => /^x-kpsdk-(cd|ct)$/i.test(k),
  );
  if (!isKasadaBody && !hasKasadaCookie && !hasKpsdkBlockHeader && !hasKpsdkHeaderToken) {
    return null;
  }

  // 2. Extract the Kasada sensor URL from the response body.
  const bundleUrl = extractKasadaBundleUrl(input.body, input.url);
  if (!bundleUrl) return null;

  // 3. Fetch the sensor source. Public Kasada asset, no auth needed.
  let bundleSource: string;
  try {
    const bundleResp = await globalThis.fetch(bundleUrl, { method: "GET" });
    if (bundleResp.status !== 200) return null;
    bundleSource = await bundleResp.text();
    if (!bundleSource || bundleSource.length < 1024) return null;
  } catch {
    return null;
  }

  // 4. Run the sensor in the Kuri sandbox to obtain x-kpsdk-cd + x-kpsdk-ct.
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
        timeoutMs: input.timeoutMs ?? 30_000,
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

  // 5. Cookie gate: BOTH x-kpsdk-cd AND x-kpsdk-ct required (AND not OR).
  const hasCd = solvedCookies.some((c) => c.name.toLowerCase() === "x-kpsdk-cd");
  const hasCt = solvedCookies.some((c) => c.name.toLowerCase() === "x-kpsdk-ct");
  if (!hasCd || !hasCt) return null;

  // 6. Merge seed cookies with solved cookies (solved wins on collision)
  // and retry the original URL with the armed cookie jar.
  const merged = mergeCookieJar(input.cookies ?? [], solvedCookies);
  const cookieHeader = merged.map((c) => `${c.name}=${c.value}`).join("; ");

  try {
    const retry = await globalThis.fetch(input.url, {
      method: "GET",
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    if (retry.status < 200 || retry.status >= 400) return null;
    const html = await retry.text();
    return { status: retry.status, html, cookies: merged };
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
