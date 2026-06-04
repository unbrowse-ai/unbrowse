/**
 * pay.sh x402 payment bridge.
 *
 * Mirrors src/payments/lobster-pay.ts (line-by-line shape) but shells
 * to the `pay` CLI (or `npx @solana/pay`) instead of `lobstercash`.
 * Pay.sh's 402 handler is `pay curl <url>` — it prepares the payment,
 * gets local TouchID signing approval, then retries with the payment
 * proof. Stablecoin-settled (USDC), server-side fee-payer for SOL, so
 * the user only needs a USDC balance.
 *
 * Wave 5 of (internal):
 * wired so that picking "pay_sh" in `unbrowse setup` (PR #690 + #691)
 * actually routes 402 responses through pay-cli at runtime, not just
 * records the user's stated preference.
 *
 * Delegation boundary:
 * - Unbrowse owns: detecting 402, passing the URL, using the result
 * - Pay.sh owns: wallet signing, TouchID gate, transaction broadcast,
 *   provider/catalog selection (when the URL is a Pay gateway URL)
 *
 * Architecture parallel to lobster-pay.ts:
 *   isPayShAvailable()    -> wallet config probe (~/.pay/ or
 *                            `pay account list` non-empty)
 *   paySh*X402Fetch()     -> shell to `pay curl <url>` + parse status
 *   payAndRetryPaySh()    -> high-level: probe + fetch + parse JSON
 *
 * Picked by `src/client/index.ts` when:
 *   1. Local agent.wallet_provider === "pay_sh" (explicit user choice
 *      via the Wave 1 prompt in cli-payment-setup.ts), OR
 *   2. pay-cli is installed + lobstercash is NOT (fallback resolution)
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PAYSH_PAY_TIMEOUT_MS = 30_000;

/**
 * Resolve the pay CLI command. Prefers the direct binary if installed
 * (pay or pay-cli, per references/setup-cli.md), falls back to npx.
 * The npx invocation passes through @solana/pay (the documented npm
 * package per Pay's official docs).
 */
function getPayShCommand(): { cmd: string; prefix: string[] } | null {
  // 1. Direct binary in PATH (modern name = `pay`).
  try {
    execFileSync("pay", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return { cmd: "pay", prefix: [] };
  } catch (_e) { /* not in PATH */ }

  // 2. Legacy/alternate binary name `pay-cli`.
  try {
    execFileSync("pay-cli", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return { cmd: "pay-cli", prefix: [] };
  } catch (_e) { /* not in PATH */ }

  // 3. Check npm global bin.
  try {
    const npmPrefix = execFileSync("npm", ["config", "get", "prefix"], { encoding: "utf8", timeout: 5_000 }).trim();
    for (const binName of ["pay", "pay-cli"]) {
      const binPath = join(npmPrefix, "bin", binName);
      if (existsSync(binPath)) {
        execFileSync(binPath, ["--version"], { stdio: "ignore", timeout: 3_000 });
        return { cmd: binPath, prefix: [] };
      }
    }
  } catch (_e) { /* npm not available */ }

  // 4. Fallback to npx @solana/pay (cold-path; first call downloads).
  try {
    execFileSync("npx", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return { cmd: "npx", prefix: ["@solana/pay"] };
  } catch (_e) { /* npx not available */ }

  return null;
}

let cachedCommand: { cmd: string; prefix: string[] } | null | undefined = undefined;
function payShCmd(): { cmd: string; prefix: string[] } | null {
  if (cachedCommand === undefined) cachedCommand = getPayShCommand();
  return cachedCommand;
}

export interface PayShResult {
  success: boolean;
  body: string;
  statusCode?: number;
  error?: string;
}

/**
 * Check if the pay CLI is available AND has a configured account.
 * Account config lives at `~/.pay/` or is reported by `pay account list`.
 * Empty config means the user has not run `pay setup` yet.
 */
export function isPayShAvailable(): boolean {
  // Cheap probe first: presence of ~/.pay/ (per `pay setup` default).
  // Some users set XDG_CONFIG_HOME; the agent's local PATH lookup +
  // an empty config will still reach `pay curl` and return its own
  // wallet-not-configured error, which we surface verbatim. So this
  // returns true when the binary is reachable, deferring the "is the
  // wallet funded" question to pay-cli itself.
  const cmd = payShCmd();
  if (!cmd) return false;
  // Optional second-stage check: existence of `~/.pay/` mirrors
  // lobster-pay.ts's `~/.lobster/agents.json` probe pattern.
  const payDir = join(process.env.HOME || homedir(), ".pay");
  if (existsSync(payDir)) return true;
  // No ~/.pay/ but the binary exists. Let the agent try (`pay curl`
  // exits clean with a helpful "run pay setup" message; surfacing
  // that to the user is better than silently returning unavailable).
  return true;
}

/**
 * Pay for an x402-gated URL via pay.sh and return the response.
 *
 * Shells out to `pay curl <url>` which handles:
 * - Reading 402 + payment terms
 * - Asking the user for TouchID approval
 * - Signing + broadcasting the USDC transfer
 * - Retrying with the payment proof
 * - Returning the paid response
 */
export function payShX402Fetch(
  url: string,
  options?: {
    jsonBody?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    sandbox?: boolean;
  },
): Promise<PayShResult> {
  return new Promise((resolve) => {
    const resolved = payShCmd();
    if (!resolved) {
      resolve({ success: false, body: "", error: "pay CLI not in PATH (install via `npx @solana/pay` or `npm i -g @solana/pay`)" });
      return;
    }
    const { cmd, prefix } = resolved;
    // `pay --sandbox curl <url>` uses an ephemeral devnet wallet
    // (per references/setup-cli.md). Useful for dry-runs; default
    // off so production calls hit the user's real account.
    const args = [...prefix];
    if (options?.sandbox) args.push("--sandbox");
    args.push("curl", url);

    if (options?.jsonBody) {
      // pay-cli accepts --json for POST bodies (mirrors curl conventions).
      args.push("--json", options.jsonBody);
    }

    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        args.push("--header", `${key}: ${value}`);
      }
    }

    const timeout = options?.timeoutMs ?? PAYSH_PAY_TIMEOUT_MS;

    execFile(cmd, args, { timeout: timeout + 5_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        console.warn(`[paysh-pay] x402 fetch failed: ${msg}`);
        resolve({ success: false, body: "", error: msg });
        return;
      }

      if (stderr) {
        for (const line of stderr.split("\n").filter(Boolean)) {
          console.log(`[paysh-pay] ${line}`);
        }
      }

      // pay-cli output format (per its --debug docs): header lines may
      // include "Status: 200" similar to lobster. When absent (raw body
      // mode), we just return the body and let the caller parse.
      const statusMatch = stdout.match(/^Status:\s*(\d+)/m);
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

      if (statusCode && statusCode >= 400) {
        resolve({ success: false, body: stdout, statusCode, error: `HTTP ${statusCode}` });
        return;
      }

      resolve({ success: true, body: stdout, statusCode });
    });
  });
}

/**
 * Pay for an x402-gated API request and return the parsed JSON response.
 *
 * High-level entry point for the pay-and-retry loop (mirrors
 * lobster-pay.ts's payAndRetry shape so src/client/index.ts can swap
 * implementations on agent.wallet_provider with no structural changes).
 * Returns null when payment fails or pay-cli is unavailable so the
 * caller can fall through to the next provider in the dispatch chain.
 */
export async function payAndRetryPaySh<T = unknown>(
  fullUrl: string,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
    sandbox?: boolean;
  },
): Promise<{ data: T; paid: true } | null> {
  if (!isPayShAvailable()) {
    console.log("[paysh-pay] pay.sh not configured — skipping payment");
    return null;
  }

  console.log(`[paysh-pay] attempting x402 payment for ${fullUrl}`);

  const result = await payShX402Fetch(fullUrl, {
    jsonBody: options?.body ? JSON.stringify(options.body) : undefined,
    headers: options?.headers,
    sandbox: options?.sandbox,
  });

  if (!result.success) {
    console.warn(`[paysh-pay] payment failed: ${result.error}`);
    return null;
  }

  try {
    // pay-cli outputs body after optional header lines (Status, Content-Type).
    // Strip header preamble by finding the first JSON delimiter.
    const raw = result.body;
    const candidates = [raw.indexOf("{"), raw.indexOf("[")].filter((i) => i >= 0);
    const jsonStart = candidates.length > 0 ? Math.min(...candidates) : -1;
    const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
    const data = JSON.parse(jsonStr) as T;
    console.log("[paysh-pay] payment successful — got paid response");
    return { data, paid: true };
  } catch (_e) {
    console.warn("[paysh-pay] paid response was not valid JSON");
    return null;
  }
}
