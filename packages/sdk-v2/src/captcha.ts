/**
 * captcha — both-modes dispatch. Pure functions only.
 *
 * Contracts (per packages/sdk-v2/CONTRACT.md § Captcha solver surface):
 *
 * Turnkey (default): the worker dispatches through the existing x402/Capzy
 *   plumbing at src/execution/captcha-solve.ts. Cost settles through the
 *   consumer's wallet via pay.sh. Vendor hint picks Capzy when
 *   UNBROWSE_CAPZY_KEY is set, else paysponge/2Captcha.
 *
 * BYOK (mode: "byok"): the SDK calls the solver directly from the SDK
 *   consumer's runtime. The worker still observes the solved token and
 *   replays the original request (the worker hop still settles via
 *   the consumer's wallet — BYOK bypasses the solve dispatch, NOT the
 *   underlying /v1/proxy payment).
 *
 * Vendor → task-type map mirrors src/execution/captcha-solve.ts:42-52
 * (cloudflare → TurnstileTaskProxyless, recaptcha → RecaptchaV2TaskProxyless,
 * hcaptcha → HCaptchaTaskProxyless, funcaptcha → FunCaptchaTaskProxyless,
 * arkoselabs → FunCaptchaTaskProxyless, geetest → GeeTestTaskProxyless).
 *
 * Statelessness: all functions are pure. The SDK-side dispatch config is
 * derived from (env, opts); no module-level state, no I/O.
 */

export type CaptchaVendor = "cloudflare" | "recaptcha" | "hcaptcha" | "funcaptcha" | "arkoselabs" | "geetest" | "captcha_vendor";

export const VENDOR_TASK_TYPE: Readonly<Record<CaptchaVendor, string>> = {
  cloudflare: "TurnstileTaskProxyless",
  recaptcha: "RecaptchaV2TaskProxyless",
  hcaptcha: "HCaptchaTaskProxyless",
  funcaptcha: "FunCaptchaTaskProxyless",
  arkoselabs: "FunCaptchaTaskProxyless",
  geetest: "GeeTestTaskProxyless",
  // captcha_vendor: ambiguous — classifyExecuteFailure tags reCAPTCHA /
  // hCaptcha / FunCaptcha / Arkose all as "captcha_vendor". The body
  // sniffer narrows further; without narrowing, we can't dispatch to a
  // specific task type. The dispatch config returns the "narrow_first"
  // flag so the caller knows to do sitekey/iframe sniffing first.
  captcha_vendor: "narrow_first",
};

export interface TurnkeyDispatchConfig {
  mode: "turnkey";
  /** Where the worker sends the solve request. */
  endpoint: string;
  /** Task type from VENDOR_TASK_TYPE, sent in the body to the worker. */
  task_type: string;
  /** Billed-through path: paysponge x402 or capzy balance. */
  payment_through: "x402_paysponge" | "capzy_balance";
  /** True when the worker must narrow captcha_vendor → a specific type before dispatch. */
  narrow_first: boolean;
}

export interface ByokDispatchConfig {
  mode: "byok";
  /** Direct solver endpoint the SDK hits from the consumer's runtime. */
  endpoint: string;
  /** Task type sent to the solver. */
  task_type: string;
  /** Auth header value for the solver call (e.g. "Bearer <key>" or "<key>"). */
  auth_header_value: string;
  /** Solver vendor name, so the worker knows which task type to expect in the trace. */
  vendor: "capsolver" | "2captcha";
}

export type CaptchaDispatchConfig = TurnkeyDispatchConfig | ByokDispatchConfig | null;

/**
 * Resolve the dispatch config for a captcha auto-solve request.
 *
 * Returns null when auto_solve is false or vendor detection fails — never a
 * fabricated config that would silently no-op through the worker.
 *
 * The worker is the truth-root for paid dispatch — the SDK's config is a
 * hint the worker re-validates against its own env + wallet state.
 */
export function resolveCaptchaDispatch(
  opts: {
    auto_solve: boolean;
    mode?: "turnkey" | "byok";
    vendor?: "auto" | "2captcha" | "capzy" | "capsolver";
    api_key?: string;
    /** The actual captcha vendor detected from the response body (or captcha_vendor if ambiguous). */
    detected_vendor?: CaptchaVendor;
  },
  env: {
    UNBROWSE_CAPZY_KEY?: string;
    UNBROWSE_CAPSOLVER_KEY?: string;
  },
): CaptchaDispatchConfig {
  if (!opts.auto_solve) return null;
  const detected = opts.detected_vendor ?? "captcha_vendor";
  const task_type = VENDOR_TASK_TYPE[detected];

  if (opts.mode === "byok") {
    return resolveByokConfig(opts, env, task_type);
  }

  return resolveTurnkeyConfig(opts, env, task_type);
}

function resolveByokConfig(
  opts: { vendor?: "auto" | "2captcha" | "capzy" | "capsolver"; api_key?: string },
  env: { UNBROWSE_CAPZY_KEY?: string; UNBROWSE_CAPSOLVER_KEY?: string },
  task_type: string,
): ByokDispatchConfig | null {
  if (!opts.api_key) return null;
  const vendor = opts.vendor === "capsolver" || (opts.vendor === "auto" && env.UNBROWSE_CAPSOLVER_KEY)
    ? "capsolver"
    : opts.vendor === "2captcha"
      ? "2captcha"
      : null;
  if (!vendor) return null;

  // CapSolver: POST https://api.capsolver.com/createTask with "ClientKey" auth.
  // 2Captcha: POST https://2captcha.com/in.php with key as body param.
  // Both accept the same task-type names from VENDOR_TASK_TYPE.
  return {
    mode: "byok",
    endpoint: vendor === "capsolver"
      ? "https://api.capsolver.com/createTask"
      : "https://2captcha.com/in.php",
    task_type: task_type === "narrow_first" ? "TurnstileTaskProxyless" : task_type,
    auth_header_value: vendor === "capsolver"
      ? opts.api_key
      : opts.api_key,
    vendor,
  };
}

function resolveTurnkeyConfig(
  opts: { vendor?: "auto" | "2captcha" | "capzy" | "capsolver" },
  env: { UNBROWSE_CAPZY_KEY?: string },
  task_type: string,
): TurnkeyDispatchConfig | null {
  const useCapzy = opts.vendor === "capzy" || (opts.vendor !== "2captcha" && Boolean(env.UNBROWSE_CAPZY_KEY));
  return {
    mode: "turnkey",
    endpoint: useCapzy
      ? "https://api.capzy.ai/v1/createTask"
      : "https://2captcha.x402.paysponge.com/createTask",
    task_type,
    payment_through: useCapzy ? "capzy_balance" : "x402_paysponge",
    narrow_first: task_type === "narrow_first",
  };
}

/**
 * Detect the captcha vendor from an HTTP response body. Returns null when
 * no known marker is found — never a guess. The caller surfaces this in the
 * request trace so the SDK consumer can audit which vendor was charged.
 *
 * Markers:
 *   - data-sitekey + "cf-turnstile" → cloudflare
 *   - data-sitekey + "g-recaptcha" / "recaptcha" → recaptcha
 *   - data-sitekey + "h-captcha" / "hcaptcha" → hcaptcha
 *   - "funcaptcha" / "arkose" → funcaptcha (or arkoselabs when aws/arkose.com)
 *   - "geetest" / "gt_" → geetest
 *   - any data-sitekey match without the above → captcha_vendor (narrow_first)
 */
export function detectCaptchaVendor(body: string): CaptchaVendor | null {
  if (!body) return null;
  const lower = body.toLowerCase();
  if (/cf-turnstile|challenges\.cloudflare\.com\/turnstile/.test(lower)) return "cloudflare";
  if (/g-recaptcha|recaptcha\.api|recaptcha\.net/.test(lower)) return "recaptcha";
  if (/h-captcha|hcaptcha\.com/.test(lower)) return "hcaptcha";
  if (/funcaptcha|arkoselabs\.com/.test(lower)) return "arkoselabs";
  if (/geetest|gt_call/.test(lower)) return "geetest";
  if (/data-sitekey\s*=/.test(lower)) return "captcha_vendor";
  return null;
}

/**
 * Extract a sitekey from a body. Returns null when absent — never a guess.
 * The sitekey is the universal marker across all widget renders; missing
 * it means the challenge is not widget-based and the worker cannot solve
 * via the vendor task API.
 */
export function extractSitekey(body: string): string | null {
  if (!body) return null;
  const m = body.match(/data-sitekey\s*=\s*["']([^"']+)["']/i);
  return m && m[1] ? m[1] : null;
}

/**
 * Categorize a worker's captcha_solver_status string into a coarse
 * outcome for SDK consumer reporting. Prose → enum, no guesswork.
 */
export function categorizeSolverOutcome(
  status: string | undefined | null,
): "not_dispatched" | "solved" | "replayed" | "no_sitekey" | "no_wallet" | "solver_failed" | "replay_blocked" {
  switch (status ?? undefined) {
    case "dispatched": return "solved";
    case "token_received": return "solved";
    case "replay_success": return "replayed";
    case "failed_no_sitekey": return "no_sitekey";
    case "failed_no_wallet": return "no_wallet";
    case "failed_solver_error": return "solver_failed";
    case "failed_replay_blocked": return "replay_blocked";
    case "byok_dispatched":
    case "byok_token_received": return "solved";
    case undefined:
    case null:
    case "":
      return "not_dispatched";
    default:
      return "not_dispatched";
  }
}