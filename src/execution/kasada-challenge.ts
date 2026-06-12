/**
 * Kasada challenge sensor solver (plan-v15 Tier 2C, Step 3 Land seed).
 *
 * Mirrors src/execution/px-challenge.ts. Kasada injects a sensor script
 * (commonly /ips.js or /x/{TOKEN}/p.js) whose execution sets x-kpsdk-cd /
 * x-kpsdk-ct cookies. Both required to satisfy the armed-retry gate.
 *
 * REALITY NOTE: PerimeterX is bundle-replay-OK (init.js is a self-contained
 * VM-friendly init). Kasada empirically requires live JS sensor execution
 * with a real DOM + crypto.subtle + canvas/webgl fingerprints. The
 * runBundleReplay hook below is a placeholder; Step 5 Spear will likely
 * have to swap it for a Kuri-CDP-driven `kuri.evaluateInPage` approach.
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
 * STUB: Step 3 Land returns null. Step 6 Dominion wires the switch arm
 * and Step 5 Spear ships the real sensor execution path.
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

  // TODO Step 6 Dominion: wire runBundleReplay switch arm for Kasada.
  // TODO Step 5 Spear: bundle-replay likely insufficient for Kasada — swap
  // for kuri.evaluateInPage sensor execution since Kasada needs a live DOM
  // + crypto.subtle + canvas/webgl context that bundle-replay-client cannot
  // provide. Hook left in place so the Dominion switch can route here
  // without further surgery. Default timeoutMs 30_000 — Kasada sensors are
  // slower than CF and comparable to PX.
  void runBundleReplay;
  void targetOrigin;
  void bundleSource;
  void mergeCookieJar;
  const _defaultTimeoutMs = input.timeoutMs ?? 30_000;
  void _defaultTimeoutMs;
  return null;

  // Reference flow (commented for Step 5 Spear) — mirrors PX shape:
  //
  //   const replay = await runBundleReplay({ targetOrigin, targetHref: input.url,
  //     bundleSource, seedCookies: input.cookies ?? [],
  //     timeoutMs: _defaultTimeoutMs,
  //     ...(input.proxy ? { proxy: input.proxy } : {}) },
  //     { kuriBase: input.kuriBase });
  //   const solved = (replay?.cookies ?? []).map(...);
  //   const hasCd = solved.some((c) => c.name.toLowerCase() === "x-kpsdk-cd");
  //   const hasCt = solved.some((c) => c.name.toLowerCase() === "x-kpsdk-ct");
  //   if (!hasCd || !hasCt) return null;
  //   const merged = mergeCookieJar(input.cookies ?? [], solved);
  //   const cookieHeader = merged.map((c) => `${c.name}=${c.value}`).join("; ");
  //   const retry = await globalThis.fetch(input.url, { method: "GET",
  //     headers: cookieHeader ? { cookie: cookieHeader } : {} });
  //   if (retry.status < 200 || retry.status >= 400) return null;
  //   return { status: retry.status, html: await retry.text(), cookies: merged };
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
