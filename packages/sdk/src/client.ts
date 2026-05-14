import type {
  AttributionLedger,
  AvailableEndpoint,
  CreatorTransactionsResponse,
  Dashboard,
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
import { PaymentRequiredError, UnbrowseApiError } from "./errors.js";
import {
  type RuntimeHandle,
  type SpawnRuntimeOptions,
  probeUnbrowseRuntime,
  spawnUnbrowseRuntime,
} from "./runtime.js";
import type { X402PaymentRequirement } from "./x402.js";

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
  private _runtimeHandle: RuntimeHandle | null = null;

  constructor(options: UnbrowseClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey ?? readEnv("UNBROWSE_API_KEY");
    this.clientId = options.clientId;
    this.defaultHeaders = options.headers;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Build a `params` object from an `AvailableEndpoint.input_params` spec, using
   * the `example_value` of each declared key. Skips keys without an example.
   */
  static paramsFromInputSpec(
    spec: AvailableEndpoint["input_params"] | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of spec ?? []) {
      if (p.example_value !== undefined) out[p.key] = p.example_value;
    }
    return out;
  }

  /**
   * Point at an already-running Unbrowse runtime. No probe, no spawn.
   * `.close()` is a no-op for the runtime (the caller owns it).
   */
  static async connect(
    baseUrl: string,
    opts: Omit<UnbrowseClientOptions, "baseUrl"> = {},
  ): Promise<Unbrowse> {
    return new Unbrowse({ ...opts, baseUrl });
  }

  /**
   * Spawn a co-located Unbrowse runtime and return a client pointed at it.
   * The client takes ownership of the child process: `.close()` will tear
   * it down.
   */
  static async spawn(
    opts: SpawnRuntimeOptions & Omit<UnbrowseClientOptions, "baseUrl"> = {},
  ): Promise<Unbrowse> {
    const { port, cwd, env, binaryPath, readyTimeoutMs, ...clientOpts } = opts;
    const handle = await spawnUnbrowseRuntime({ port, cwd, env, binaryPath, readyTimeoutMs });
    const client = new Unbrowse({ ...clientOpts, baseUrl: handle.baseUrl });
    if (handle.owned) client._runtimeHandle = handle;
    return client;
  }

  /**
   * Probe 127.0.0.1 on the requested port (default 6969). Adopts a live
   * runtime via `connect`; spawns a new one via `spawn` if dead. The
   * resulting client only owns the runtime if it had to spawn.
   */
  static async local(
    opts: SpawnRuntimeOptions & Omit<UnbrowseClientOptions, "baseUrl"> = {},
  ): Promise<Unbrowse> {
    const port = opts.port ?? 6969;
    const baseUrl = `http://127.0.0.1:${port}`;
    if (await probeUnbrowseRuntime(baseUrl, 1_000)) {
      const { port: _p, cwd: _c, env: _e, binaryPath: _b, readyTimeoutMs: _r, ...clientOpts } = opts;
      return Unbrowse.connect(baseUrl, clientOpts);
    }
    return Unbrowse.spawn(opts);
  }

  /**
   * Release any resources owned by this client. If the client spawned its
   * own runtime, this kills the child process. Otherwise no-op.
   */
  async close(): Promise<void> {
    if (this._runtimeHandle) {
      const h = this._runtimeHandle;
      this._runtimeHandle = null;
      await h.kill();
    }
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
        // 402 surfaces as PaymentRequiredError so callers can hand the
        // typed error to `payAndRetry(error, wallet, retry)`. Accepts the
        // standard x402 shape (`{ accepts: [...] }`) and the Unbrowse
        // backend shape that nests it under `data.accepts`.
        if (response.status === 402) {
          const payload = (typeof data === "object" && data !== null) ? (data as JsonRecord) : {};
          const acceptsRaw = (() => {
            const top = payload["accepts"];
            if (Array.isArray(top)) return top;
            const nested = (payload["data"] as JsonRecord | undefined)?.["accepts"];
            return Array.isArray(nested) ? nested : [];
          })();
          const accepts = acceptsRaw as X402PaymentRequirement[];
          const skillIdFromBody = typeof payload["skillId"] === "string"
            ? (payload["skillId"] as string)
            : (typeof payload["skill_id"] === "string" ? (payload["skill_id"] as string) : undefined);
          const skillIdFromPath = (() => {
            const m = path.match(/\/v1\/skills\/([^/?#]+)/);
            return m ? decodeURIComponent(m[1]) : undefined;
          })();
          const message = typeof payload["error"] === "string"
            ? (payload["error"] as string)
            : `${method} ${path} failed with 402`;
          throw new PaymentRequiredError(message, accepts, url, skillIdFromBody ?? skillIdFromPath);
        }
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
    if (input.confirmThirdPartyTerms !== undefined) body.confirm_third_party_terms = input.confirmThirdPartyTerms;
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
    if (bodyInput.confirmThirdPartyTerms !== undefined) body.confirm_third_party_terms = bodyInput.confirmThirdPartyTerms;
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

  /**
   * Earnings/spending dashboard for the authenticated agent.
   * Requires `apiKey` set on the client. Backend: `GET /v1/dashboard/me`.
   */
  async dashboard(options?: RequestOptions): Promise<Dashboard> {
    return this.request<Dashboard>("GET", "/v1/dashboard/me", undefined, options);
  }

  /**
   * Public dashboard for any wallet address. Backend: `GET /v1/dashboard/wallet/:walletAddress`.
   */
  async dashboardByWallet(walletAddress: string, options?: RequestOptions): Promise<Dashboard> {
    return this.request<Dashboard>(
      "GET",
      `/v1/dashboard/wallet/${encodeURIComponent(walletAddress)}`,
      undefined,
      options,
    );
  }

  /**
   * Per-transaction earnings ledger for a creator agent.
   * Backend: `GET /v1/transactions/creator/:agentId`.
   */
  async creatorTransactions(agentId: string, options?: RequestOptions): Promise<CreatorTransactionsResponse> {
    return this.request<CreatorTransactionsResponse>(
      "GET",
      `/v1/transactions/creator/${encodeURIComponent(agentId)}`,
      undefined,
      options,
    );
  }

  /**
   * Fund a Flex escrow on the caller's behalf. Thin wrapper around
   * `fundEscrow` in `./flex.ts` — requires the caller to pass
   * `signer` + `rpc` for v6.16-preview.0 (until SDK ships its own
   * @solana/kit pipeline). For pure tx construction without sending,
   * import `buildEscrowCreationTx` from the package root.
   */
  async fundEscrow(params: {
    amountUsdc: string;
    walletAddress?: string;
    facilitatorAddress?: string;
    mint?: string;
    refundTimeoutSlots?: number;
    deadmanTimeoutSlots?: number;
    signer?: unknown;
    rpc?: unknown;
  }): Promise<{ escrowAddress: string; txSignature: string }> {
    const { fundEscrow } = await import("./flex.js");
    return fundEscrow({
      amountUsdc: params.amountUsdc,
      walletAddress: params.walletAddress ?? "",
      facilitatorAddress: params.facilitatorAddress ?? "",
      mint: params.mint,
      refundTimeoutSlots: params.refundTimeoutSlots,
      deadmanTimeoutSlots: params.deadmanTimeoutSlots,
      signer: params.signer,
      rpc: params.rpc,
    });
  }

  /**
   * Register a session key against the caller's existing Flex escrow.
   * Thin wrapper around `registerSessionKey` in `./flex.ts`.
   */
  async registerSessionKey(params: {
    sessionKeyAddress: string;
    walletAddress?: string;
    escrowAddress?: string;
    expiresAtSlot?: string;
    revocationGracePeriodSlots?: number;
    signer?: unknown;
    rpc?: unknown;
  }): Promise<{ txSignature: string }> {
    const { registerSessionKey } = await import("./flex.js");
    return registerSessionKey({
      walletAddress: params.walletAddress ?? "",
      escrowAddress: params.escrowAddress ?? "",
      sessionKeyAddress: params.sessionKeyAddress,
      expiresAtSlot: params.expiresAtSlot,
      revocationGracePeriodSlots: params.revocationGracePeriodSlots,
      signer: params.signer,
      rpc: params.rpc,
    });
  }

  /**
   * Execute a skill against a Flex-metered route, streaming per-unit usage
   * to `onUsage` as the backend acks each settlement chunk. Day-3 stub:
   * rejects honestly. Day-4 wires this to the metered execute endpoint.
   */
  async executeMetered<T = unknown>(
    _skillOrId: string | { skill_id: string },
    _input: unknown,
    _opts: { onUsage?: (units: number) => void },
  ): Promise<T> {
    throw new Error("not yet implemented (Day 4)");
  }

  /**
   * Indexer earnings via delta-based attribution.
   * Backend: `GET /v1/attribution/indexer/:indexerId`.
   */
  async indexerAttribution(indexerId: string, options?: RequestOptions): Promise<AttributionLedger> {
    return this.request<AttributionLedger>(
      "GET",
      `/v1/attribution/indexer/${encodeURIComponent(indexerId)}`,
      undefined,
      options,
    );
  }
}
