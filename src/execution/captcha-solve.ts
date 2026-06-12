/**
 * 2Captcha auto-solve hook (route remembrance sha256:50d2bca7,
 * correction sha256:d7819b7d).
 *
 * Architectural directive: when classifyExecuteFailure surfaces
 * `vendor_blocked` with a captcha vendor, dispatch to 2Captcha via x402
 * (POST https://2captcha.x402.paysponge.com/createTask, $0.01 USDC on
 * Base/Solana). Sync envelope — paysponge gateway charges per call and
 * returns the solved token. Inject the token into the original request
 * and replay. Fall back to browser_call only when 2Captcha errors or
 * payment plumbing is missing.
 *
 * platform discipline:
 *   - NO per-vendor switch. The vendor name is a structural primitive
 *     surfaced by classifyExecuteFailure. We map vendor → 2Captcha task
 *     type via a single lookup table (data shape, not control flow).
 *   - Sitekey extraction reads `data-sitekey="..."` from the captured
 *     body (universal marker across reCAPTCHA / hCaptcha / Turnstile /
 *     FunCaptcha widget renders). Sites that hide sitekey in JS-only
 *     bundles are an OPEN GAP — return null and let caller fall back.
 *   - Decision-trace steps follow CLAUDE.md naming convention:
 *     captcha_solve_dispatch / captcha_solve_token_received /
 *     captcha_solve_replay (+ _success / _no_sitekey / _no_payment /
 *     _solver_error / _replay_blocked sub-states).
 *
 * 2026-05-27 WEDGE CLOSE (route remembrance sha256:cb168afc):
 * The "no_payment" sub-state used to be terminal — paysponge returned 402
 * and the bare `fetch` call surfaced it as solver_error. We now route the
 * POST through x402Fetch (src/payments/x402-fetch.ts), which intercepts
 * the 402, signs via the configured wallet adapter (lobster/privy/generic),
 * sets X-PAYMENT, and retries once. When NO wallet is configured the
 * x402_no_wallet sub-state is honest and the caller falls back to
 * browser_fallback — never a fake-success.
 */
import { x402Fetch } from "../payments/x402-fetch.js";

// ---------------------------------------------------------------------------
// Vendor → 2Captcha task type. Data, not branches. Add a row to extend.
// Task names from the 2Captcha API standard
// (https://2captcha.com/api-docs/createTask, supported by paysponge).
// ---------------------------------------------------------------------------
const VENDOR_TASK_TYPE: Readonly<Record<string, string>> = {
  cloudflare: "TurnstileTaskProxyless",
  // captcha_vendor: ambiguous — classifyExecuteFailure tags reCAPTCHA /
  // hCaptcha / FunCaptcha / Arkose all as "captcha_vendor". The body
  // sniffer (deriveCaptchaSubvendor) narrows further.
  recaptcha: "RecaptchaV2TaskProxyless",
  hcaptcha: "HCaptchaTaskProxyless",
  funcaptcha: "FunCaptchaTaskProxyless",
  arkoselabs: "FunCaptchaTaskProxyless",
  geetest: "GeeTestTaskProxyless",
};

// Solvable vendor set — what we even bother dispatching for. Other
// vendors (datadome, perimeterx, akamai_bot_manager, kasada, shape,
// imperva, fastly) are NOT CAPTCHA challenges — they're JS bundles /
// sensor collection. Their solver path is the existing bundle-replay
// sandbox, NOT 2Captcha. Returning here means "fall through to the
// browser_fallback existing path."
export function isCaptchaVendor(vendor: string | undefined): boolean {
  if (!vendor) return false;
  return ["cloudflare", "captcha_vendor", "recaptcha", "hcaptcha", "funcaptcha", "arkoselabs", "geetest"].includes(vendor);
}

// ---------------------------------------------------------------------------
// deriveCaptchaSubvendor — narrow `captcha_vendor` into the specific
// widget by re-sniffing the body. Structural primitive (substring
// match on widget container classes / src URLs). Used only when the
// upstream classifier returned the generic `captcha_vendor` bucket.
// ---------------------------------------------------------------------------
export function deriveCaptchaSubvendor(body: string): string {
  const sample = body.length > 16384 ? body.slice(0, 16384) : body;
  if (/g-recaptcha|src=["'][^"']*recaptcha\//i.test(sample)) return "recaptcha";
  if (/h-captcha|src=["'][^"']*hcaptcha\//i.test(sample)) return "hcaptcha";
  if (/funcaptcha|arkose|src=["'][^"']*funcaptcha\//i.test(sample)) return "funcaptcha";
  if (/geetest|src=["'][^"']*geetest\//i.test(sample)) return "geetest";
  return "recaptcha";
}

// ---------------------------------------------------------------------------
// extractSitekey — read `data-sitekey="..."` from the body. Universal
// across the supported widgets (g-recaptcha, h-captcha, cf-turnstile,
// fc-token). Returns null on miss — caller falls through.
// ---------------------------------------------------------------------------
export function extractSitekey(body: string): string | null {
  if (!body || typeof body !== "string") return null;
  const sample = body.length > 65536 ? body.slice(0, 65536) : body;
  // Universal: every widget renders `data-sitekey="..."` on its div.
  let m = sample.match(/data-sitekey\s*=\s*["']([A-Za-z0-9_\-:.]+)["']/i);
  if (m && m[1]) return m[1];
  // Turnstile fallback: explicit `sitekey: '...'` in inline JS init.
  m = sample.match(/sitekey\s*[:=]\s*["']([A-Za-z0-9_\-:.]+)["']/i);
  if (m && m[1]) return m[1];
  return null;
}

// ---------------------------------------------------------------------------
// Cost guardrail — per-probe budget (1 call ≤ $0.01 by default) and a
// per-process daily ceiling. The per-probe ceiling is a structural
// stop: we never want to fire 2Captcha twice on the same probe (if
// the first solve didn't unblock, the second won't either — sitekey
// or response shape is wrong, and we should fall through to browser).
// The per-day ceiling is informational: the actual payment gate is
// the x402 wallet precheck (no wallet → no spend).
// ---------------------------------------------------------------------------
const DEFAULT_PER_PROBE_BUDGET_USD = 0.01;
const DEFAULT_PER_DAY_BUDGET_USD = parseFloat(process.env.UNBROWSE_CAPTCHA_DAILY_USD ?? "1.00");

interface DailyLedger {
  date: string; // YYYY-MM-DD UTC
  spent_usd: number;
  calls: number;
}
let DAILY_LEDGER: DailyLedger = { date: "", spent_usd: 0, calls: 0 };

function checkDailyBudget(addUsd: number): { ok: boolean; remaining_usd: number } {
  const today = new Date().toISOString().slice(0, 10);
  if (DAILY_LEDGER.date !== today) DAILY_LEDGER = { date: today, spent_usd: 0, calls: 0 };
  const remaining = DEFAULT_PER_DAY_BUDGET_USD - DAILY_LEDGER.spent_usd;
  if (addUsd > remaining) return { ok: false, remaining_usd: remaining };
  return { ok: true, remaining_usd: remaining };
}

function recordSpend(usd: number) {
  const today = new Date().toISOString().slice(0, 10);
  if (DAILY_LEDGER.date !== today) DAILY_LEDGER = { date: today, spent_usd: 0, calls: 0 };
  DAILY_LEDGER.spent_usd += usd;
  DAILY_LEDGER.calls += 1;
}

export interface CaptchaSolveResult {
  /** Solved token (`token` field for Turnstile, `gRecaptchaResponse` etc.) */
  token: string;
  /** The injection key for the original request body / headers. */
  inject_key: string;
  /** Cost in USD that was actually charged. */
  cost_usd: number;
  /** Trace evidence for decision_trace. */
  evidence: Record<string, unknown>;
}

const PAYSPONGE_URL = process.env.UNBROWSE_CAPTCHA_SOLVE_URL
  ?? "https://2captcha.x402.paysponge.com/createTask";

// Map vendor → which form field / header the solved token gets injected
// into on the original request. Per the captcha widget standards:
//   reCAPTCHA → `g-recaptcha-response` (form field or header)
//   hCaptcha  → `h-captcha-response`
//   Turnstile → `cf-turnstile-response`
//   FunCaptcha/Arkose → `fc-token`
//   GeeTest   → `geetest_response` (composite; we pass the token raw)
const VENDOR_INJECT_KEY: Readonly<Record<string, string>> = {
  cloudflare: "cf-turnstile-response",
  recaptcha: "g-recaptcha-response",
  hcaptcha: "h-captcha-response",
  funcaptcha: "fc-token",
  arkoselabs: "fc-token",
  geetest: "geetest_response",
};

/**
 * Dispatch a 2Captcha solve via the paysponge x402 gateway. Returns
 * { token, inject_key } on success; null when:
 *   - x402 payment plumbing isn't wired in the calling process (no x402
 *     wallet adapter is precheck()-true), OR
 *   - the paysponge endpoint returned an error (e.g. unsolvable, bad
 *     sitekey, sustained 5xx), OR
 *   - sitekey couldn't be extracted (caller already filtered for this,
 *     but defense-in-depth), OR
 *   - daily budget exceeded.
 *
 * On null, caller falls through to browser_fallback (existing path).
 * On token, caller injects it into the original request and replays
 * via serverFetch.
 *
 * IMPORTANT: this function does NOT itself sign the x402 payment. It
 * makes the unauthenticated POST to PAYSPONGE_URL. If the gateway
 * returns HTTP 402 (payment required), the caller's x402 wallet
 * adapter must intercept and sign before we get a 200. The wallet
 * adapter wiring is currently STUBBED (PROVIDER_REGISTRY in
 * src/payments/generic-x402-adapter.ts is not yet plumbed into a
 * 402-intercept fetch wrapper). Until that's wired, this function
 * will see the 402 and return null — caller falls back to browser.
 * Documented gap: this matches the platform-discipline rule (no
 * fake success path).
 */
export async function solveCaptchaViaX402(input: {
  vendor: string;            // from classifyExecuteFailure
  body: string;              // upstream response body (where sitekey lives)
  challengeUrl: string;      // the URL we tried to fetch
  timeoutMs?: number;
}): Promise<CaptchaSolveResult | null> {
  const { vendor, body, challengeUrl } = input;

  // Resolve sub-vendor when the upstream tag was generic.
  const effectiveVendor = vendor === "captcha_vendor" ? deriveCaptchaSubvendor(body) : vendor;
  const taskType = VENDOR_TASK_TYPE[effectiveVendor];
  if (!taskType) return null;

  const sitekey = extractSitekey(body);
  if (!sitekey) {
    return { token: "", inject_key: "", cost_usd: 0, evidence: { sub_state: "no_sitekey", effective_vendor: effectiveVendor } } as CaptchaSolveResult & { token: "" };
    // The caller checks token.length===0 to mean "no sitekey, fall through."
    // Returning the evidence row instead of null lets the decision_trace
    // record why we didn't dispatch — platform honesty.
  }

  const budget = checkDailyBudget(DEFAULT_PER_PROBE_BUDGET_USD);
  if (!budget.ok) {
    return { token: "", inject_key: "", cost_usd: 0, evidence: { sub_state: "daily_budget_exceeded", remaining_usd: budget.remaining_usd } } as CaptchaSolveResult & { token: "" };
  }

  // Construct the 2Captcha-format task body. Paysponge gateway accepts
  // the standard 2Captcha createTask JSON shape (verified against the
  // bazaar schema returned in the 402 envelope from PAYSPONGE_URL).
  const taskBody: Record<string, unknown> = {
    task: {
      type: taskType,
      websiteURL: challengeUrl,
      websiteKey: sitekey,
    },
  };

  const timeoutMs = input.timeoutMs ?? 120_000; // Turnstile/Recaptcha typically 30-90s
  try {
    // Wedge close 2026-05-27: x402Fetch intercepts paysponge's 402, signs
    // via configured wallet, retries once. When no wallet is configured the
    // wrapper surfaces x402_no_wallet and the response is still the original
    // 402 — caller falls through to browser_fallback. No fake-success path.
    const { response: res, trace: x402Trace } = await x402Fetch(PAYSPONGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 402) {
      // Either no wallet, signer error, cost exceeded, or signed-but-rejected.
      // All map to "no_payment" from the captcha caller's perspective; the
      // x402 sub-state carries the specific reason for the decision_trace.
      return {
        token: "",
        inject_key: "",
        cost_usd: 0,
        evidence: {
          sub_state: "no_payment",
          status: 402,
          x402_url: PAYSPONGE_URL,
          x402_sub_state: x402Trace.sub_state,
          x402_adapter: x402Trace.adapter,
          x402_error: x402Trace.error,
          x402_requested_cost_usd: x402Trace.requested_cost_usd,
        },
      } as CaptchaSolveResult & { token: "" };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { token: "", inject_key: "", cost_usd: 0, evidence: { sub_state: "solver_error", status: res.status, err_excerpt: errText.slice(0, 200) } } as CaptchaSolveResult & { token: "" };
    }
    const parsed = await res.json().catch(() => null) as
      | { solution?: { token?: string; gRecaptchaResponse?: string; fc_token?: string; geetest?: unknown }; errorId?: number; errorDescription?: string }
      | null;
    if (!parsed || parsed.errorId) {
      return { token: "", inject_key: "", cost_usd: 0, evidence: { sub_state: "solver_error", err: parsed?.errorDescription ?? "unknown_solver_response" } } as CaptchaSolveResult & { token: "" };
    }
    // Extract the solved token from the standard 2Captcha solution shape.
    const sol = parsed.solution ?? {};
    const token = sol.token ?? sol.gRecaptchaResponse ?? sol.fc_token
      ?? (sol.geetest ? JSON.stringify(sol.geetest) : "");
    if (!token) {
      return { token: "", inject_key: "", cost_usd: 0, evidence: { sub_state: "solver_no_token", solution_keys: Object.keys(sol) } } as CaptchaSolveResult & { token: "" };
    }
    recordSpend(DEFAULT_PER_PROBE_BUDGET_USD);
    const inject_key = VENDOR_INJECT_KEY[effectiveVendor] ?? "captcha-response";
    return {
      token,
      inject_key,
      cost_usd: DEFAULT_PER_PROBE_BUDGET_USD,
      evidence: { sub_state: "token_received", effective_vendor: effectiveVendor, task_type: taskType, token_len: token.length },
    };
  } catch (err) {
    return { token: "", inject_key: "", cost_usd: 0, evidence: { sub_state: "solver_error", err: err instanceof Error ? err.message : String(err) } } as CaptchaSolveResult & { token: "" };
  }
}

/**
 * Inject the solved token into request headers for replay. The token
 * lands as BOTH a header AND (when method is POST/PUT/PATCH) into a
 * form-field shape the calling fetch wrapper can serialize. Header
 * injection is the universal path — every captcha-protected route
 * supports header-or-body verification on the server side.
 */
export function injectSolvedToken(
  headers: Record<string, string>,
  result: CaptchaSolveResult,
): Record<string, string> {
  if (!result.token) return headers;
  return {
    ...headers,
    [`x-${result.inject_key}`]: result.token,
    [result.inject_key]: result.token,
  };
}
