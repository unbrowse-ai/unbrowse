/**
 * pay-sh — pay.sh ("pay") wallet adapter for the x402/MPP fetch path.
 *
 * pay.sh (https://pay.sh) is a payment layer for HTTP agents: it wraps a
 * command-line tool, detects an MPP or x402 HTTP-402 challenge, asks the local
 * wallet to authorize signing, and retries the request with a payment proof.
 *
 * Why a SEPARATE adapter rather than a `signViaPaySh` in x402-fetch's
 * signEnvelope() switch:
 *   - The lobster/privy/generic adapters produce an `X-PAYMENT` header that
 *     x402Fetch sets and retries. That only handles the x402 envelope shape.
 *   - pay.sh owns the WHOLE handshake (challenge -> sign -> retry), and crucially
 *     handles MPP challenges that the native x402 envelope parser cannot read.
 *   - So the pay adapter is FETCH-shaped: it re-issues the original request via
 *     `pay fetch` / `pay curl` and returns the paid response. This is exactly
 *     pay.sh's own model ("wrap the tool, handle the payment").
 *
 * Default-OFF: this rung is only used when UNBROWSE_WALLET_ADAPTER=pay is set
 * explicitly. Nothing changes for existing callers otherwise.
 *
 * Sandbox: UNBROWSE_PAY_SANDBOX=1 passes `--sandbox` to pay, which uses an
 * ephemeral localnet wallet — no real funds move. All tests run in sandbox.
 *
 * Honest sub-states (no fake-success):
 *   - pay_signed:    pay re-issued the request and returned a 2xx body
 *   - pay_no_binary: UNBROWSE_WALLET_ADAPTER=pay but `pay` is not on PATH
 *   - pay_error:     pay exited non-zero (payment refused, insufficient funds,
 *                    upstream error) — original 402 surfaced unchanged
 */

import { execFile, execFileSync } from "node:child_process";

import type { X402FetchResult } from "./x402-fetch.js";

let _payAvailable: boolean | null = null;

/** Probe `pay --version` once (3s budget) and cache. Never throws. */
export function payShAvailable(): boolean {
  if (_payAvailable !== null) return _payAvailable;
  try {
    // Pass env explicitly: bun's execFileSync ignores a mutated process.env.PATH
    // unless env is provided, so this keeps the probe honest to the caller's PATH.
    execFileSync("pay", ["--version"], { stdio: "ignore", timeout: 3_000, env: process.env });
    _payAvailable = true;
  } catch {
    _payAvailable = false;
  }
  return _payAvailable;
}

/** Test-only: reset the cached availability probe. */
export function _resetPayShAvailabilityCache(): void {
  _payAvailable = null;
}

/** UNBROWSE_PAY_SANDBOX=1|true → pass `--sandbox` to pay (ephemeral wallet). */
export function payShSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.UNBROWSE_PAY_SANDBOX?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
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

export interface PayShFetchOpts {
  /** Pass `--sandbox` to pay (ephemeral localnet wallet, no real funds). */
  sandbox?: boolean;
  /** Cost ceiling in USD (informational; x402Fetch enforces before calling). */
  max_cost_usd?: number;
  /** The original 402 response, surfaced unchanged when pay fails. */
  firstRes: Response;
  /** Hard timeout (ms) for the pay subprocess. Default 30s. */
  timeoutMs?: number;
}

/**
 * Re-issue an HTTP request through `pay`, letting pay.sh perform the full
 * 402 (MPP or x402) challenge -> sign -> retry handshake. Returns an
 * X402FetchResult so it slots into the same caller surface as x402Fetch.
 *
 * GET with no body  -> `pay [--sandbox] fetch <url> [-H "K: V"]*`
 *                      (pay's built-in HTTP client)
 * anything else      -> `pay [--sandbox] curl -sS -X <METHOD> <url> [-H ...]* [-d <body>]`
 *                      (pay's curl passthrough — full method/body support)
 */
export async function payShFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: PayShFetchOpts,
): Promise<X402FetchResult> {
  const urlStr = typeof url === "string" ? url : url.toString();
  const method = (init.method ?? "GET").toUpperCase();
  const headers = headersToObject(init.headers as FetchHeadersInit | undefined);
  const body = typeof init.body === "string" ? init.body : undefined;
  const timeout = opts.timeoutMs ?? 30_000;

  if (!payShAvailable()) {
    return {
      response: opts.firstRes,
      trace: {
        step: "x402_fetch",
        sub_state: "pay_no_binary",
        adapter: "pay",
        first_status: opts.firstRes.status,
        max_cost_usd: opts.max_cost_usd,
      },
    };
  }

  const base: string[] = opts.sandbox ? ["--sandbox"] : [];
  const headerArgs: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    headerArgs.push("-H", `${k}: ${v}`);
  }

  let args: string[];
  if (method === "GET" && body === undefined) {
    // pay fetch — built-in HTTP client.
    args = [...base, "fetch", urlStr, ...headerArgs];
  } else {
    // pay curl — passthrough to curl for full method/body support.
    args = [...base, "curl", "-sS", "-X", method, urlStr, ...headerArgs];
    if (body !== undefined) args.push("-d", body);
  }

  const run = (): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        "pay",
        args,
        { timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", env: process.env },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code)
              : err
                ? 1
                : 0;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await run();
  } catch (e) {
    return {
      response: opts.firstRes,
      trace: {
        step: "x402_fetch",
        sub_state: "pay_error",
        adapter: "pay",
        error: e instanceof Error ? e.message : String(e),
        first_status: opts.firstRes.status,
        max_cost_usd: opts.max_cost_usd,
      },
    };
  }

  if (result.code !== 0) {
    return {
      response: opts.firstRes,
      trace: {
        step: "x402_fetch",
        sub_state: "pay_error",
        adapter: "pay",
        error: (result.stderr || result.stdout || `pay exited ${result.code}`).slice(0, 500),
        first_status: opts.firstRes.status,
        max_cost_usd: opts.max_cost_usd,
      },
    };
  }

  // pay exited 0 — payment succeeded (or the URL wasn't gated). stdout = body.
  return {
    response: new Response(result.stdout, {
      status: 200,
      headers: { "content-type": opts.firstRes.headers.get("content-type") ?? "text/plain" },
    }),
    trace: {
      step: "x402_fetch",
      sub_state: "pay_signed",
      adapter: "pay",
      first_status: opts.firstRes.status,
      retry_status: 200,
      max_cost_usd: opts.max_cost_usd,
    },
  };
}
