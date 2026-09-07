/**
 * Captcha solve as a SERVER-side paid tier — the same shape as the residential
 * proxy plane (egress-chain): the SECRET (the Capzy key) lives ONLY on our
 * backend, never on the client. A captcha block escalates to the backend
 * `/v1/solve` tier, billed to the agent's key per solve — exactly how a proxy
 * block escalates to the tolled `/v1/proxy` residential tier. The key is the
 * moat; the client never holds it.
 *
 *   render blocked → /v1/solve (server holds key, meters usage) → token → inject
 *
 * The unbrowse CLI still runs LOCALLY (it renders the page and injects the
 * returned token); only the solve itself is the metered backend call. Honest
 * degrade: returns null (never a fake token) when there is no agent key, the
 * server returns 402 (payment required), or any network/5xx — the caller keeps
 * its stay-blocked path and surfaces the payment/next-step signal.
 */
import { getApiKey } from "../client/index.js";

export interface CaptchaClearResult {
  /** The solved token to inject into the page's response field. */
  token: string;
  /** Always "server" — the key is backend-only by design (the paid moat). */
  source: "server";
  /** The narrowed vendor the server's solver used. */
  vendor?: string;
  /** Metered cost of this solve (USD), echoed for the receipt. */
  cost_usd?: number;
}

export interface CaptchaClearInput {
  /** Upstream vendor tag (cloudflare / recaptcha / hcaptcha / …) or "captcha_vendor". */
  vendor: string;
  /** The captured challenge HTML (the server reads data-sitekey from it). */
  body: string;
  /** The page URL the widget is rendered on (websiteURL for the solver). */
  challengeUrl: string;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  timeoutMs?: number;
}

function isDirectEgress(env: NodeJS.ProcessEnv): boolean {
  const d = env.UNBROWSE_DIRECT_EGRESS?.trim().toLowerCase();
  return d === "1" || d === "true" || d === "yes";
}

/**
 * Escalate a captcha block to the backend `/v1/solve` paid tier. The backend
 * holds the Capzy key and meters the solve to the agent's Bearer key; the
 * client never sees or needs the key. Returns the token + cost, or null on
 * honest degrade (no key / 402 / network).
 */
export async function solveCaptchaClear(input: CaptchaClearInput): Promise<CaptchaClearResult | null> {
  const env = input.env ?? process.env;
  // Direct-egress opt-out also opts out of the tolled solve tier.
  if (isDirectEgress(env)) return null;

  // No agent key → the server's /v1/solve would 402; skip the doomed round-trip.
  // (Payment-required is surfaced to the agent by the caller's next_step, same
  // as the proxy tier — never a fabricated solve.)
  const apiKey = input.apiKey ?? getApiKey();
  if (!apiKey || apiKey === "local-only") return null;

  const base = (env.UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai").replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 120_000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/solve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ vendor: input.vendor, body: input.body, url: input.challengeUrl }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null; // 402 (payment) / 5xx / etc → honest degrade
    const j = (await res.json().catch(() => null)) as
      | { token?: string; vendor?: string; cost_usd?: number }
      | null;
    if (j && j.token) {
      return { token: j.token, source: "server", vendor: j.vendor, cost_usd: j.cost_usd };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
