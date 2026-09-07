/**
 * Challenge Solver Bridge — wires anti-bot challenge solvers into the
 * orchestrator's fetch/capture escalation ladder.
 *
 * When a direct-fetch gets 403/429/503 or browser capture returns
 * empty_capture (0 traffic), this module:
 *   1. Detects the anti-bot vendor from the response body/headers
 *   2. Dynamically imports the matching challenge solver
 *   3. Returns the solver result (HTML + cookies) or null
 *
 * Solvers: cf-challenge.ts (REAL), px-challenge.ts (REAL),
 * akamai-challenge.ts (REAL), kasada-challenge.ts (REAL).
 * All solvers use bundle-replay; if a sensor requires live DOM fingerprints
 * that bundle-replay cannot provide, the solver returns null and the caller
 * falls through to browser-based capture.
 */

import { classifyExecuteFailure } from "../execution/index.js";

export interface ChallengeSolverResult {
  status: number;
  html: string;
  cookies: Array<{ name: string; value: string }>;
  vendor: string;
  solver: string;
}

/**
 * Detect anti-bot vendor from a fetch response and try the matching
 * challenge solver. Returns solver output on success, null on any
 * failure path (including stub solvers that return null).
 */
export async function tryChallengeSolver(params: {
  url: string;
  body: string;
  status: number;
  headers?: Record<string, string | string[] | undefined>;
  kuriBase?: string;
  proxy?: string;
  timeoutMs?: number;
}): Promise<ChallengeSolverResult | null> {
  const { url, body, status, headers, kuriBase, proxy, timeoutMs } = params;

  // 1. Detect vendor from body + headers + status
  const verdict = classifyExecuteFailure({ status, body, headers });
  if (verdict.kind !== "vendor_blocked" || !verdict.vendor) {
    return null;
  }

  const vendor = verdict.vendor;
  const sandboxBase = kuriBase ?? process.env.KURI_BASE_URL ?? "http://127.0.0.1:8080";
  const defaultTimeout = timeoutMs ?? 15_000;

  console.log(`[challenge-solver] ${url} vendor=${vendor} — trying solver`);

  // 2. Route to matching solver
  try {
    if (vendor === "cloudflare") {
      const { solveCfAndRetry } = await import("../execution/cf-challenge.js");
      const result = await solveCfAndRetry({
        url,
        body,
        kuriBase: sandboxBase,
        ...(proxy ? { proxy } : {}),
        timeoutMs: defaultTimeout,
      });
      if (result && result.status >= 200 && result.status < 300 && result.html.length > 0) {
        console.log(`[challenge-solver] cloudflare SUCCESS: ${result.html.length} bytes`);
        return { status: result.status, html: result.html, cookies: result.cookies ?? [], vendor, solver: "cf-challenge" };
      }
      console.log(`[challenge-solver] cloudflare: solver returned no viable result`);
      return null;
    }

    if (vendor === "perimeterx") {
      const { solvePxAndRetry } = await import("../execution/px-challenge.js");
      const result = await solvePxAndRetry({
        url,
        body,
        kuriBase: sandboxBase,
        ...(proxy ? { proxy } : {}),
        timeoutMs: 30_000,
      });
      if (result && result.status >= 200 && result.status < 300 && result.html.length > 0) {
        console.log(`[challenge-solver] perimeterx SUCCESS: ${result.html.length} bytes`);
        return { status: result.status, html: result.html, cookies: result.cookies ?? [], vendor, solver: "px-challenge" };
      }
      console.log(`[challenge-solver] perimeterx: solver returned no viable result`);
      return null;
    }

    if (vendor === "akamai_bot_manager") {
      const { solveAkamaiAndRetry } = await import("../execution/akamai-challenge.js");
      const result = await solveAkamaiAndRetry({
        url,
        body,
        kuriBase: sandboxBase,
        ...(proxy ? { proxy } : {}),
        timeoutMs: defaultTimeout,
      });
      if (result && result.status >= 200 && result.status < 300 && result.html.length > 0) {
        console.log(`[challenge-solver] akamai SUCCESS: ${result.html.length} bytes`);
        return { status: result.status, html: result.html, cookies: result.cookies ?? [], vendor, solver: "akamai-challenge" };
      }
      console.log(`[challenge-solver] akamai: solver returned no viable result`);
      return null;
    }

    // Kasada — detect via x-kpsdk headers or body markers.
    // classifyExecuteFailure doesn't have Kasada patterns yet, so check manually.
    const isKasada = body && (
      /kpsdk/i.test(body) ||
      /\/x\/[a-zA-Z0-9_]+\/p\.js/i.test(body) ||
      /\/ips\.js/i.test(body)
    );
    const hasKpsdkHeader = headers && Object.keys(headers).some(
      (k) => /^x-kpsdk-(cd|ct|block)$/i.test(k),
    );
    if (isKasada || hasKpsdkHeader || vendor === "kasada") {
      const { solveKasadaAndRetry } = await import("../execution/kasada-challenge.js");
      const responseHeaders: Record<string, string> = {};
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          if (v != null) responseHeaders[k] = Array.isArray(v) ? v.join("; ") : v;
        }
      }
      const result = await solveKasadaAndRetry({
        url,
        body,
        kuriBase: sandboxBase,
        ...(proxy ? { proxy } : {}),
        timeoutMs: 30_000,
        responseHeaders,
      });
      if (result && result.status >= 200 && result.status < 300 && result.html.length > 0) {
        console.log(`[challenge-solver] kasada SUCCESS: ${result.html.length} bytes`);
        return { status: result.status, html: result.html, cookies: result.cookies ?? [], vendor: "kasada", solver: "kasada-challenge" };
      }
      console.log(`[challenge-solver] kasada: solver returned no viable result`);
      return null;
    }
  } catch (err) {
    console.log(`[challenge-solver] ${vendor} error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  return null;
}

/**
 * Fetch a URL to get the challenge page body, then try the solver.
 * Used in the empty_capture path where we don't have the initial
 * fetch response body — we need to re-fetch to get the challenge HTML.
 */
export async function fetchAndTryChallengeSolver(params: {
  url: string;
  kuriBase?: string;
  proxy?: string;
  timeoutMs?: number;
}): Promise<ChallengeSolverResult | null> {
  const { url, kuriBase, proxy, timeoutMs } = params;
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs ?? 12_000),
    });
    if (resp.status < 400) return null; // Not blocked — no solver needed
    const body = await resp.text();
    const headers: Record<string, string | string[] | undefined> = {};
    resp.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return tryChallengeSolver({
      url,
      body,
      status: resp.status,
      headers,
      kuriBase,
      proxy,
    });
  } catch {
    return null;
  }
}
