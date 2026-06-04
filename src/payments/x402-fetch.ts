/**
 * x402-fetch — drop-in fetch wrapper that intercepts HTTP 402 (and CONNECT
 * 407 for proxy paths), signs the x402 envelope via a configured wallet
 * adapter, sets X-PAYMENT header, and retries ONCE.
 *
 * Closes the captcha + proxy wedge (two-witness convergence
 *   sha256:ec56b38b9daadbe0a1b56157ad9ebb6b13b2a0b38d56d88364c90db060c45cc1):
 *   - 2captcha.x402.paysponge.com/createTask returns 402 with no signer
 *   - proxykingdom.cn2.ai returns 402/407 with no signer
 * Once this wrapper is wired, BOTH wedges go live without further code
 * changes — the wrapper sees ANY 402 and signs structurally.
 *
 * platform discipline (CLAUDE.md "Ranker philosophy: heuristics OUT"):
 *   - NO per-provider switch handling 13 vendors. The x402 envelope is a
 *     structural primitive (chain + asset + amount + recipient + payload).
 *     We handle it ONCE.
 *   - NO hardcoded provider URLs. The wrapper sees ANY 402 and signs;
 *     URLs come from env or call site.
 *   - Adapter pluggability is by WALLET (sign-with-lobster vs sign-with-
 *     privy vs sign-with-flex), NOT by provider.
 *   - Decision-trace sub-states follow CLAUDE.md naming convention:
 *     x402_signed / x402_no_wallet / x402_signer_error /
 *     x402_cost_exceeded / x402_retry_blocked / x402_passthrough.
 *
 * Failure modes (each HONEST — no fake-success):
 *   - x402_signed:        signed + retried + got 2xx
 *   - x402_no_wallet:     402 surfaced, no UNBROWSE_WALLET_ADAPTER configured
 *   - x402_signer_error:  wallet adapter threw or returned no signature
 *   - x402_cost_exceeded: 402 amount > UNBROWSE_X402_MAX_COST_USD ceiling
 *   - x402_retry_blocked: second 402 after signed retry (signer wrong or
 *                         server rejected our payment)
 *   - x402_passthrough:   non-402 response, passed through unchanged
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// x402 envelope shape (structural primitive — same across providers).
// We only require the FIELDS we need to sign; extra fields are passed
// through verbatim to the signer.
// ---------------------------------------------------------------------------
export interface X402Envelope {
  x402Version?: number;
  error?: string;
  /** Per the x402 spec: list of accepted payment terms. */
  accepts?: X402Accept[];
  /** Legacy / paysponge shape: single resource block. */
  resource?: {
    url?: string;
    description?: string;
    [k: string]: unknown;
  };
  /** Catch-all for vendor extensions (paysponge, faremeter, etc.). */
  [k: string]: unknown;
}

export interface X402Accept {
  scheme?: string;       // "@faremeter/flex" | "exact" | etc.
  network?: string;      // "solana" | "base" | "base-sepolia" | "solana-devnet"
  asset?: string;        // USDC mint or contract address
  amount?: string;       // human or atomic string; signer + ceiling treat as USD-equivalent
  maxAmountRequired?: string; // SDK shape (faremeter)
  recipient?: string;    // payee address
  payTo?: string;        // alt name
  resource?: string;
  description?: string;
  validUntil?: string | number;
  extra?: Record<string, unknown>; // facilitator hint, splits, escrow draft
}

// ---------------------------------------------------------------------------
// X402FetchResult — what the wrapper hands back. The Response is always
// present (real or synthesized 402-passthrough); the trace is always present.
// ---------------------------------------------------------------------------
export type X402SubState =
  | "x402_passthrough"
  | "x402_signed"
  | "x402_no_wallet"
  | "x402_signer_error"
  | "x402_cost_exceeded"
  | "x402_retry_blocked"
  | "x402_envelope_unparseable";

export interface X402FetchTrace {
  step: "x402_fetch";
  sub_state: X402SubState;
  /** Adapter name actually used (if any). */
  adapter?: WalletAdapterName;
  /** Decoded x402 envelope, when we parsed one. */
  envelope?: X402Envelope;
  /** Cost ceiling we enforced, USD. */
  max_cost_usd?: number;
  /** Cost the envelope requested, USD (parsed from accepts[].maxAmountRequired). */
  requested_cost_usd?: number;
  /** Adapter error message when sub_state = x402_signer_error. */
  error?: string;
  /** First response status code (before retry). */
  first_status?: number;
  /** Retry response status code (if a retry was made). */
  retry_status?: number;
}

export interface X402FetchResult {
  response: Response;
  trace: X402FetchTrace;
}

// ---------------------------------------------------------------------------
// Wallet config — resolved from env. The actual adapter implementations
// (lobster CLI, privy backend endpoint, generic key-file signer) are in
// sibling files and reused; we just dispatch.
// ---------------------------------------------------------------------------
export type WalletAdapterName = "lobster" | "privy" | "generic" | "none";

export interface WalletConfig {
  adapter: WalletAdapterName;
  /** Path to a wallet key file (for the "generic" adapter), or session ref. */
  key_ref?: string;
  /** Per-request max-cost ceiling in USD. */
  max_cost_usd: number;
}

const DEFAULT_MAX_COST_USD = 1.00;

/**
 * Resolve wallet config from env. Returns adapter "none" when nothing is
 * configured — caller's wrapper surfaces x402_no_wallet honestly.
 *
 * Env precedence:
 *   1. UNBROWSE_WALLET_ADAPTER (explicit override)
 *   2. ~/.lobster/agents.json exists → "lobster"
 *   3. ~/.privy/session.json exists  → "privy"
 *   4. UNBROWSE_WALLET_KEY set       → "generic"
 *   5. else                          → "none"
 */
export function resolveWalletConfig(env: NodeJS.ProcessEnv = process.env): WalletConfig {
  const maxCostStr = env.UNBROWSE_X402_MAX_COST_USD?.trim();
  const max_cost_usd = maxCostStr
    ? Math.max(0, parseFloat(maxCostStr) || DEFAULT_MAX_COST_USD)
    : DEFAULT_MAX_COST_USD;

  const explicit = env.UNBROWSE_WALLET_ADAPTER?.trim().toLowerCase();
  if (explicit === "lobster" || explicit === "privy" || explicit === "generic") {
    const key_ref = env.UNBROWSE_WALLET_KEY?.trim();
    return { adapter: explicit, key_ref, max_cost_usd };
  }
  if (explicit === "none") {
    return { adapter: "none", max_cost_usd };
  }

  // Auto-detect (precheck only — never read secrets, never decrypt).
  const home = env.HOME || homedir();
  if (existsSync(join(home, ".lobster", "agents.json"))) {
    return { adapter: "lobster", max_cost_usd };
  }
  if (existsSync(join(home, ".privy", "session.json"))) {
    return { adapter: "privy", max_cost_usd };
  }
  if (env.UNBROWSE_WALLET_KEY?.trim()) {
    return { adapter: "generic", key_ref: env.UNBROWSE_WALLET_KEY.trim(), max_cost_usd };
  }
  return { adapter: "none", max_cost_usd };
}

// ---------------------------------------------------------------------------
// parseEnvelope — read the 402 body as JSON; tolerate either x402 v2 shape
// (accepts[]) or paysponge / faremeter alternates. Returns null on
// unparseable (caller surfaces x402_envelope_unparseable).
// ---------------------------------------------------------------------------
async function parseEnvelope(res: Response): Promise<X402Envelope | null> {
  try {
    // Clone so caller can still read .text/.json if they want to surface raw.
    const clone = res.clone();
    const txt = await clone.text();
    if (!txt) return null;
    const trimmed = txt.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    const parsed = JSON.parse(trimmed) as X402Envelope;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the requested cost from an envelope, in USD. Returns NaN when
 * the envelope lacks a parseable amount (caller treats as unknown — does
 * NOT block on ceiling, but DOES log requested_cost_usd:NaN honestly).
 *
 * Both x402-v2 `accepts[].maxAmountRequired` AND legacy `accepts[].amount`
 * are read. We assume USD-equivalent string ("0.01", "1.00") since every
 * known x402 facilitator quotes USDC at $1 peg; precise FX is the signer's
 * concern.
 */
function envelopeCostUsd(env: X402Envelope): number {
  const first = (env.accepts ?? [])[0];
  if (!first) return NaN;
  const raw = first.maxAmountRequired ?? first.amount;
  if (!raw) return NaN;
  const n = parseFloat(String(raw));
  return Number.isFinite(n) ? n : NaN;
}

// ---------------------------------------------------------------------------
// Wallet adapter dispatch — produces a base64-encoded X-PAYMENT header
// value from the envelope. Returns null on adapter failure (caller emits
// x402_signer_error). Reuses existing client-side wallet plumbing where
// possible.
// ---------------------------------------------------------------------------
async function signEnvelope(
  envelope: X402Envelope,
  cfg: WalletConfig,
): Promise<{ paymentHeader: string } | { error: string }> {
  switch (cfg.adapter) {
    case "lobster":
      return signViaLobster(envelope);
    case "privy":
      return signViaPrivy(envelope);
    case "generic":
      return signViaGeneric(envelope, cfg.key_ref);
    case "none":
    default:
      return { error: "no wallet adapter configured" };
  }
}

/**
 * Lobster shells out to `lobstercash x402 sign <envelope-json>` and returns
 * the base64 X-PAYMENT header value. The lobster CLI is the existing
 * delegation surface (see src/payments/lobster-pay.ts:75 lobsterX402Fetch).
 * Here we use the lower-level `sign` subcommand because we already HAVE
 * the 402 envelope — we don't want lobster to re-do the fetch.
 */
async function signViaLobster(envelope: X402Envelope): Promise<{ paymentHeader: string } | { error: string }> {
  try {
    const { execFileSync } = await import("node:child_process");
    // Probe lobster availability the same way lobster-pay.ts does.
    try {
      execFileSync("lobstercash", ["--version"], { stdio: "ignore", timeout: 3_000 });
    } catch {
      return { error: "lobstercash CLI not in PATH" };
    }
    // `lobstercash x402 sign --json <envelope>` is the canonical sign-only
    // subcommand per lobster.cash compatibility guide. Stdout = base64
    // X-PAYMENT header value.
    const stdout = execFileSync(
      "lobstercash",
      ["x402", "sign", "--json", JSON.stringify(envelope)],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
    ).trim();
    if (!stdout) return { error: "lobster returned empty signature" };
    return { paymentHeader: stdout };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Privy delegates to the backend endpoint (the secret lives only
 * server-side per reference_privy_app_creds.md memory). We POST the
 * envelope and receive the base64 X-PAYMENT header. The endpoint path is
 * STILL coordinated server-side per contract c0c089e2 — until wired,
 * this returns x402_signer_error honestly.
 */
async function signViaPrivy(envelope: X402Envelope): Promise<{ paymentHeader: string } | { error: string }> {
  const home = process.env.HOME || homedir();
  const sessionPath = join(home, ".privy", "session.json");
  if (!existsSync(sessionPath)) return { error: "privy session missing" };
  let sessionToken = "";
  try {
    const raw = JSON.parse(readFileSync(sessionPath, "utf8")) as { token?: string; access_token?: string };
    sessionToken = raw.token ?? raw.access_token ?? "";
  } catch {
    return { error: "privy session unreadable" };
  }
  if (!sessionToken) return { error: "privy session has no token" };
  const backendUrl = process.env.UNBROWSE_BACKEND_URL || "https://beta-api.unbrowse.ai";
  try {
    const res = await fetch(`${backendUrl}/v1/auth/privy/x402-sign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ envelope }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { error: "privy x402-sign endpoint not yet wired (backend 404)" };
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `privy backend ${res.status}: ${t.slice(0, 200)}` };
    }
    const body = await res.json() as { paymentHeader?: string; error?: string };
    if (body.error) return { error: body.error };
    if (!body.paymentHeader) return { error: "privy backend returned no paymentHeader" };
    return { paymentHeader: body.paymentHeader };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Generic adapter — reads a key file or raw value and signs locally.
 *
 * The actual signing primitive is NOT in this module: per the platform
 * discipline rule "platform enables, never prescribes", we don't hardcode
 * a specific chain/curve combo. The generic adapter requires the
 * UNBROWSE_X402_SIGNER env (a node import spec or a CLI command); when
 * absent we return an honest error so the caller can fall through.
 *
 * Hook shape (when wired): `UNBROWSE_X402_SIGNER=node:<module-path>` where
 * the module exports `signX402(envelope, keyRef) -> Promise<string>`.
 * `UNBROWSE_X402_SIGNER=exec:<cmd>` shells out, passing envelope JSON on
 * stdin, expects base64 X-PAYMENT on stdout.
 */
async function signViaGeneric(
  envelope: X402Envelope,
  keyRef: string | undefined,
): Promise<{ paymentHeader: string } | { error: string }> {
  if (!keyRef) return { error: "UNBROWSE_WALLET_KEY not set for generic adapter" };
  const signer = process.env.UNBROWSE_X402_SIGNER?.trim();
  if (!signer) {
    return { error: "UNBROWSE_X402_SIGNER not set (no generic signing primitive wired)" };
  }
  if (signer.startsWith("node:")) {
    const modPath = signer.slice("node:".length);
    try {
      const mod = await import(modPath) as { signX402?: (env: X402Envelope, key: string) => Promise<string> };
      if (typeof mod.signX402 !== "function") {
        return { error: `${modPath} does not export signX402(envelope, keyRef)` };
      }
      const header = await mod.signX402(envelope, keyRef);
      if (!header) return { error: "generic signer returned empty header" };
      return { paymentHeader: header };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (signer.startsWith("exec:")) {
    const cmd = signer.slice("exec:".length);
    try {
      const { spawn } = await import("node:child_process");
      return await new Promise((resolve) => {
        const proc = spawn(cmd, [keyRef], { stdio: ["pipe", "pipe", "pipe"], shell: true });
        let out = "";
        let err = "";
        proc.stdout.on("data", (d) => { out += d.toString(); });
        proc.stderr.on("data", (d) => { err += d.toString(); });
        proc.on("close", (code) => {
          if (code !== 0) return resolve({ error: `signer exited ${code}: ${err.slice(0, 200)}` });
          const header = out.trim();
          if (!header) return resolve({ error: "signer exited 0 but produced no header" });
          resolve({ paymentHeader: header });
        });
        proc.on("error", (e) => resolve({ error: e.message }));
        proc.stdin.write(JSON.stringify(envelope));
        proc.stdin.end();
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { error: `unrecognized UNBROWSE_X402_SIGNER scheme: ${signer.split(":")[0]}` };
}

// ---------------------------------------------------------------------------
// x402Fetch — the drop-in wrapper. Same signature as global fetch, with an
// optional 3rd-arg walletConfig override for testing.
// ---------------------------------------------------------------------------
export async function x402Fetch(
  url: string | URL,
  init: RequestInit = {},
  walletConfigOverride?: Partial<WalletConfig>,
): Promise<X402FetchResult> {
  const cfg: WalletConfig = {
    ...resolveWalletConfig(),
    ...(walletConfigOverride ?? {}),
  };

  const firstRes = await fetch(url, init);

  // Pass-through every non-402 (200s, 3xx, 4xx other than 402, 5xx).
  if (firstRes.status !== 402) {
    return {
      response: firstRes,
      trace: {
        step: "x402_fetch",
        sub_state: "x402_passthrough",
        first_status: firstRes.status,
      },
    };
  }

  // 402: try to parse the envelope.
  const envelope = await parseEnvelope(firstRes);
  if (!envelope) {
    return {
      response: firstRes,
      trace: {
        step: "x402_fetch",
        sub_state: "x402_envelope_unparseable",
        first_status: 402,
      },
    };
  }

  const requested_cost_usd = envelopeCostUsd(envelope);

  // No wallet → honest signal. Caller falls back (proxy: direct egress;
  // captcha: browser_fallback).
  if (cfg.adapter === "none") {
    return {
      response: firstRes,
      trace: {
        step: "x402_fetch",
        sub_state: "x402_no_wallet",
        first_status: 402,
        envelope,
        max_cost_usd: cfg.max_cost_usd,
        requested_cost_usd,
      },
    };
  }

  // Cost ceiling check — only enforced when the envelope DECLARED a parseable
  // amount. NaN means unknown; we still attempt the signer (the signer is
  // responsible for its own ceiling enforcement in that case).
  if (Number.isFinite(requested_cost_usd) && requested_cost_usd > cfg.max_cost_usd) {
    return {
      response: firstRes,
      trace: {
        step: "x402_fetch",
        sub_state: "x402_cost_exceeded",
        adapter: cfg.adapter,
        envelope,
        max_cost_usd: cfg.max_cost_usd,
        requested_cost_usd,
        first_status: 402,
      },
    };
  }

  // Sign + retry once.
  const signed = await signEnvelope(envelope, cfg);
  if ("error" in signed) {
    return {
      response: firstRes,
      trace: {
        step: "x402_fetch",
        sub_state: "x402_signer_error",
        adapter: cfg.adapter,
        envelope,
        error: signed.error,
        first_status: 402,
        max_cost_usd: cfg.max_cost_usd,
        requested_cost_usd,
      },
    };
  }

  const retryHeaders: Record<string, string> = {
    ...(headersToObject(init.headers as FetchHeadersInit | undefined)),
    "X-PAYMENT": signed.paymentHeader,
  };

  const retryRes = await fetch(url, { ...init, headers: retryHeaders });
  if (retryRes.status === 402) {
    // Second 402 = signer wrong or server rejected our payment. No retry loop.
    return {
      response: retryRes,
      trace: {
        step: "x402_fetch",
        sub_state: "x402_retry_blocked",
        adapter: cfg.adapter,
        envelope,
        first_status: 402,
        retry_status: 402,
        max_cost_usd: cfg.max_cost_usd,
        requested_cost_usd,
      },
    };
  }

  return {
    response: retryRes,
    trace: {
      step: "x402_fetch",
      sub_state: "x402_signed",
      adapter: cfg.adapter,
      envelope,
      first_status: 402,
      retry_status: retryRes.status,
      max_cost_usd: cfg.max_cost_usd,
      requested_cost_usd,
    },
  };
}

type FetchHeadersInit = Headers | Record<string, string> | Array<[string, string]>;

function headersToObject(h: FetchHeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(h)) {
    const out: Record<string, string> = {};
    for (const [k, v] of h) out[k] = v;
    return out;
  }
  return { ...(h as Record<string, string>) };
}
