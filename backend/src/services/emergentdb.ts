import type { Env } from "../types.js";

export const EMERGENTDB_BASE = "https://api.emergentdb.com";

const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;

export class EmergentDBRequestError extends Error {
  status?: number;
  path: string;

  constructor(message: string, opts: { status?: number; path: string }) {
    super(message);
    this.name = "EmergentDBRequestError";
    this.status = opts.status;
    this.path = opts.path;
  }
}

export function isEmergentDBCreditError(err: unknown): boolean {
  return err instanceof EmergentDBRequestError
    && err.status === 402
    && /credit/i.test(err.message);
}

export function summarizeEmergentDBError(err: unknown): string {
  if (isEmergentDBCreditError(err)) return "graph_credits_required";
  return err instanceof Error ? err.message : String(err);
}

export function emergentDBTimeoutMs(env: Pick<Env, "EMERGENTDB_TIMEOUT_MS">): number {
  const raw = Number(env.EMERGENTDB_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, raw));
}

function parseErrorBody(text: string): string {
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof data.error === "string") return data.error;
    if (typeof data.message === "string") return data.message;
  } catch {
    // fall through
  }
  return text.slice(0, 300);
}

export async function emergentDBRequest<T = unknown>(
  env: Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const apiKey = env.EMERGENTDB_API_KEY?.trim();
  if (!apiKey) {
    throw new EmergentDBRequestError("EmergentDB API key is not configured", { path });
  }

  const timeoutMs = opts.timeoutMs ?? emergentDBTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${EMERGENTDB_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "unbrowse/0.1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new EmergentDBRequestError(
      aborted
        ? `EmergentDB ${path} timed out after ${timeoutMs}ms`
        : `EmergentDB ${path} request failed: ${(err as Error).message}`,
      { path },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      if (res.ok) {
        throw new EmergentDBRequestError(
          `EmergentDB ${path} returned invalid JSON: ${(err as Error).message}`,
          { path },
        );
      }
    }
  }
  if (!res.ok) {
    const reason = parseErrorBody(text);
    throw new EmergentDBRequestError(`EmergentDB ${path} failed: ${res.status} ${reason}`, {
      status: res.status,
      path,
    });
  }
  return data as T;
}
