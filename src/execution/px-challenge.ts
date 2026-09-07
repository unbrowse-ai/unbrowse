/**
 * PerimeterX challenge bundle replay solver (plan-v13 Tier 2B).
 *
 * Mirrors src/execution/cf-challenge.ts. PerimeterX challenge HTML embeds
 * a per-customer init bundle at /{appId}/{appId}/init.js (uuid/uuid/init.js
 * shape per plan-v13 §"Tier 2B"). The bundle, run in Kuri's sandbox via
 * runBundleReplay, sets _pxhd + _px3 cookies. Both required to satisfy the
 * armed-retry gate (single-cookie armed = "_no_cookies_armed").
 */

import { runBundleReplay, type SeedCookie } from "../sandbox/bundle-replay-client.js";

const PX_UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const PX_BUNDLE_RE = new RegExp(
  `<script\\b[^>]*\\bsrc=["']\\/(${PX_UUID})\\/(${PX_UUID})\\/init\\.js`,
  "i",
);

export function extractPxBundleUrl(body: string, requestUrl: string): string | null {
  if (!body || typeof body !== "string") return null;
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "");
  const m = stripped.match(PX_BUNDLE_RE);
  if (!m) return null;
  const path = `/${m[1]}/${m[2]}/init.js`;
  try {
    return new URL(path, requestUrl).toString();
  } catch {
    return null;
  }
}

export interface SolvePxRetryInput {
  url: string;
  body: string;
  cookies?: SeedCookie[];
  kuriBase?: string;
  proxy?: string;
  timeoutMs?: number;
}

export interface SolvePxRetryResult {
  status: number;
  html: string;
  cookies: SeedCookie[];
}

/**
 * Solve a PerimeterX challenge and retry the original request with
 * armed _pxhd + _px3 cookies. Mirrors solveCfAndRetry in cf-challenge.ts.
 */
export async function solvePxAndRetry(input: SolvePxRetryInput): Promise<SolvePxRetryResult | null> {
  // 1. Self-verify gate (sub-agent B): confirm input shape + PX signatures.
  if (!input || typeof input.url !== "string" || input.url.length === 0) {
    return null;
  }
  const body = typeof input.body === "string" ? input.body : "";
  const isPxBody = body.length > 0 && (
    /\b_px(hd|3|vid|sid|Action|AppId)\b/i.test(body) ||
    /px-captcha/i.test(body) ||
    PX_BUNDLE_RE.test(body)
  );
  const hasPxCookie = Array.isArray(input.cookies)
    ? input.cookies.some((c) => c && typeof c.name === "string" && /^_px(hd|3|vid|sid)$/i.test(c.name))
    : false;
  if (!isPxBody && !hasPxCookie) {
    return null;
  }

  // 2. Extract the PX bundle URL from the response body.
  const bundleUrl = extractPxBundleUrl(input.body, input.url);
  if (!bundleUrl) return null;

  // 3. Fetch the bundle source. Public PX asset, no auth needed.
  let bundleSource: string;
  try {
    const bundleResp = await globalThis.fetch(bundleUrl, { method: "GET" });
    if (bundleResp.status !== 200) return null;
    bundleSource = await bundleResp.text();
    if (!bundleSource || bundleSource.length < 1024) return null;
  } catch {
    return null;
  }

  // 4. Run the bundle in the Kuri sandbox to obtain _pxhd + _px3.
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

  // 5. Cookie gate: BOTH _pxhd AND _px3 required (plan-v13 L213, AND not OR).
  const hasPxhd = solvedCookies.some((c) => c.name === "_pxhd");
  const hasPx3 = solvedCookies.some((c) => c.name === "_px3");
  if (!hasPxhd || !hasPx3) return null;

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
