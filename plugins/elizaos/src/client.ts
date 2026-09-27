// Settings and the hosted MCP client. Every call goes to the hosted Unbrowse remote MCP through @unbrowse/sdk
// (bundled into dist, so the published package has no workspace dependency).
import { UnbrowseError, UnbrowseMcp, resultText, type McpToolResult } from "@unbrowse/sdk";
import type { IAgentRuntime } from "@elizaos/core";

export const PLUGIN_NAME = "unbrowse";
export const DEFAULT_MCP_URL = "https://unbrowse.ai/mcp";

const env = (name: string): string | undefined => (typeof process !== "undefined" ? process.env?.[name] : undefined) || undefined;

/** A setting from the character (secrets, settings, settings.secrets) or the runtime's env, then process.env. */
export function setting(runtime: IAgentRuntime, key: string): string | undefined {
  let value: unknown;
  try {
    value = runtime.getSetting?.(key);
  } catch {
    value = undefined;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return env(key);
}

export function hasApiKey(runtime: IAgentRuntime): boolean {
  return Boolean(setting(runtime, "UNBROWSE_API_KEY"));
}

/** A client bound to this runtime's settings. Uses `runtime.fetch` when the host provides one. */
export function mcpFor(runtime: IAgentRuntime): UnbrowseMcp {
  const hostFetch = (runtime as unknown as { fetch?: typeof globalThis.fetch }).fetch;
  return new UnbrowseMcp({
    apiKey: setting(runtime, "UNBROWSE_API_KEY"),
    url: setting(runtime, "UNBROWSE_MCP_URL") ?? DEFAULT_MCP_URL,
    endUser: setting(runtime, "UNBROWSE_END_USER"),
    client: "elizaos",
    fetch: typeof hostFetch === "function" ? (input, init) => hostFetch(input, init) : (input, init) => globalThis.fetch(input, init),
  });
}

export class MissingKeyError extends Error {
  readonly code = "missing_api_key";
  constructor() {
    super("UNBROWSE_API_KEY is not set. Add it to the character's secrets (or the environment); create a key at https://unbrowse.ai/app.");
  }
}

/** Calls one hosted tool. Refuses early when no key is configured instead of sending an unauthenticated call. */
export async function callTool(runtime: IAgentRuntime, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (!hasApiKey(runtime)) throw new MissingKeyError();
  return mcpFor(runtime).callTool(name, args);
}

export type ErrorInfo = { code: string; message: string; retryAfter?: number; url?: string; text: string };

function findNumber(obj: unknown, key: string, depth = 0): number | undefined {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  const rec = obj as Record<string, unknown>;
  if (typeof rec[key] === "number") return rec[key] as number;
  for (const v of Object.values(rec)) {
    const found = findNumber(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findUrl(obj: unknown, depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 5) return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of ["url", "topUp", "extend", "signInUrl"]) if (typeof rec[k] === "string" && /^https?:\/\//.test(rec[k] as string)) return rec[k] as string;
  for (const v of Object.values(rec)) {
    const found = findUrl(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** A user-facing account of any failure: the server's error code, and what to do about it. Never includes the key. */
export function describeError(err: unknown): ErrorInfo {
  if (err instanceof MissingKeyError) return { code: err.code, message: err.message, text: err.message };
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof UnbrowseError ? err.code : (err as { code?: string })?.code ?? "error";
  const status = err instanceof UnbrowseError ? err.status : undefined;
  const body = err instanceof UnbrowseError ? err.body : undefined;
  if (code === "browser_capacity") {
    const retryAfter = findNumber(body, "retryAfter") ?? 30;
    return { code, message, retryAfter, text: `Every Unbrowse cloud browser is busy right now. Try again in about ${retryAfter} seconds.` };
  }
  if (status === 401 || code === "invalid_token" || code === "unauthorized" || code === "rpc_-32001") {
    return { code: code === "http_error" ? "invalid_token" : code, message, text: `Unbrowse rejected the API key (${message}). Replace UNBROWSE_API_KEY with a valid key from https://unbrowse.ai/app.` };
  }
  const url = findUrl(body);
  if (code === "credential_required" || code === "login_required") {
    return { code, message, url, text: `This site needs a saved login. ${url ? `Save it here (the agent never sees the password): ${url}` : message}` };
  }
  if (code === "quota_exceeded" || code === "insufficient_paid_credits" || code === "rpc_-32042") {
    return { code, message, url, text: `Unbrowse usage limit reached: ${message}${url ? ` Top up or extend: ${url}` : ""}` };
  }
  return { code, message, url, text: `Unbrowse error (${code}): ${message}` };
}

export { resultText, UnbrowseError };
export type { McpToolResult };
