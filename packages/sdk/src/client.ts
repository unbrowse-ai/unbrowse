import type {
  ExecuteInput,
  ExecuteResponse,
  FeedbackInput,
  FeedbackResponse,
  HealthResponse,
  LoginInput,
  LoginResponse,
  RequestOptions,
  ResolveInput,
  ResolveResponse,
  SearchDomainInput,
  SearchInput,
  SearchResponse,
  SkillManifest,
  StatsResponse,
  StealAuthInput,
  StealAuthResponse,
  UnbrowseClientOptions,
} from "./contracts.js";
import { UnbrowseApiError } from "./errors.js";

type JsonRecord = Record<string, unknown>;

function readEnv(name: string): string | undefined {
  const globalProcess = typeof globalThis === "object" && "process" in globalThis
    ? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    : undefined;
  if (!globalProcess?.env) return undefined;
  const value = globalProcess.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? readEnv("UNBROWSE_URL") ?? "http://localhost:6969").replace(/\/+$/, "");
}

function isResolveResponse(value: ExecuteInput | ResolveResponse): value is ResolveResponse {
  return "trace" in value;
}

function resolveSkillId(value: string | ExecuteInput | ResolveResponse): string {
  if (typeof value === "string") return value;
  if ("skillId" in value && typeof (value as ExecuteInput).skillId === "string") {
    return (value as ExecuteInput).skillId;
  }
  if (!isResolveResponse(value)) {
    throw new Error("Could not determine skill_id from execute input");
  }
  const fromSkill = value.skill?.skill_id;
  if (typeof fromSkill === "string" && fromSkill.length > 0) return fromSkill;
  const fromTrace = value.trace?.skill_id;
  if (typeof fromTrace === "string" && fromTrace.length > 0) return fromTrace;
  throw new Error("Could not determine skill_id from execute input");
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function buildAbortSignal(timeoutMs: number | undefined, signal: AbortSignal | undefined): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  if (!timeoutMs && !signal) return { signal, cleanup: () => {} };

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  const timer = timeoutMs ? setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs) : undefined;

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

export class Unbrowse {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly clientId?: string;
  private readonly defaultHeaders?: HeadersInit;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(options: UnbrowseClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey ?? readEnv("UNBROWSE_API_KEY");
    this.clientId = options.clientId;
    this.defaultHeaders = options.headers;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(this.defaultHeaders);
    headers.set("Accept", "application/json");
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (this.clientId) headers.set("x-unbrowse-client-id", this.clientId);
    if (options.headers) {
      const extra = new Headers(options.headers);
      extra.forEach((value, key) => headers.set(key, value));
    }

    const { signal, cleanup } = buildAbortSignal(options.timeoutMs ?? this.timeoutMs, options.signal);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const data = await parseResponseBody(response);
      if (!response.ok) {
        const message =
          typeof data === "object" && data && "error" in data && typeof (data as JsonRecord).error === "string"
            ? String((data as JsonRecord).error)
            : `${method} ${path} failed with ${response.status}`;
        throw new UnbrowseApiError(message, {
          status: response.status,
          path,
          data,
          headers: response.headers,
        });
      }
      return data as T;
    } finally {
      cleanup();
    }
  }

  async resolve(input: ResolveInput, options?: RequestOptions): Promise<ResolveResponse> {
    const body: JsonRecord = {
      intent: input.intent,
      params: { ...(input.params ?? {}) },
      context: { ...(input.context ?? {}) },
    };
    if (input.url) {
      const params = body.params as JsonRecord;
      const context = body.context as JsonRecord;
      if (typeof params.url !== "string") params.url = input.url;
      if (typeof context.url !== "string") context.url = input.url;
    }
    if (input.projection) body.projection = input.projection;
    if (input.confirmUnsafe !== undefined) body.confirm_unsafe = input.confirmUnsafe;
    if (input.dryRun !== undefined) body.dry_run = input.dryRun;
    if (input.forceCapture !== undefined) body.force_capture = input.forceCapture;
    return this.request<ResolveResponse>("POST", "/v1/intent/resolve", body, options);
  }

  async execute(skill: string | ExecuteInput | ResolveResponse, input: Omit<ExecuteInput, "skillId"> = {}, options?: RequestOptions): Promise<ExecuteResponse> {
    const skillId = resolveSkillId(skill);
    const bodyInput = typeof skill === "object" && "skillId" in skill ? skill : input;
    const body: JsonRecord = {};
    if (bodyInput.params) body.params = bodyInput.params;
    if (bodyInput.projection) body.projection = bodyInput.projection;
    if (bodyInput.confirmUnsafe !== undefined) body.confirm_unsafe = bodyInput.confirmUnsafe;
    if (bodyInput.dryRun !== undefined) body.dry_run = bodyInput.dryRun;
    if (bodyInput.intent) body.intent = bodyInput.intent;
    if (bodyInput.contextUrl) body.context_url = bodyInput.contextUrl;
    return this.request<ExecuteResponse>("POST", `/v1/skills/${encodeURIComponent(skillId)}/execute`, body, options);
  }

  async getSkill(skillId: string, options?: RequestOptions): Promise<SkillManifest> {
    return this.request<SkillManifest>("GET", `/v1/skills/${encodeURIComponent(skillId)}`, undefined, options);
  }

  async login(input: LoginInput, options?: RequestOptions): Promise<LoginResponse> {
    return this.request<LoginResponse>("POST", "/v1/auth/login", { url: input.url }, options);
  }

  async importAuth(input: StealAuthInput, options?: RequestOptions): Promise<StealAuthResponse> {
    return this.request<StealAuthResponse>("POST", "/v1/auth/steal", {
      url: input.url,
      browser: input.browser,
      chrome_profile: input.chromeProfile,
      firefox_profile: input.firefoxProfile,
      chromium_profile: input.chromiumProfile,
      chromium_user_data_dir: input.chromiumUserDataDir,
      chromium_cookie_db_path: input.chromiumCookieDbPath,
      safe_storage_service: input.safeStorageService,
      browser_name: input.browserName,
    }, options);
  }

  async stealAuth(input: StealAuthInput, options?: RequestOptions): Promise<StealAuthResponse> {
    return this.importAuth(input, options);
  }

  async search(input: SearchInput, options?: RequestOptions): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", "/v1/search", {
      intent: input.intent,
      k: input.k,
    }, options);
  }

  async searchDomain(input: SearchDomainInput, options?: RequestOptions): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", "/v1/search/domain", {
      intent: input.intent,
      domain: input.domain,
      k: input.k,
    }, options);
  }

  async feedback(input: FeedbackInput, options?: RequestOptions): Promise<FeedbackResponse> {
    return this.request<FeedbackResponse>("POST", "/v1/feedback", {
      skill_id: input.skillId,
      endpoint_id: input.endpointId,
      rating: input.rating,
      outcome: input.outcome,
      diagnostics: input.diagnostics,
    }, options);
  }

  async stats(options?: RequestOptions): Promise<StatsResponse> {
    return this.request<StatsResponse>("GET", "/v1/stats", undefined, options);
  }

  async health(options?: RequestOptions): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health", undefined, options);
  }
}
