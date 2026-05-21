import {
  errorFromStatus,
  UnbrowseConnectionError,
  UnbrowseError,
  UnbrowseTimeoutError,
} from "./errors.js";
import type {
  AccountUsage,
  ApiKey,
  ApiKeyCreateInput,
  ApiKeyCreateResponse,
  ExecuteInput,
  ExecuteResponse,
  HealthResponse,
  RequestOptions,
  ResolveInput,
  ResolveResponse,
  SearchInput,
  SearchResponse,
  UnbrowseClientOptions,
} from "./types.js";

const DEFAULT_BASE_URL = "https://beta-api.unbrowse.ai";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const SDK_VERSION = "7.0.0-preview.1";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export class Unbrowse {
  readonly apiKey: string | undefined;
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly logLevel: NonNullable<UnbrowseClientOptions["logLevel"]>;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly defaultHeaders: Record<string, string>;

  readonly account: AccountResource;
  readonly keys: KeysResource;

  constructor(opts: UnbrowseClientOptions = {}) {
    const env = readEnv();
    this.apiKey = opts.apiKey ?? env.UNBROWSE_API_KEY;
    this.baseURL = stripTrailingSlash(opts.baseURL ?? env.UNBROWSE_BASE_URL ?? DEFAULT_BASE_URL);
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.logLevel = opts.logLevel ?? (env.UNBROWSE_LOG as UnbrowseClientOptions["logLevel"]) ?? "off";
    this.defaultHeaders = opts.defaultHeaders ?? {};
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new UnbrowseError("No fetch implementation available. Pass `fetch` in client options or run on Node 18+ / a modern browser.");
    }
    this._fetch = f.bind(globalThis);

    this.account = new AccountResource(this);
    this.keys = new KeysResource(this);
  }

  resolve(input: ResolveInput, opts: RequestOptions = {}): Promise<ResolveResponse> {
    return this.request<ResolveResponse>("POST", "/v1/resolve", input, opts);
  }

  execute(input: ExecuteInput, opts: RequestOptions = {}): Promise<ExecuteResponse> {
    // Auto-idempotency on execute so a network-retry never double-charges the agent.
    const idempotencyKey = input.idempotency_key ?? opts.idempotencyKey ?? randomIdempotencyKey();
    return this.request<ExecuteResponse>("POST", "/v1/execute", input, { ...opts, idempotencyKey });
  }

  search(input: SearchInput, opts: RequestOptions = {}): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", "/v1/search", input, opts);
  }

  health(opts: RequestOptions = {}): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/v1/health", undefined, opts);
  }

  // Internal request driver. Public so the resource classes can call it; not part
  // of the documented surface.
  async request<T>(method: string, path: string, body: unknown, opts: RequestOptions): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "User-Agent": `@unbrowse/sdk/${SDK_VERSION}`,
      ...this.defaultHeaders,
      ...(opts.headers ?? {}),
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (body !== undefined && method !== "GET") headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const maxRetries = opts.maxRetries ?? this.maxRetries;
    const timeoutMs = opts.timeout ?? this.timeout;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const signal = combineSignals(ctrl.signal, opts.signal);

      try {
        const response = await this._fetch(url, {
          method,
          headers,
          body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
          signal,
        });
        clearTimeout(t);

        const request_id = response.headers.get("x-request-id") ?? undefined;
        const responseBody = await parseBody(response);

        if (response.ok) {
          this.debug(`${method} ${path} ${response.status} req=${request_id ?? "-"} attempt=${attempt}`);
          if (responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)) {
            (responseBody as Record<string, unknown>)._request_id = request_id;
          }
          return responseBody as T;
        }

        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const err = errorFromStatus({
          status: response.status,
          body: responseBody,
          request_id,
          url,
          method,
          retry_after_ms: retryAfter,
        });
        if (shouldRetry(response.status, attempt, maxRetries)) {
          lastErr = err;
          const delay = retryAfter ?? backoffDelay(attempt);
          this.debug(`${method} ${path} ${response.status} retry-in=${delay}ms attempt=${attempt}`);
          await sleep(delay);
          continue;
        }
        throw err;
      } catch (e) {
        clearTimeout(t);
        // Re-throw API errors that already passed shouldRetry checks above.
        if (e instanceof UnbrowseError) throw e;
        const isAbort = (e as { name?: string })?.name === "AbortError";
        const wrapped = isAbort
          ? new UnbrowseTimeoutError(`Request timed out after ${timeoutMs}ms`, e)
          : new UnbrowseConnectionError(`Network error: ${(e as Error)?.message ?? String(e)}`, e);
        if (attempt < maxRetries) {
          lastErr = wrapped;
          const delay = backoffDelay(attempt);
          this.debug(`${method} ${path} network-error retry-in=${delay}ms attempt=${attempt}`);
          await sleep(delay);
          continue;
        }
        throw wrapped;
      }
    }
    // Unreachable, but TypeScript needs it.
    throw lastErr ?? new UnbrowseError("Retries exhausted");
  }

  private debug(line: string): void {
    if (this.logLevel === "debug" || this.logLevel === "info") {
      // eslint-disable-next-line no-console
      console.log(`[unbrowse] ${line}`);
    }
  }
}

class AccountResource {
  constructor(private readonly client: Unbrowse) {}
  usage(opts: RequestOptions = {}): Promise<AccountUsage> {
    return this.client.request<AccountUsage>("GET", "/v1/account/usage", undefined, opts);
  }
  sponsorStatus(opts: RequestOptions = {}): Promise<unknown> {
    return this.client.request<unknown>("GET", "/v1/account/sponsor-status", undefined, opts);
  }
}

class KeysResource {
  constructor(private readonly client: Unbrowse) {}
  list(opts: RequestOptions = {}): Promise<{ keys: ApiKey[] }> {
    return this.client.request<{ keys: ApiKey[] }>("GET", "/v1/keys", undefined, opts);
  }
  create(input: ApiKeyCreateInput, opts: RequestOptions = {}): Promise<ApiKeyCreateResponse> {
    return this.client.request<ApiKeyCreateResponse>("POST", "/v1/keys", input, opts);
  }
  revoke(id: string, opts: RequestOptions = {}): Promise<{ ok: true }> {
    return this.client.request<{ ok: true }>("DELETE", `/v1/keys/${encodeURIComponent(id)}`, undefined, opts);
  }
}

// ---------- helpers ----------

function readEnv(): Record<string, string | undefined> {
  if (typeof process !== "undefined" && process.env) return process.env as Record<string, string | undefined>;
  return {};
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function parseBody(response: Response): Promise<unknown> {
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try { return await response.json(); } catch { return null; }
  }
  const text = await response.text().catch(() => "");
  return text || null;
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return n * 1000;
  const t = Date.parse(h);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return undefined;
}

function shouldRetry(status: number, attempt: number, max: number): boolean {
  if (attempt >= max) return false;
  return status === 429 || status === 408 || status === 409 || status >= 500;
}

function backoffDelay(attempt: number): number {
  // exponential backoff with full jitter; 250ms, 500ms, 1s, 2s, ... capped at 8s
  const base = Math.min(8_000, 250 * Math.pow(2, attempt));
  return Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomIdempotencyKey(): string {
  // RFC 4122 v4-ish. Good enough for idempotency; not used for security.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += hex[Math.floor(Math.random() * 16)];
    if (i === 7 || i === 11 || i === 15 || i === 19) out += "-";
  }
  return out;
}

function combineSignals(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
  if (!b) return a;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}
