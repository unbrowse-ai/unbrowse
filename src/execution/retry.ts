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