/**
 * Lobster.cash x402 payment bridge.
 *
 * Handles the pay-and-retry cycle:
 *   1. Receives x402 payment terms from a 402 response
 *   2. Calls `lobstercash x402 fetch <url>` to pay + retry
 *   3. Returns the paid response body
 *
 * Delegation boundary:
 * - Unbrowse owns: detecting 402, passing the URL, using the result
 * - Lobster owns: wallet signing, transaction broadcast, proof construction
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOBSTER_PAY_TIMEOUT_MS = 30_000;

/**
 * Resolve the lobster CLI command. Prefers the direct binary if
 * installed globally, otherwise falls back to npx.
 */
function getLobsterCommand(): { cmd: string; prefix: string[] } | null {
  // 1. Direct binary in PATH
  try {
    execFileSync("lobstercash", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return { cmd: "lobstercash", prefix: [] };
  } catch (_e) { /* not in PATH */ }

  // 2. Check npm global bin (often not in agent PATH)
  try {
    const npmPrefix = execFileSync("npm", ["config", "get", "prefix"], { encoding: "utf8", timeout: 5_000 }).trim();
    const lobsterPath = join(npmPrefix, "bin", "lobstercash");
    if (existsSync(lobsterPath)) {
      execFileSync(lobsterPath, ["--version"], { stdio: "ignore", timeout: 3_000 });
      return { cmd: lobsterPath, prefix: [] };
    }
  } catch (_e) { /* npm not available */ }

  return null;
}

let cachedCommand: { cmd: string; prefix: string[] } | null | undefined = undefined;
function lobsterCmd(): { cmd: string; prefix: string[] } | null {
  if (cachedCommand === undefined) cachedCommand = getLobsterCommand();
  return cachedCommand;
}

export interface LobsterPayResult {
  success: boolean;
  body: string;
  statusCode?: number;
  error?: string;
}

/**
 * Check if the lobster CLI is available and wallet is configured.
 */
export function isLobsterAvailable(): boolean {
  const agentsPath = join(process.env.HOME || homedir(), ".lobster", "agents.json");
  return existsSync(agentsPath);
}

/**
 * Pay for an x402-gated URL via lobster.cash and return the response.
 *
 * Shells out to `lobstercash x402 fetch <url>` which handles:
 * - Reading 402 + payment terms
 * - Signing + broadcasting the USDC transfer
 * - Retrying with PAYMENT-SIGNATURE header
 * - Returning the paid response
 */
export function lobsterX402Fetch(
  url: string,
  options?: {
    jsonBody?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<LobsterPayResult> {
  return new Promise((resolve) => {
    const resolved = lobsterCmd();
    if (!resolved) {
      resolve({ success: false, body: "", error: "lobstercash CLI not in PATH" });
      return;
    }
    const { cmd, prefix } = resolved;
    const args = [...prefix, "x402", "fetch", url, "--debug"];

    if (options?.jsonBody) {
      args.push("--json", options.jsonBody);
    }

    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        args.push("--header", `${key}:${value}`);
      }
    }

    const timeout = options?.timeoutMs ?? LOBSTER_PAY_TIMEOUT_MS;
    args.push("--timeout", String(timeout));

    execFile(cmd, args, { timeout: timeout + 5_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        console.warn(`[lobster-pay] x402 fetch failed: ${msg}`);
        resolve({ success: false, body: "", error: msg });
        return;
      }

      if (stderr) {
        for (const line of stderr.split("\n").filter(Boolean)) {
          console.log(`[lobster-pay] ${line}`);
        }
      }

      // Parse status from stdout header line: "Status: 200"
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
 * This is the high-level entry point for the pay-and-retry loop.
 * Returns null if payment fails or lobster is unavailable.
 */
export async function payAndRetry<T = unknown>(
  fullUrl: string,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ data: T; paid: true } | null> {
  if (!isLobsterAvailable()) {
    console.log("[lobster-pay] lobster.cash not configured — skipping payment");
    return null;
  }

  console.log(`[lobster-pay] attempting x402 payment for ${fullUrl}`);

  const result = await lobsterX402Fetch(fullUrl, {
    jsonBody: options?.body ? JSON.stringify(options.body) : undefined,
    headers: options?.headers,
  });

  if (!result.success) {
    console.warn(`[lobster-pay] payment failed: ${result.error}`);
    return null;
  }
  try {
    // lobstercash x402 fetch outputs header lines before the JSON body:
    //   x402 FETCH <url>
    //   Status: 200
    //   Content-Type: application/json
    //   <blank line>
    //   {"actual":"json",...}
    // Extract the JSON portion by finding the first '{' or '['
    const raw = result.body;
    const jsonStart = Math.min(
      ...[raw.indexOf("{"), raw.indexOf("[")].filter((i) => i >= 0),
    );
    const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
    const data = JSON.parse(jsonStr) as T;
    console.log("[lobster-pay] payment successful — got paid response");
    return { data, paid: true };
  } catch (_e) {
    console.warn("[lobster-pay] paid response was not valid JSON");
    return null;
  }
}
