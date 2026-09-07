/**
 * Shared anti-bot rescue ladder for get/resolve/direct-document paths.
 *
 * Order (cheapest first):
 *   FREE  1. fetch-ladder (curl-impersonate direct, then residential proxy)
 *   FREE  2. camoufox stealth Firefox (when venv present)
 *   PAID  3. x402 paid web-unblocker (JS render + captcha, when payment available)
 *   PAID  4. Capzy CF interstitial (local key) — optional
 *
 * Free vs paid are exported separately so the product resolve walk can probe
 * free rungs before arming paid egress (semantic-layer-walk / walkCapabilityLayers).
 *
 * Honest degrade: returns null + reason when every rung is unavailable or still blocked.
 * No fabricated HTML.
 */
import { walkFetchLadder, looksBlocked } from "../capture/fetch-ladder.js";
import {
  tryX402UnblockerFetch,
  x402PaymentAvailable,
  tryCurlImpersonateFetch,
  tryCamoufoxFetch,
} from "../capture/curl-impersonate-fallback.js";
import { resolveEgressProxy } from "./proxy-fetch.js";

export type AntiBotRescueReason =
  | "ok"
  | "still_blocked"
  | "unavailable"
  | "no_payment"
  | "disabled";

export interface AntiBotRescueResult {
  html: string | null;
  via: string | null;
  reason: AntiBotRescueReason;
  bytes: number;
}

export interface AntiBotRescueOpts {
  url: string;
  /** Optional blocked body already in hand (used for challenge detection). */
  html?: string | null;
  cookies?: Array<{ name: string; value: string }>;
  /** Cap individual free rungs (default 45s for proxy rung). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function rescueEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.UNBROWSE_ANTI_BOT_RESCUE?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true; // default ON
}

/**
 * Deep browser capture (Kuri Chromium render) after free/paid rescue miss.
 * Default ON as the last-resort fallback for challenge/interstitial/SPA/thin paths.
 * Opt out with UNBROWSE_DEEP_CAPTURE=0 (or false/no/off) for fast coverage budgets.
 */
export function isDeepCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.UNBROWSE_DEEP_CAPTURE?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true; // default ON
}

function looksLikeChallenge(html: string | null | undefined): boolean {
  if (!html) return false;
  const h = html.slice(0, 8_000).toLowerCase();
  return (
    looksBlocked(html, 512)
    || /cf-browser-verification|cf-challenge|turnstile|just a moment|attention required|datadome|px-captcha|perimeterx|akamai|challenge-platform/i.test(h)
  );
}

function gateRescue(opts: AntiBotRescueOpts): AntiBotRescueResult | null {
  const env = opts.env ?? process.env;
  if (!rescueEnabled(env)) {
    return { html: null, via: null, reason: "disabled", bytes: 0 };
  }
  const url = opts.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return { html: null, via: null, reason: "unavailable", bytes: 0 };
  }
  return null;
}

/**
 * Free rungs only: fetch-ladder → sticky-proxy impersonate → camoufox.
 * Never spends x402/Capzy. Safe to call from walkCapabilityLayers.rescueFree.
 */
export async function rescueBlockedPageFree(opts: AntiBotRescueOpts): Promise<AntiBotRescueResult> {
  const gated = gateRescue(opts);
  if (gated) return gated;
  const env = opts.env ?? process.env;
  const url = opts.url;

  // 1) Free ladder (impersonate direct + proxy)
  try {
    const ladder = await walkFetchLadder(url, opts.cookies);
    if (ladder?.text && !looksLikeChallenge(ladder.text) && ladder.text.length > 1024) {
      return { html: ladder.text, via: `fetch-ladder:${ladder.rung}`, reason: "ok", bytes: ladder.bytes };
    }
  } catch {
    /* advance */
  }

  // Extra direct impersonate with sticky egress when proxy is configured
  // (walkFetchLadder already tries proxy; this catches forceDirect=false edge cases).
  try {
    const proxy = resolveEgressProxy(env);
    if (proxy) {
      const viaProxy = await tryCurlImpersonateFetch({
        url,
        timeoutMs: opts.timeoutMs ?? 45_000,
        proxy,
        cookies: opts.cookies,
        impersonate: "chrome131",
      });
      if (viaProxy?.html && !looksLikeChallenge(viaProxy.html) && viaProxy.html.length > 1024) {
        return {
          html: viaProxy.html,
          via: "impersonate-sticky-proxy",
          reason: "ok",
          bytes: viaProxy.bytes,
        };
      }
    }
  } catch {
    /* advance */
  }

  // 2) Camoufox stealth Firefox (when scripts/.camoufox-venv is present) — free JS-capable
  // fallback before paid unlockers. No-ops when venv/binary missing.
  try {
    let camo = await tryCamoufoxFetch({
      url,
      timeoutMs: Math.min(opts.timeoutMs ?? 90_000, 90_000),
      forceDirect: true,
    });
    if ((!camo?.html || looksLikeChallenge(camo.html)) && resolveEgressProxy(env)) {
      camo = await tryCamoufoxFetch({
        url,
        timeoutMs: Math.min(opts.timeoutMs ?? 90_000, 90_000),
      });
    }
    if (camo?.html && !looksLikeChallenge(camo.html) && camo.html.length > 1024) {
      return {
        html: camo.html,
        via: "camoufox",
        reason: "ok",
        bytes: camo.bytes ?? camo.html.length,
      };
    }
  } catch {
    /* advance */
  }

  return { html: null, via: null, reason: "still_blocked", bytes: 0 };
}

/**
 * Paid rungs only: x402 unblocker → Capzy CF clearance.
 * Call only after free rungs miss (walkCapabilityLayers.rescuePaid).
 */
/**
 * Budget for a paid solver rung.
 *
 * Paid captcha/JS solvers genuinely need ~2 minutes, so 120s is the right
 * DEFAULT. It was written as `Math.max(opts.timeoutMs ?? 0, 120_000)`, which
 * made it a FLOOR — a caller asking for 2s was silently given 120s, sixty times
 * the budget it asked for, and `rescueBlockedPage` runs free-then-paid in
 * sequence so the total ran past both. That is how a 2s-budgeted call could
 * outlive a 5s test timeout.
 *
 * An explicit caller budget is a CEILING and is never raised. A budget too small
 * for a solver to plausibly finish simply fails fast inside it, which is the
 * honest outcome — better than blowing a stated deadline by two orders of
 * magnitude on a rung that was unlikely to land anyway.
 */
export function paidRungBudgetMs(opts: Pick<AntiBotRescueOpts, "timeoutMs">): number {
  return opts.timeoutMs ?? 120_000;
}

export async function rescueBlockedPagePaid(opts: AntiBotRescueOpts): Promise<AntiBotRescueResult> {
  const gated = gateRescue(opts);
  if (gated) return gated;
  const env = opts.env ?? process.env;
  const url = opts.url;

  // 3) Paid x402 unblocker (JS + captcha class)
  if (x402PaymentAvailable(env)) {
    try {
      const unlocked = await tryX402UnblockerFetch({
        url,
        timeoutMs: paidRungBudgetMs(opts),
      });
      if (unlocked?.html && unlocked.html.length > 1024 && !looksLikeChallenge(unlocked.html)) {
        return {
          html: unlocked.html,
          via: "x402-unblocker",
          reason: "ok",
          bytes: unlocked.bytes ?? unlocked.html.length,
        };
      }
    } catch {
      /* advance */
    }
  }

  // 4) Capzy CF clearance (optional local key) → re-fetch with cf_clearance cookie
  if (looksLikeChallenge(opts.html) && env.UNBROWSE_CAPZY_KEY?.trim()) {
    try {
      const { solveCfViaCapzy } = await import("./capzy-cf-solve.js");
      const { parseCapzyProxy } = await import("./tencent-waf-solve.js");
      const proxyUrl = resolveEgressProxy(env);
      const proxy = proxyUrl ? parseCapzyProxy(proxyUrl) : undefined;
      const clearance = await solveCfViaCapzy({
        websiteURL: url,
        clientKey: env.UNBROWSE_CAPZY_KEY,
        proxy: proxy ?? undefined,
        timeoutMs: paidRungBudgetMs(opts),
      });
      if (clearance?.cf_clearance) {
        const cookies = [
          ...(opts.cookies ?? []),
          { name: "cf_clearance", value: clearance.cf_clearance },
        ];
        const replay = await tryCurlImpersonateFetch({
          url,
          timeoutMs: opts.timeoutMs ?? 45_000,
          proxy: proxyUrl,
          cookies,
          impersonate: "chrome131",
        });
        if (replay?.html && !looksLikeChallenge(replay.html) && replay.html.length > 1024) {
          return {
            html: replay.html,
            via: "capzy-cf-clearance",
            reason: "ok",
            bytes: replay.bytes,
          };
        }
      }
    } catch {
      /* advance */
    }
  }

  if (!x402PaymentAvailable(env) && !resolveEgressProxy(env) && !env.UNBROWSE_CAPZY_KEY?.trim()) {
    return { html: null, via: null, reason: "no_payment", bytes: 0 };
  }
  return { html: null, via: null, reason: "still_blocked", bytes: 0 };
}

/**
 * Full rescue: free rungs then paid. Preserves prior behavior for callers that
 * have not yet switched to walkCapabilityLayers.
 * Safe to call from orchestrator / get paths; never throws.
 */
export async function rescueBlockedPage(opts: AntiBotRescueOpts): Promise<AntiBotRescueResult> {
  // `timeoutMs` is the budget for the WHOLE rescue, not per half. Free and paid
  // run in sequence, so passing the same number to both spent it twice: a caller
  // asking for 2s could wait for the free rungs AND then a full paid walk.
  // The paid half now gets whatever is left of the deadline.
  const startedAt = Date.now();
  const free = await rescueBlockedPageFree(opts);
  if (free.reason === "ok" || free.reason === "disabled" || free.reason === "unavailable") {
    return free;
  }
  if (opts.timeoutMs === undefined) return rescueBlockedPagePaid(opts);
  const remainingMs = opts.timeoutMs - (Date.now() - startedAt);
  // Nothing left to spend — report the free half's verdict rather than starting a
  // paid walk we have already promised not to have time for.
  if (remainingMs <= 0) return free;
  return rescueBlockedPagePaid({ ...opts, timeoutMs: remainingMs });
}

/** Reasons where direct-document rejection should trigger rescue. */
export function isRescueableDirectDocumentReason(reason: string | undefined): boolean {
  return reason === "challenge_html"
    || reason === "interstitial_detected"
    || reason === "spa_hydration_required"
    || reason === "too_small";
}
