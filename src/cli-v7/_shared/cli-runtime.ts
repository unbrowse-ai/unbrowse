/**
 * Shared CLI runtime helpers — extracted verbatim from src/cli.ts so the
 * cli-v7 handler ports can import them without duplicating logic.
 *
 * Semantics are preserved exactly: dotenv is loaded here (idempotent) before
 * the BASE_URL / CLI_CLIENT_ID / FRONTEND_URL consts are computed, reproducing
 * the original cli.ts load order (loadEnv() then const-from-process.env).
 */

import { config as loadEnv } from "dotenv";
import { spawn } from "node:child_process";
import { getInProcessApp } from "../../runtime/in-process-app.js";
import { getLastVendorBlock } from "../../capture/process-vendor-signal.js";

// Mirror cli.ts's top-of-module dotenv load so these consts read the same
// environment they did when defined inline in cli.ts. loadEnv is idempotent
// and does not override already-set vars, so this is safe even though cli.ts
// also calls it.
loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", quiet: true });

export const BASE_URL = process.env.UNBROWSE_URL || "http://localhost:6969";
export const CLI_CLIENT_ID = process.env.UNBROWSE_CLIENT_ID || `cli-${process.ppid || process.pid}`;
export const FRONTEND_URL = (process.env.UNBROWSE_FRONTEND_URL || process.env.PUBLIC_FRONTEND_URL || "https://www.unbrowse.ai").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export async function api(method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
  let url = path;
  let payload = body;
  if (method === "GET" && body && typeof body === "object") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    if (query) url += `${url.includes("?") ? "&" : "?"}${query}`;
    payload = undefined;
  }

  // When UNBROWSE_URL is explicitly set the caller is pointing at an external
  // server (e.g. a test stub or a remote daemon). Skip in-process Fastify and
  // make a real HTTP request so the caller's server actually receives traffic.
  if (process.env.UNBROWSE_URL) {
    const fullUrl = BASE_URL.replace(/\/+$/, "") + url;
    const fetchOpts: RequestInit = {
      method,
      headers: {
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        "x-unbrowse-client-id": CLI_CLIENT_ID,
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    };
    const timeoutMs = opts?.timeoutMs;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (controller && timeoutMs) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const res = await fetch(fullUrl, controller ? { ...fetchOpts, signal: controller.signal } : fetchOpts);
      const ct = res.headers.get("content-type") ?? "";
      const ok = res.ok;
      if (!ok && ct.includes("json")) return res.json();
      if (!ok) return { error: `HTTP ${res.status}: ${await res.text()}` };
      return res.json();
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        return { error: "cli_timeout", message: `API request exceeded ${timeoutMs}ms.` };
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Phase 0d: no HTTP, no :6969 daemon. Dispatch in-process via Fastify
  // inject against the same route surface. Kuri (the separate CDP broker)
  // holds the only live state.
  const app = await getInProcessApp();
  const injectP = app.inject({
    method: method as "GET" | "POST",
    url,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      "x-unbrowse-client-id": CLI_CLIENT_ID,
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });

  const timeoutMs = opts?.timeoutMs;
  const res =
    timeoutMs && timeoutMs > 0
      ? await Promise.race([
          injectP,
          new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
        ])
      : await injectP;
  if (res === null) {
    // Day-6 W1 (concern C): when the in-process API times out AND a
    // capture-side vendor block was tagged within the timeout window,
    // surface an actionable browse_session_open envelope instead of a
    // bare cli_timeout. Honest data: if NO vendor signal fired we
    // return the original cli_timeout (do NOT fabricate vendor:*).
    const vendor = getLastVendorBlock(timeoutMs ? timeoutMs + 5_000 : 60_000);
    if (vendor) {
      return {
        error: "cli_timeout",
        status: "browse_session_open",
        message: `In-process API exceeded ${timeoutMs}ms while ${vendor.vendor} challenge was active on ${vendor.host}.`,
        browser_block_signals: [`vendor:${vendor.vendor}`],
        next_step: "open_browse_session",
        suggested_commands: [`unbrowse go https://${vendor.host}`],
        vendor_detected: { vendor: vendor.vendor, host: vendor.host, detected_at_ms: vendor.detected_at },
      };
    }
    return { error: "cli_timeout", message: `In-process API exceeded ${timeoutMs}ms.` };
  }

  const ctRaw = res.headers["content-type"];
  const ct = Array.isArray(ctRaw) ? ctRaw.join(";") : String(ctRaw ?? "");
  const ok = res.statusCode >= 200 && res.statusCode < 300;
  if (!ok && ct.includes("json")) return res.json();
  if (!ok) return { error: `HTTP ${res.statusCode}: ${res.body}` };
  return res.json();
}

export function output(data: unknown, pretty = false): void {
  // Default to pretty when stdout is a TTY (human / agent reading interactively).
  // Subprocess pipes get compact one-line JSON (easier to parse).
  // Agents/CI can override either way via --pretty / --no-pretty.
  const usePretty = pretty || (!!process.stdout.isTTY && process.env.UNBROWSE_NO_PRETTY !== "1");
  process.stdout.write((usePretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + "\n");
}

export function die(msg: string): never {
  output({ error: msg });
  process.exit(1);
}

export function info(msg: string): void {
  process.stderr.write(`[unbrowse] ${msg}\n`);
}

export function openUrl(url: string): void {
  if (process.env.UNBROWSE_OPEN_BROWSER === "0") return;
  try {
    const cmd = process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch { /* best effort */ }
}

export async function withPendingNotice<T>(promise: Promise<T>, message: string, delayMs = 3_000): Promise<T> {
  let done = false;
  const timer = setTimeout(() => {
    if (!done) info(message);
  }, delayMs);
  try {
    return await promise;
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

function formatSavedDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function formatCostUsd(uc: number): string {
  // uc = micro-USD (1e-6 USD). 1M uc = $1.
  const usd = uc / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export function emitImpactSummary(result: Record<string, unknown>): void {
  const impact = result.impact as Record<string, unknown> | undefined;
  if (!impact) return;

  const timeSavedMs = typeof impact.time_saved_ms === "number" ? impact.time_saved_ms : 0;
  const tokensSaved = typeof impact.tokens_saved === "number" ? impact.tokens_saved : 0;
  const timeSavedPct = typeof impact.time_saved_pct === "number" ? impact.time_saved_pct : 0;
  const tokensSavedPct = typeof impact.tokens_saved_pct === "number" ? impact.tokens_saved_pct : 0;
  const costSavedUc = typeof impact.cost_saved_uc === "number" ? impact.cost_saved_uc : 0;
  const browserAvoided = impact.browser_avoided === true;
  if (timeSavedMs <= 0 && tokensSaved <= 0 && costSavedUc <= 0 && !browserAvoided) return;

  const parts: string[] = [];
  if (timeSavedMs > 0) parts.push(`${formatSavedDuration(timeSavedMs)} saved (${timeSavedPct}% faster)`);
  if (tokensSaved > 0) parts.push(`${tokensSaved.toLocaleString("en-US")} tokens saved (${tokensSavedPct}% less context)`);
  if (costSavedUc > 0) parts.push(`${formatCostUsd(costSavedUc)} saved`);
  if (browserAvoided) parts.push("browser avoided");
  info(parts.join(" • "));
}

export function emitNextActionSummary(result: Record<string, unknown>): void {
  const nextActions = Array.isArray(result.next_actions)
    ? result.next_actions as Array<Record<string, unknown>>
    : [];
  if (nextActions.length === 0) return;
  info("Likely next actions:");
  for (const action of nextActions.slice(0, 3)) {
    const command = typeof action.command === "string" ? action.command : "";
    const title = typeof action.title === "string" ? action.title : (action.endpoint_id as string | undefined) ?? "next step";
    const why = typeof action.why === "string" ? action.why : "";
    info(`  ${command || title}${why ? `  # ${why}` : ""}`);
  }
}
