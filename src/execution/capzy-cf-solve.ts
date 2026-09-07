/**
 * Cloudflare interstitial JS-challenge solver via Capzy — the managed path that
 * replaces the in-house bundle-replay (cf-challenge.ts `runBundleReplay`) when a
 * Capzy key is configured. Same boundary + protocol as the Tencent WAF solver
 * (tencent-waf-solve.ts): the standard `createTask`/`getTaskResult` HTTP API,
 * `clientKey` auth, proxy variants so the token's IP matches the replay IP.
 *
 * Capzy lists Cloudflare Challenge under its proxy-required systems and follows
 * the CapSolver-compatible task shape. The challenge solution returns the
 * `cf_clearance` cookie (plus the user-agent the token is bound to). We parse it
 * DEFENSIVELY because the exact solution envelope varies by service version:
 * cf_clearance may arrive as `solution.cf_clearance`, inside `solution.cookies`
 * (object or array), or as `solution.token`. We never invent a value — if no
 * cf_clearance is found we return null (honest degrade; caller falls back to the
 * bundle-replay path or vendor_blocked).
 *
 * Honest status: this is the WIRED solver. "Live" verification requires a real
 * UNBROWSE_CAPZY_KEY + a Cloudflare-gated target; without the key every function
 * returns null (never a fake clearance).
 */

import type { CapzyProxy } from "./tencent-waf-solve.js";
import { parseCapzyProxy } from "./tencent-waf-solve.js";

export interface CfClearance {
  /** The cf_clearance cookie value. */
  cf_clearance: string;
  /** The user-agent the clearance is bound to (cf_clearance is UA-locked). */
  user_agent?: string;
}

export interface SolveCfViaCapzyInput {
  /** The Cloudflare-gated page URL. */
  websiteURL: string;
  /** Capzy API key (clientKey). From UNBROWSE_CAPZY_KEY when not passed. */
  clientKey?: string;
  /** Capzy API host. Default https://api.capzy.ai (UNBROWSE_CAPZY_URL override). */
  apiBase?: string;
  /** Mint the token from THIS proxy so its IP matches the replay (cf_clearance is
   *  IP+UA bound). Omit for the proxyless task type. */
  proxy?: CapzyProxy;
  /** Overall budget for create + poll. Default 120s (CF challenges are slower). */
  timeoutMs?: number;
  /** Injectable for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Pull cf_clearance + user-agent out of a Capzy solution envelope, tolerating the
 * known shape variants. Returns null when no clearance is present (never fakes).
 */
export function extractCfClearance(solution: unknown): CfClearance | null {
  if (!solution || typeof solution !== "object") return null;
  const s = solution as Record<string, unknown>;
  const ua =
    (typeof s.user_agent === "string" && s.user_agent) ||
    (typeof s.userAgent === "string" && s.userAgent) ||
    undefined;

  // 1. Flat field.
  if (typeof s.cf_clearance === "string" && s.cf_clearance) {
    return { cf_clearance: s.cf_clearance, user_agent: ua || undefined };
  }
  // 2. solution.token (some envelopes return the clearance as the token).
  if (typeof s.token === "string" && s.token && s.type !== "turnstile") {
    return { cf_clearance: s.token, user_agent: ua || undefined };
  }
  // 3. solution.cookies as an object: { cf_clearance: "..." }.
  const cookies = s.cookies;
  if (cookies && typeof cookies === "object" && !Array.isArray(cookies)) {
    const v = (cookies as Record<string, unknown>).cf_clearance;
    if (typeof v === "string" && v) return { cf_clearance: v, user_agent: ua || undefined };
  }
  // 4. solution.cookies as an array of {name,value} or "name=value" strings.
  if (Array.isArray(cookies)) {
    for (const c of cookies) {
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        if (o.name === "cf_clearance" && typeof o.value === "string" && o.value) {
          return { cf_clearance: o.value, user_agent: ua || undefined };
        }
      } else if (typeof c === "string" && c.startsWith("cf_clearance=")) {
        const v = c.slice("cf_clearance=".length).split(";")[0];
        if (v) return { cf_clearance: v, user_agent: ua || undefined };
      }
    }
  }
  return null;
}

/** Build the Capzy task body for a Cloudflare challenge. Witnessed against the
 *  live API (2026-06-17): Cloudflare REQUIRES a proxy — `AntiCloudflareTaskProxyLess`
 *  returns ERROR_PROXY_REQUIRED, so there is only the proxied `AntiCloudflareTask`. */
export function buildCfTask(websiteURL: string, proxy: CapzyProxy): Record<string, unknown> {
  return {
    type: "AntiCloudflareTask",
    websiteURL,
    proxyType: proxy.type,
    proxyAddress: proxy.address,
    proxyPort: proxy.port,
    ...(proxy.login ? { proxyLogin: proxy.login } : {}),
    ...(proxy.password ? { proxyPassword: proxy.password } : {}),
  };
}

/**
 * Solve a Cloudflare interstitial challenge via Capzy. Returns { cf_clearance,
 * user_agent } or null on missing key / parse failure / error / timeout
 * (caller falls back to the in-house bundle-replay path or degrades honestly).
 */
export async function solveCfViaCapzy(input: SolveCfViaCapzyInput): Promise<CfClearance | null> {
  const clientKey = input.clientKey ?? process.env.UNBROWSE_CAPZY_KEY?.trim();
  if (!clientKey) return null;
  // Cloudflare REQUIRES a proxy (witnessed: proxyless → ERROR_PROXY_REQUIRED).
  // No proxy → honest null; caller falls back to the in-house bundle-replay.
  if (!input.proxy) return null;
  const apiBase = (input.apiBase ?? process.env.UNBROWSE_CAPZY_URL?.trim() ?? "https://api.capzy.ai").replace(/\/+$/, "");
  const doFetch = input.fetchImpl ?? fetch;
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  const task = buildCfTask(input.websiteURL, input.proxy);

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
        | { status?: string; errorId?: number; solution?: unknown }
        | null;
      if (!rj || rj.errorId) return null;
      // "failed" (e.g. ERROR_CAPTCHA_UNSOLVABLE) is terminal — stop polling, honest null.
      if (rj.status === "failed") return null;
      if (rj.status === "ready") {
        return extractCfClearance(rj.solution);
      }
      // "processing" → keep polling.
    } catch {
      return null;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

/** Re-export so callers building a proxy from a URL don't reach into the Tencent module. */
export { parseCapzyProxy };
