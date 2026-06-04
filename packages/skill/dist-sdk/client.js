import { errorFromStatus, UnbrowseConnectionError, UnbrowseError, UnbrowseTimeoutError, } from "./errors.js";
const DEFAULT_BASE_URL = "https://beta-api.unbrowse.ai";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const SDK_VERSION = "7.0.0-preview.1";
export class Unbrowse {
    apiKey;
    baseURL;
    timeout;
    maxRetries;
    logLevel;
    _fetch;
    defaultHeaders;
    account;
    keys;
    proxy;
    constructor(opts = {}) {
        const env = readEnv();
        this.apiKey = opts.apiKey ?? env.UNBROWSE_API_KEY;
        this.baseURL = stripTrailingSlash(opts.baseURL ?? env.UNBROWSE_BASE_URL ?? DEFAULT_BASE_URL);
        this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
        this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.logLevel = opts.logLevel ?? env.UNBROWSE_LOG ?? "off";
        this.defaultHeaders = opts.defaultHeaders ?? {};
        const f = opts.fetch ?? globalThis.fetch;
        if (typeof f !== "function") {
            throw new UnbrowseError("No fetch implementation available. Pass `fetch` in client options or run on Node 18+ / a modern browser.");
        }
        this._fetch = f.bind(globalThis);
        this.account = new AccountResource(this);
        this.keys = new KeysResource(this);
        this.proxy = new ProxyResource(this);
    }
    resolve(input, opts = {}) {
        return this.request("POST", "/v1/resolve", input, opts);
    }
    execute(input, opts = {}) {
        // Auto-idempotency on execute so a network-retry never double-charges the agent.
        const idempotencyKey = input.idempotency_key ?? opts.idempotencyKey ?? randomIdempotencyKey();
        return this.request("POST", "/v1/execute", input, { ...opts, idempotencyKey });
    }
    search(input, opts = {}) {
        return this.request("POST", "/v1/search", input, opts);
    }
    health(opts = {}) {
        return this.request("GET", "/v1/health", undefined, opts);
    }
    // Internal request driver. Public so the resource classes can call it; not part
    // of the documented surface.
    async request(method, path, body, opts) {
        const url = `${this.baseURL}${path}`;
        const headers = {
            "Accept": "application/json",
            "User-Agent": `@unbrowse/sdk/${SDK_VERSION}`,
            ...this.defaultHeaders,
            ...(opts.headers ?? {}),
        };
        if (this.apiKey)
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        if (body !== undefined && method !== "GET")
            headers["Content-Type"] = "application/json";
        if (opts.idempotencyKey)
            headers["Idempotency-Key"] = opts.idempotencyKey;
        const maxRetries = opts.maxRetries ?? this.maxRetries;
        const timeoutMs = opts.timeout ?? this.timeout;
        let lastErr;
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
                        responseBody._request_id = request_id;
                    }
                    return responseBody;
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
            }
            catch (e) {
                clearTimeout(t);
                if (e instanceof UnbrowseError)
                    throw e;
                const isAbort = e?.name === "AbortError";
                const wrapped = isAbort
                    ? new UnbrowseTimeoutError(`Request timed out after ${timeoutMs}ms`, e)
                    : new UnbrowseConnectionError(`Network error: ${e?.message ?? String(e)}`, e);
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
        throw lastErr ?? new UnbrowseError("Retries exhausted");
    }
    debug(line) {
        if (this.logLevel === "debug" || this.logLevel === "info") {
            // eslint-disable-next-line no-console
            console.log(`[unbrowse] ${line}`);
        }
    }
}
class AccountResource {
    client;
    constructor(client) {
        this.client = client;
    }
    me(opts = {}) {
        return this.client.request("GET", "/v1/account/me", undefined, opts);
    }
    credits(opts = {}) {
        return this.client.request("GET", "/v1/account/credits", undefined, opts);
    }
    sponsorStatus(opts = {}) {
        return this.client.request("GET", "/v1/account/sponsor-status", undefined, opts);
    }
}
class KeysResource {
    client;
    constructor(client) {
        this.client = client;
    }
    list(opts = {}) {
        return this.client.request("GET", "/v1/account/keys", undefined, opts);
    }
    create(input = {}, opts = {}) {
        return this.client.request("POST", "/v1/account/keys", input, opts);
    }
    revoke(keyId, opts = {}) {
        return this.client.request("DELETE", `/v1/account/keys/${encodeURIComponent(keyId)}`, undefined, opts);
    }
    rotate(keyId, opts = {}) {
        return this.client.request("POST", `/v1/account/keys/${encodeURIComponent(keyId)}/rotate`, undefined, opts);
    }
}
class ProxyResource {
    client;
    constructor(client) {
        this.client = client;
    }
    // POST /v1/proxy — worker fetches the target URL on behalf of the agent.
    // Use this when the SDK runs in a browser/edge where direct outbound fetches
    // would expose the user IP, get geo-fenced, or hit anti-bot. Pass
    // proxy:"residential" to tunnel the worker's outbound fetch through a residential proxy.
    fetch(req, opts = {}) {
        return this.client.request("POST", "/v1/proxy", req, opts);
    }
    // GET /v1/proxy — capability check. Use to decide whether to request
    // proxy:"residential" before committing to the call. Reports whether
    // the worker's residential proxy credentials are configured.
    capabilities(opts = {}) {
        return this.client.request("GET", "/v1/proxy", undefined, opts);
    }
}
// ---------- helpers ----------
function readEnv() {
    if (typeof process !== "undefined" && process.env)
        return process.env;
    return {};
}
function stripTrailingSlash(s) {
    return s.endsWith("/") ? s.slice(0, -1) : s;
}
async function parseBody(response) {
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
        try {
            return await response.json();
        }
        catch {
            return null;
        }
    }
    const text = await response.text().catch(() => "");
    return text || null;
}
function parseRetryAfter(h) {
    if (!h)
        return undefined;
    const n = Number(h);
    if (Number.isFinite(n))
        return n * 1000;
    const t = Date.parse(h);
    if (Number.isFinite(t))
        return Math.max(0, t - Date.now());
    return undefined;
}
function shouldRetry(status, attempt, max) {
    if (attempt >= max)
        return false;
    return status === 429 || status === 408 || status === 409 || status >= 500;
}
function backoffDelay(attempt) {
    // exponential backoff with full jitter; 250ms, 500ms, 1s, 2s, ... capped at 8s
    const base = Math.min(8_000, 250 * Math.pow(2, attempt));
    return Math.floor(Math.random() * base);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function randomIdempotencyKey() {
    // RFC 4122 v4-ish. Good enough for idempotency; not used for security.
    if (typeof crypto !== "undefined" && "randomUUID" in crypto)
        return crypto.randomUUID();
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 32; i++) {
        out += hex[Math.floor(Math.random() * 16)];
        if (i === 7 || i === 11 || i === 15 || i === 19)
            out += "-";
    }
    return out;
}
function combineSignals(a, b) {
    if (!b)
        return a;
    if (a.aborted)
        return a;
    if (b.aborted)
        return b;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
    return ctrl.signal;
}
