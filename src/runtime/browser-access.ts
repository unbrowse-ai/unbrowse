export interface BrowserAccessConfig {
  default_path: "unbrowse" | "direct" | "proxy";
  fallback_path: "direct" | "proxy";
  supported_frameworks: string[];
}

export const DEFAULT_BROWSER_ACCESS: BrowserAccessConfig = {
  default_path: "unbrowse",
  fallback_path: "direct",
  supported_frameworks: ["openclaw", "mcp", "langchain", "hermes", "elizaos"],
};

/** Browser-backed operations exposed by both the CLI and MCP surfaces. */
export type BrowserOperation = "fetch" | "go" | "capture" | "auth" | "snap" | "click" | "submit";

export type BrowserCapabilityReason =
  | "unsupported_browser"
  | "chromium_unavailable"
  | "chromium_cdp_unavailable"
  | "kuri_sandbox_unavailable"
  | "cloudflare"
  | "perimeterx"
  | "empty_capture"
  | "auth_required"
  | "session_expired";

export type BrowserCapability =
  | { status: "supported"; operation: BrowserOperation; browser: "chromium" | "obscura" }
  | {
      status: "unavailable" | "auth_required";
      operation: BrowserOperation;
      reason: BrowserCapabilityReason;
      message: string;
    };

export interface BrowserCapabilityInput {
  operation: BrowserOperation;
  /** Requested browser family. Omit to use Chromium. */
  browser?: string;
  chromium_available: boolean;
  browser_runtime_available: boolean;
  /** The verified CDP substrate used by both `go` and `capture`. */
  chromium_cdp_available?: boolean;
  /** Only required for operations which explicitly depend on Kuri. */
  kuri_required?: boolean;
  kuri_sandbox_available?: boolean;
  /** Set only when the target operation is known to require an authenticated session. */
  requires_auth?: boolean;
  auth_available?: boolean;
}

export interface BrowserRecovery {
  reason: BrowserCapabilityReason;
  next_step?: string;
  retryable: boolean;
}

export type BrowserTruthMode = "static_unevaluated" | "javascript_evaluated";

export interface BrowserTruthBoundary {
  truth_mode: BrowserTruthMode;
  javascript_required: boolean;
  stealth: "none" | "best_effort";
  stealth_guaranteed: false;
}

const EVALUATED_JAVASCRIPT_INTENT_RE =
  /\b(?:fingerprint(?:ing)?|webdriver|sannysoft|canvas|webgl|audio\s*context|navigator\.(?:webdriver|plugins|languages)|client[- ]side render(?:ed|ing)?|hydrated dom|after javascript|execute javascript|javascript[- ]evaluated|runtime dom)\b/i;

/** Tasks whose evidence only exists after page scripts run may never settle on static HTML. */
export function intentRequiresEvaluatedJavascript(intent?: string): boolean {
  return typeof intent === "string" && EVALUATED_JAVASCRIPT_INTENT_RE.test(intent);
}

export function browserTruthSatisfiesIntent(boundary: BrowserTruthBoundary): boolean {
  return !boundary.javascript_required || boundary.truth_mode === "javascript_evaluated";
}

/** Honest provenance for DOM observations and anti-detection behavior. */
export function browserTruthBoundary(input: { javascriptEvaluated: boolean; javascriptRequired: boolean; stealthAttempted?: boolean }): BrowserTruthBoundary {
  return {
    truth_mode: input.javascriptEvaluated ? "javascript_evaluated" : "static_unevaluated",
    javascript_required: input.javascriptRequired,
    stealth: input.stealthAttempted ? "best_effort" : "none",
    stealth_guaranteed: false,
  };
}

export interface DirectAuthorizedReadResult {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  auth_outcome: "not_presented" | "presented_accepted" | "presented_rejected" | "presented_unknown";
  reason?: "auth_required" | "session_expired" | "http_error";
}

/**
 * Read-only HTTPS request for explicit bearer/header auth. Browser and Kuri are
 * deliberately not involved: discovery, presentation, and acceptance remain
 * separate observable facts.
 */
export async function directAuthorizedRead(
  url: string,
  options: { headers?: Record<string, string>; bearerToken?: string; timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<DirectAuthorizedReadResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("direct_authorized_read_requires_https");
  }
  const headers = new Headers(options.headers);
  if (options.bearerToken) headers.set("authorization", `Bearer ${options.bearerToken}`);
  const presented = headers.has("authorization") || headers.has("cookie");
  const response = await fetchImpl(parsed, {
    method: "GET",
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  const body = await response.text();
  const rejected = response.status === 401 || response.status === 403;
  return {
    ok: response.ok,
    status: response.status,
    url: response.url || parsed.href,
    body,
    auth_outcome: presented
      ? (rejected ? "presented_rejected" : response.ok ? "presented_accepted" : "presented_unknown")
      : "not_presented",
    ...(rejected ? { reason: presented ? "session_expired" as const : "auth_required" as const }
      : response.ok ? {} : { reason: "http_error" as const }),
  };
}

/** Return only a recovery step the observed local capabilities can execute. */
export function browserRecovery(
  reason: BrowserCapabilityReason,
  facts: { chromium_available: boolean; chromium_cdp_available: boolean; kuri_sandbox_available?: boolean },
): BrowserRecovery {
  if (reason === "chromium_unavailable") return { reason, retryable: false, next_step: "Install Chromium, then run `unbrowse setup`." };
  if (reason === "chromium_cdp_unavailable") {
    return facts.chromium_available
      ? { reason, retryable: true, next_step: "Restart the Chromium CDP session, then retry." }
      : { reason: "chromium_unavailable", retryable: false, next_step: "Install Chromium, then run `unbrowse setup`." };
  }
  if (reason === "kuri_sandbox_unavailable") {
    return facts.kuri_sandbox_available
      ? { reason, retryable: true, next_step: "Restart the Kuri sandbox, then retry." }
      : { reason, retryable: false };
  }
  if (reason === "auth_required" || reason === "session_expired") {
    return facts.chromium_available && facts.chromium_cdp_available
      ? { reason, retryable: true, next_step: "Run `unbrowse auth <login_url>` in Chromium, then retry." }
      : { reason, retryable: false };
  }
  if (reason === "empty_capture") return facts.chromium_cdp_available
    ? { reason, retryable: true, next_step: "Retry capture in the verified Chromium CDP session." }
    : { reason, retryable: false };
  return { reason, retryable: false };
}

const CHROMIUM_NAMES = new Set(["chromium", "chromium-browser", "chrome", "google-chrome", "google-chrome-stable"]);

/**
 * Fail-closed browser capability policy shared by every public surface.
 *
 * This function deliberately accepts observed facts instead of probing or
 * guessing. In particular, a missing browser runtime is never described as an
 * authentication or site-data problem.
 */
export function evaluateBrowserCapability(input: BrowserCapabilityInput): BrowserCapability {
  const requested = (input.browser ?? "chromium").trim().toLowerCase();
  // Chrome-free obscura backend switch (guarded; default path unchanged when
  // unset). When the caller selects obscura — explicitly via `browser: "obscura"`
  // or by the UNBROWSE_BROWSER_BACKEND env — the sidecar satisfies capture with
  // NEITHER Chromium NOR CDP, so the chromium_* facts below do not gate it. This
  // is the smallest correct diff: the only new outcome is "supported via obscura"
  // and it fires only under an explicit obscura selection.
  const backend = (process.env.UNBROWSE_BROWSER_BACKEND ?? "").trim().toLowerCase();
  if (requested === "obscura" || (input.browser == null && backend === "obscura")) {
    return { status: "supported", operation: input.operation, browser: "obscura" };
  }
  if (!CHROMIUM_NAMES.has(requested)) {
    return {
      status: "unavailable",
      operation: input.operation,
      reason: "unsupported_browser",
      message: `Browser '${requested || "(empty)"}' is unsupported; unbrowse browser operations support Chromium-family browsers only.`,
    };
  }
  if (!input.chromium_available) {
    return {
      status: "unavailable",
      operation: input.operation,
      reason: "chromium_unavailable",
      message: "No Chromium-family browser executable is available.",
    };
  }
  if (!input.browser_runtime_available || input.chromium_cdp_available === false) {
    return {
      status: "unavailable",
      operation: input.operation,
      reason: "chromium_cdp_unavailable",
      message: "The verified Chromium CDP runtime is unavailable.",
    };
  }
  if (input.kuri_required && input.kuri_sandbox_available === false) {
    return {
      status: "unavailable",
      operation: input.operation,
      reason: "kuri_sandbox_unavailable",
      message: "This operation requires the Kuri sandbox, which is unavailable.",
    };
  }
  if (input.requires_auth && !input.auth_available) {
    return {
      status: "auth_required",
      operation: input.operation,
      reason: "auth_required",
      message: "This operation requires an authenticated Chromium session, but none is available.",
    };
  }
  return { status: "supported", operation: input.operation, browser: "chromium" };
}
