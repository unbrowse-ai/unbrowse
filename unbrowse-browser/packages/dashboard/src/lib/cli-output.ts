/**
 * What a command printed, read for the panels. `/api/exec` runs the CLI with
 * `--json`, which prints the daemon's whole response: `{success, data, error}`.
 * The answer is inside `data`, so a panel reading the top level finds nothing.
 */
import type { ExecResult } from "./exec";

export interface CookieEntry {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface StorageEntry {
  key: string;
  value: string;
}

export type CliRead<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The `data` of a finished command. A failed command says why, so a panel never
 * shows "No cookies" for a store it could not read. A refusal by the dashboard
 * server itself has no stdout, only `error`.
 */
function readData(res: ExecResult): CliRead<Record<string, unknown>> {
  const refused = (res as { error?: unknown }).error;
  if (!res.stdout) {
    const why = res.stderr || (typeof refused === "string" ? refused : "");
    return { ok: false, error: why || "The command printed nothing" };
  }
  let response: { success?: unknown; data?: unknown; error?: unknown } | null;
  try {
    response = JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: res.stderr || "The command's output could not be read" };
  }
  if (!res.success || !response || response.success !== true) {
    const why = typeof response?.error === "string" ? response.error : res.stderr;
    return { ok: false, error: why || "The command failed" };
  }
  const data = response.data;
  if (data === null || typeof data !== "object") {
    return { ok: false, error: "The command's output could not be read" };
  }
  return { ok: true, value: data as Record<string, unknown> };
}

export function readCookies(res: ExecResult): CliRead<CookieEntry[]> {
  const data = readData(res);
  if (!data.ok) return data;
  const cookies = data.value.cookies;
  return { ok: true, value: Array.isArray(cookies) ? (cookies as CookieEntry[]) : [] };
}

/** `storage local` answers `{data: {<key>: <value>}}`: every name in it is the page's own. */
export function readStorage(res: ExecResult): CliRead<StorageEntry[]> {
  const data = readData(res);
  if (!data.ok) return data;
  const store = data.value.data;
  if (store === null || typeof store !== "object") return { ok: true, value: [] };
  return {
    ok: true,
    value: Object.entries(store).map(([key, value]) => ({ key, value: String(value) })),
  };
}

/**
 * Hands out a ticket per request; only the newest ticket is still current. A
 * read carries no id of its own, so without this the answer for the session or
 * tab just left can land after the one asked for and take its place.
 */
export function latestOnly(): () => () => boolean {
  let newest = 0;
  return () => {
    const mine = ++newest;
    return () => mine === newest;
  };
}
