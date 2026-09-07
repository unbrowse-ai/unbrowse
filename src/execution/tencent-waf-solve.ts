/**
 * Tencent Cloud WAF captcha (TCaptcha / TenDI) solver — the gap the 2Captcha
 * hook (captcha-solve.ts) and CapSolver both leave open. rootdata.com and other
 * Tencent-fronted sites serve a `sg.captcha.qcloud.com/Captcha.js` challenge
 * (`new Captcha('<appId>', cb)`) that NONE of the standard solvers cover —
 * confirmed empirically: camoufox stealth gets a 403, CapSolver's API has no
 * Tencent task type.
 *
 * Yoinked primitive: capzy-ai/Tencent-Solver (https://github.com/capzy-ai/Tencent-Solver),
 * a purpose-built TCaptcha solver speaking the standard createTask/getTaskResult
 * protocol and returning the `ticket` + `randstr` the WAF wants. We shell to its
 * HTTP API (no SDK), the same boundary pattern as the curl_cffi / camoufox
 * helpers — no vendored source.
 *
 * The end-to-end clearance flow (mirrors what the page's own Captcha.js does):
 *   1. extractTencentChallenge(html)  → { appId, seqid } from the WAF stub.
 *   2. solveTencentViaCapzy(...)      → { ticket, randstr } from Capzy, minted
 *                                       through the SAME sticky residential proxy
 *                                       so the token's IP matches the replay IP.
 *   3. submitWafClearance(...)        → POST `<ret>\n<ticket>\n<randstr>\n<seqid>`
 *                                       to the site's /WafCaptcha (the exact body
 *                                       Captcha.js builds: captchaResult.join('\n')),
 *                                       harvesting the Set-Cookie clearance.
 * Caller then replays the real request with the clearance cookie + sticky IP.
 *
 * Honest degrade: every function returns null (never a fake token) when the key
 * is absent, the challenge can't be parsed, or Capzy errors — caller falls back
 * to the interactive `unbrowse auth` (one human solve) path.
 */

export interface TencentChallenge {
  /** CaptchaAppId — the `new Captcha('<appId>', ...)` first arg / `websiteKey`. */
  appId: string;
  /** The WAF's per-challenge `seqid` token, echoed back in the clearance POST. */
  seqid: string;
}

/**
 * Parse the Tencent WAF challenge stub. Returns the appId + seqid the solver and
 * the clearance POST both need, or null when the body isn't a Tencent challenge.
 */
export function extractTencentChallenge(html: string): TencentChallenge | null {
  if (!html || typeof html !== "string") return null;
  // appId: `new Captcha('188999876', cb)` (single or double quotes).
  const appMatch = html.match(/new\s+Captcha\(\s*["']([0-9]{5,})["']/);
  // seqid: `var seqid = "....__captcha"` — the WAF's per-request nonce.
  const seqMatch = html.match(/var\s+seqid\s*=\s*["']([^"']+?)["']/);
  if (!appMatch || !seqMatch) return null;
  return { appId: appMatch[1], seqid: seqMatch[1] };
}

export interface CapzyProxy {
  type: "http" | "https" | "socks4" | "socks5";
  address: string;
  port: number;
  login?: string;
  password?: string;
}

export interface TencentSolveResult {
  ticket: string;
  randstr: string;
  appid: string;
}

export interface SolveTencentInput {
  /** The exact page URL where the Tencent widget renders. */
  websiteURL: string;
  /** CaptchaAppId from extractTencentChallenge. */
  appId: string;
  /** Capzy API key (clientKey). From UNBROWSE_CAPZY_KEY when not passed. */
  clientKey?: string;
  /** Capzy API host. Default https://api.capzy.ai (UNBROWSE_CAPZY_URL override). */
  apiBase?: string;
  /** When set, uses TencentTask so the token is minted from THIS proxy (IP-match
   *  with the replay). Omit for TencentTaskProxyLess (Capzy supplies the IP). */
  proxy?: CapzyProxy;
  /** Overall budget for create + poll. Default 90s (Capzy avg ~8s). */
  timeoutMs?: number;
  /** Injectable for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Solve a Tencent WAF captcha via Capzy. Returns { ticket, randstr, appid } or
 * null on missing key / error / timeout (caller falls back to interactive auth).
 */
export async function solveTencentViaCapzy(input: SolveTencentInput): Promise<TencentSolveResult | null> {
  const clientKey = input.clientKey ?? process.env.UNBROWSE_CAPZY_KEY?.trim();
  if (!clientKey) return null;
  const apiBase = (input.apiBase ?? process.env.UNBROWSE_CAPZY_URL?.trim() ?? "https://api.capzy.ai").replace(/\/+$/, "");
  const doFetch = input.fetchImpl ?? fetch;
  const deadline = Date.now() + (input.timeoutMs ?? 90_000);

  const task: Record<string, unknown> = input.proxy
    ? {
        type: "TencentTask",
        websiteURL: input.websiteURL,
        websiteKey: input.appId,
        proxyType: input.proxy.type,
        proxyAddress: input.proxy.address,
        proxyPort: input.proxy.port,
        ...(input.proxy.login ? { proxyLogin: input.proxy.login } : {}),
        ...(input.proxy.password ? { proxyPassword: input.proxy.password } : {}),
      }
    : {
        type: "TencentTaskProxyLess",
        websiteURL: input.websiteURL,
        websiteKey: input.appId,
      };

  let taskId: string;
  try {
    const created = await doFetch(`${apiBase}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey, task }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))),
    });
    if (!created.ok) return null;
    const cj = (await created.json().catch(() => null)) as { taskId?: string; errorId?: number } | null;
    if (!cj || cj.errorId || !cj.taskId) return null;
    taskId = cj.taskId;
  } catch {
    return null;
  }

  // Poll getTaskResult until ready / error / deadline.
  while (Date.now() < deadline) {
    try {
      const res = await doFetch(`${apiBase}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
      });
      if (!res.ok) return null;
      const rj = (await res.json().catch(() => null)) as
        | { status?: string; errorId?: number; solution?: { ticket?: string; randstr?: string; appid?: string } }
        | null;
      if (!rj || rj.errorId) return null;
      if (rj.status === "ready") {
        const s = rj.solution ?? {};
        if (s.ticket && s.randstr) {
          return { ticket: s.ticket, randstr: s.randstr, appid: s.appid ?? input.appId };
        }
        return null;
      }
      // status "processing" → keep polling.
    } catch {
      return null;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

export interface WafClearanceInput {
  /** The site's WAF clearance endpoint, e.g. https://www.rootdata.com/WafCaptcha. */
  wafUrl: string;
  ticket: string;
  randstr: string;
  seqid: string;
  /** Captcha.js pushes res.ret first; success is ret===0. */
  ret?: number;
  /** Existing cookies to send (the pre-clearance TDC_itoken etc.). */
  cookieHeader?: string;
  /** Proxy-fetch through the same sticky IP. Bun `proxy` / undici dispatcher. */
  proxyUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface WafClearanceResult {
  ok: boolean;
  status: number;
  /** Raw Set-Cookie header values the WAF returned (the clearance to replay). */
  setCookies: string[];
}

/**
 * Submit the solved token to the site's WAF clearance endpoint, building the
 * exact body the page's Captcha.js does: `captchaResult.join('\n')` of
 * [ret, ticket, randstr, seqid]. Returns the Set-Cookie clearance on success.
 *
 * NB: the precise POST shape is site-Captcha.js-specific; rootdata's stub does
 * `loadXMLDoc("/WafCaptcha", [ret, ticket, randstr, seqid].join('\n'))`. This
 * mirrors that. Sites with a different bootstrap need their join order verified
 * against their own Captcha.js — kept honest (returns ok:false on non-2xx).
 */
export async function submitWafClearance(input: WafClearanceInput): Promise<WafClearanceResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const ret = input.ret ?? 0;
  const body = [String(ret), input.ticket, input.randstr, input.seqid].join("\n");
  const headers: Record<string, string> = { "Content-Type": "text/plain;charset=UTF-8" };
  if (input.cookieHeader) headers["Cookie"] = input.cookieHeader;
  try {
    const res = await doFetch(input.wafUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
      // @ts-expect-error bun-specific proxy field; undici path ignores it
      ...(input.proxyUrl ? { proxy: input.proxyUrl } : {}),
    });
    const setCookies = typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    return { ok: res.ok, status: res.status, setCookies };
  } catch {
    return { ok: false, status: 0, setCookies: [] };
  }
}

/** Parse a proxy URL (http://user:pass@host:port) into the CapzyProxy shape so the
 *  solver mints the token from the SAME residential IP the replay uses (IP-match). */
export function parseCapzyProxy(proxyUrl: string): CapzyProxy | undefined {
  try {
    const u = new URL(proxyUrl);
    if (!u.hostname || !u.port) return undefined;
    const scheme = u.protocol.replace(":", "").toLowerCase();
    const type = (scheme === "socks5" || scheme === "socks4" || scheme === "https") ? scheme : "http";
    return {
      type: type as CapzyProxy["type"],
      address: u.hostname,
      port: Number(u.port),
      ...(u.username ? { login: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Merge a prior Cookie header with new Set-Cookie values (last write wins per name). */
export function mergeCookieHeader(prior: string | undefined, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const pair of (prior ?? "").split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  for (const sc of setCookies) {
    const first = sc.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");
}

export interface ClearTencentInput {
  /** The page that returned the Tencent WAF stub. */
  url: string;
  /** The stub HTML (carries appId + seqid). */
  html: string;
  /** Sticky residential proxy URL — token minted + replay run through it. */
  proxyUrl?: string;
  /** Capzy key (UNBROWSE_CAPZY_KEY default). */
  capzyKey?: string;
  /** Pre-clearance cookies already held (e.g. TDC_itoken). */
  cookieHeader?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ClearTencentResult {
  html: string;
  cookieHeader: string;
}

/**
 * High-level Capzy-fallback composer: stub → solve → submit /WafCaptcha → replay.
 * Returns the cleared page HTML + the clearance Cookie header (persist + reuse via
 * the sticky session), or null on any miss (caller falls back / degrades to auth).
 */
export async function clearTencentWafViaCapzy(input: ClearTencentInput): Promise<ClearTencentResult | null> {
  const challenge = extractTencentChallenge(input.html);
  if (!challenge) return null;
  const solved = await solveTencentViaCapzy({
    websiteURL: input.url,
    appId: challenge.appId,
    clientKey: input.capzyKey,
    proxy: input.proxyUrl ? parseCapzyProxy(input.proxyUrl) : undefined,
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  });
  if (!solved) return null;
  let origin: string;
  try { origin = new URL(input.url).origin; } catch { return null; }
  const clearance = await submitWafClearance({
    wafUrl: `${origin}/WafCaptcha`,
    ticket: solved.ticket,
    randstr: solved.randstr,
    seqid: challenge.seqid,
    cookieHeader: input.cookieHeader,
    proxyUrl: input.proxyUrl,
    fetchImpl: input.fetchImpl,
  });
  if (!clearance.ok) return null;
  const cookieHeader = mergeCookieHeader(input.cookieHeader, clearance.setCookies);
  // Replay the real request with the clearance cookie + sticky IP.
  const doFetch = input.fetchImpl ?? fetch;
  try {
    const res = await doFetch(input.url, {
      headers: { Cookie: cookieHeader, Accept: "*/*" },
      signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
      // @ts-expect-error bun proxy field
      ...(input.proxyUrl ? { proxy: input.proxyUrl } : {}),
    });
    const html = await res.text();
    if (!html || extractTencentChallenge(html)) return null; // still challenged → honest null
    return { html, cookieHeader };
  } catch {
    return null;
  }
}
