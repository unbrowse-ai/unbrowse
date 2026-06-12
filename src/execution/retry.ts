const RETRYABLE_STATUSES = new Set([500, 502, 503, 504, 429]);
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}

/**
 * Wrap an async function with exponential backoff retry.
 * Only retries if isRetryable returns true.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  isRetryable: (result: T) => boolean,
  opts?: RetryOptions
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? MAX_RETRIES;
  const baseDelay = opts?.baseDelay ?? BASE_DELAY_MS;
  const maxDelay = opts?.maxDelay ?? MAX_DELAY_MS;

  let lastResult: T | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await fn();
    lastResult = result;

    if (!isRetryable(result) || attempt === maxRetries) {
      return result;
    }

    // Exponential backoff with jitter
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    const jitter = delay * 0.5 * Math.random();
    await new Promise((r) => setTimeout(r, delay + jitter));
  }

  return lastResult!;
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

// Parse HTTP Retry-After (RFC 7231 §7.1.3): delta-seconds or HTTP-date, returns ms or null.
export function parseRetryAfter(
  headers: Record<string, string | string[] | undefined>,
): number | null {
  if (!headers || typeof headers !== "object") return null;
  let raw: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "retry-after") {
      const v = headers[key];
      raw = Array.isArray(v) ? v[0] : v;
      break;
    }
  }
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;

  // delta-seconds form (non-negative integer)
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return null;
  }

  // HTTP-date form
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const delta = parsed - Date.now();
  // Past dates collapse to 0 (server says retry immediately).
  return delta > 0 ? delta : 0;
}
