// @unbrowse/sdk — the Unbrowse REST API (/api/v1). Grown from unbrowse6 src/lib/unbrowse/client.ts.
import type { EgressRequest, EgressResponse, EgressStep, EgressWaiting, IndexJob, Json, RunRequest, RunView, ScrapeRequest, ScrapeResult } from "./types.ts";

export const DEFAULT_BASE_URL = "https://unbrowse.ai/api/v1";
/** Site requests a client-egress run sends at once (a browser sends about six per host). */
const EGRESS_CONCURRENCY = 6;

export type UnbrowseOptions = {
  /** API key (`ub_live_…`) or OAuth access token. Defaults to `UNBROWSE_API_KEY`. Public routes need none. */
  apiKey?: string;
  /** Defaults to `UNBROWSE_BASE_URL` (origin or `/api/v1` URL), then https://unbrowse.ai/api/v1. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

/** An API error: the HTTP status, the server's error code and its body. */
export class UnbrowseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "UnbrowseError";
  }
}

const env = (name: string): string | undefined => (typeof process !== "undefined" ? process.env?.[name] : undefined) || undefined;

function apiBase(url: string): string {
  const u = url.replace(/\/+$/, "");
  return /\/api\/v1$/.test(u) ? u : `${u}/api/v1`;
}

export class Unbrowse {
  readonly baseUrl: string;
  private apiKey?: string;
  private fetchImpl: typeof globalThis.fetch;

  constructor(opts: UnbrowseOptions = {}) {
    this.baseUrl = apiBase(opts.baseUrl ?? env("UNBROWSE_BASE_URL") ?? DEFAULT_BASE_URL);
    this.apiKey = opts.apiKey ?? env("UNBROWSE_API_KEY");
    this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  private async send(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } | string; error_description?: string };
      const err = typeof body.error === "object" ? body.error : undefined;
      throw new UnbrowseError(err?.message ?? body.error_description ?? res.statusText, res.status, err?.code ?? (typeof body.error === "string" ? body.error : "http_error"), body);
    }
    return res;
  }

  private async req(path: string, init?: RequestInit) {
    return (await this.send(path, init)).json();
  }

  private post(path: string, body: unknown) {
    return this.req(path, { method: "POST", body: JSON.stringify(body) });
  }

  // Runs

  /**
   * Start a run by capability id or plain-language task. `idempotencyKey` makes retries safe; the route
   * reads it as `idempotency_key` or an `Idempotency-Key` header (camelCase in the body is ignored).
   */
  run(request: RunRequest): Promise<RunView> {
    const { idempotencyKey, ...rest } = request;
    return this.req("/runs", {
      method: "POST",
      body: JSON.stringify(idempotencyKey ? { ...rest, idempotency_key: idempotencyKey } : rest),
      ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
    });
  }

  inspect(runId: string): Promise<RunView> {
    return this.req(`/runs/${runId}`);
  }

  events(runId: string): Promise<{ events: RunView["events"] }> {
    return this.req(`/runs/${runId}/events`);
  }

  /**
   * Answer a run's open requirements. The route reads snake_case (`requirement_id`, `expected_revision`);
   * the documented camelCase (`requirementId`, `expectedRevision`) is converted here.
   */
  resume(runId: string, expectedStateRevision: number, responses: Json[]) {
    const wire = responses.map((r) => {
      const x = (r ?? {}) as Record<string, Json>;
      return {
        requirement_id: x.requirement_id ?? x.requirementId,
        expected_revision: x.expected_revision ?? x.expectedRevision,
        action: x.action ?? "accept",
        ...(x.values !== undefined ? { values: x.values } : {}),
      };
    });
    return this.post(`/runs/${runId}/responses`, { expected_state_revision: expectedStateRevision, responses: wire });
  }

  /**
   * Import cookies exported from the user's own browser as kept sessions, so later runs act as the signed-in
   * user (see the CLI's `unbrowse cookies sync`). Values are sent to Unbrowse and sealed there, never returned.
   */
  importCookies(cookies: Array<{ domain: string; name: string; value: string; path?: string; secure?: boolean; httpOnly?: boolean; expires?: number }>): Promise<{ sites: number; cookies: number; origins: Array<{ origin: string; cookies: number }> }> {
    return this.post("/cookies", { cookies });
  }

  /** Answer open requirements by field name — `{ origin: "SIN" }` — and return the updated run. */
  async answer(runId: string, answers: Record<string, Json>): Promise<RunView> {
    const view = await this.inspect(runId);
    const open = view.requirements.filter((r) => r.state === "open");
    const responses = Object.entries(answers).map(([field, value]) => {
      const req = open.find((r) => r.affectedAction === field || r.id === field);
      if (!req) throw new UnbrowseError(`${field} is not an open requirement. Open: ${open.map((r) => r.affectedAction).join(", ") || "none"}`, 422, "invalid_answer");
      return { requirementId: req.id, expectedRevision: req.revision, action: "accept", values: { [req.affectedAction]: value } };
    });
    await this.resume(runId, view.stateRevision, responses);
    return this.inspect(runId);
  }

  /** Poll a run until it leaves `accepted`/`working` (or the timeout passes). */
  async wait(runId: string, opts: { timeoutMs?: number } = {}): Promise<RunView> {
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    let view = await this.inspect(runId);
    for (let delay = 500; (view.status === "accepted" || view.status === "working") && Date.now() < deadline; delay = Math.min(delay * 2, 5000)) {
      await new Promise((r) => setTimeout(r, delay));
      view = await this.inspect(runId);
    }
    return view;
  }

  cancel(runId: string) {
    return this.req(`/runs/${runId}/cancel`, { method: "POST" });
  }

  // Client egress: the site requests are sent by you, from your own IP; Unbrowse decides and reads them.

  /**
   * Run with the site requests sent from this machine. Unbrowse chooses each request and reads each response;
   * this sends them with `fetch` (yours by default) and posts the raw responses back until the run finishes.
   * `onRequest` sees each request first; return `false` to refuse it (the run gets a network error).
   */
  async runOnClient(
    request: Omit<RunRequest, "egress">,
    opts: { fetch?: typeof globalThis.fetch; onRequest?: (req: EgressRequest) => boolean | void | Promise<boolean | void>; timeoutMs?: number } = {},
  ): Promise<RunView> {
    const send = opts.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    let step: RunView | EgressStep | EgressWaiting = await this.run({ ...request, egress: "client" } as RunRequest);
    // Requests already sent (or being sent): a later step can still list one until its answer lands.
    const sent = new Set<string>();
    let idle = 0;
    while (isEgressStep(step) || isEgressWaiting(step)) {
      const { egressId } = step;
      if (Date.now() > deadline) {
        await this.closeEgress(egressId).catch(() => undefined);
        throw new UnbrowseError("client-egress run did not finish in time", 408, "timeout");
      }
      // The run has every answer it asked for and has not decided what comes next: ask again shortly.
      if (isEgressWaiting(step)) {
        await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** idle++, 2_000)));
        step = await this.egress(egressId);
        continue;
      }
      idle = 0;
      const fresh = step.requests.filter((r) => !sent.has(r.id));
      // Nothing new to send: ask where the run stands now (the route waits for the next request or the end).
      if (!fresh.length) {
        step = await this.egress(egressId);
        continue;
      }
      for (const r of fresh) sent.add(r.id);
      // A page asks for many requests at once (its scripts, styles, APIs): send them together, a few at a time,
      // and answer each as it lands. The latest answer says what comes next; a finished run ends the loop.
      let latest: EgressStep | EgressWaiting = step;
      let finished: RunView | undefined;
      const queue = [...fresh];
      const worker = async () => {
        for (let req = queue.shift(); req && !finished; req = queue.shift()) {
          let answer: { response: EgressResponse } | { error: string };
          try {
            if ((await opts.onRequest?.(req)) === false) throw new Error("refused by onRequest");
            answer = { response: await sendEgress(send, req) };
          } catch (err) {
            answer = { error: err instanceof Error ? err.message : String(err) };
          }
          if (finished) return;
          try {
            const next = await this.answerEgress(egressId, req.id, answer);
            if (isEgressStep(next) || isEgressWaiting(next)) latest = next;
            else finished = next;
          } catch (err) {
            // The run stopped waiting for this one (it timed out or was aborted server-side): skip it, the run goes on.
            if (err instanceof UnbrowseError && err.status === 409) continue;
            throw err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(EGRESS_CONCURRENCY, fresh.length) }, worker));
      step = finished ?? latest;
    }
    return step;
  }

  /** What a client-egress run is waiting for: the next request(s), or the finished run. */
  egress(egressId: string): Promise<RunView | EgressStep | EgressWaiting> {
    return this.req(`/egress/${egressId}`);
  }

  /** Post the site's response (or why it could not be sent) for one request; returns what comes next. */
  answerEgress(egressId: string, requestId: string, answer: { response: EgressResponse } | { error: string }): Promise<RunView | EgressStep | EgressWaiting> {
    return this.post(`/egress/${egressId}`, { requestId, ...answer });
  }

  /** Abandon a client-egress run. */
  closeEgress(egressId: string): Promise<{ egressId: string; status: "closed" }> {
    return this.req(`/egress/${egressId}`, { method: "DELETE" });
  }

  // Capabilities

  /** Your private capabilities first, then the public registry. */
  discover(query: string) {
    return this.post("/capabilities/search", { query });
  }

  capability(id: string) {
    return this.req(`/capabilities/${encodeURIComponent(id)}`);
  }

  skills() {
    return this.req("/skills");
  }

  /** Compile HAR files or traces of a task done by hand into a one-call capability. */
  learn(body: { har?: Json; traces?: Json[]; goal?: string; title?: string }) {
    return this.post("/learn", body);
  }

  learned(id?: string) {
    return this.req(id ? `/learned/${encodeURIComponent(id)}` : "/learned");
  }

  async harnessYaml(id: string): Promise<string> {
    return (await this.send(`/learned/${encodeURIComponent(id)}/harness.yaml`)).text();
  }

  async skillMd(id: string): Promise<string> {
    return (await this.send(`/learned/${encodeURIComponent(id)}/skill.md`)).text();
  }

  // Pages and indexing

  /**
   * Read one page as clean markdown (or html, text, links, raw), with its metadata. Plain HTTP when the server's HTML
   * has the content, else Unbrowse's cloud browser. The route defaults to html; this defaults to markdown, like MCP
   * `unbrowse.scrape`. One verified call.
   */
  scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    return this.post("/scrape", { formats: ["markdown"], ...request });
  }

  /** Teach Unbrowse a site: an agent explores it and compiles each flow into a tool. Poll with `indexJob`. */
  index(request: { url: string; focus?: string; maxCapabilities?: number }): Promise<IndexJob> {
    return this.post("/index", request);
  }

  indexJob(jobId: string): Promise<IndexJob> {
    return this.req(`/index/${encodeURIComponent(jobId)}`);
  }

  indexJobs(): Promise<{ jobs: IndexJob[] }> {
    return this.req("/index");
  }

  // Account

  usage() {
    return this.req("/usage");
  }

  me() {
    return this.req("/me");
  }

  /**
   * The password manager, for services that keep their own "save your login" page (e.g. Kata): values go in,
   * only masked hints come back. One login per site; saving again for the same origin updates it.
   */
  logins = {
    list: (): Promise<{ logins: LoginView[] }> => this.req("/logins"),
    save: (login: { origin: string; label?: string; username?: string; email?: string; password?: string; totp?: string }): Promise<{ login: LoginView; updated: boolean }> =>
      this.post("/logins", login),
    remove: (by: { origin: string } | { ref: string }): Promise<{ removed: number }> => this.post("/logins/remove", by),
  };

  accounts = {
    /** Store a password in the vault; returns a `vault://` ref. */
    connect: (a: { origin: string; username?: string; password?: string; label?: string }) => this.post("/accounts/connections", a),
    /** Generate and vault a password for a new account. */
    register: (a: { origin: string; username: string; label?: string }) => this.post("/accounts/register", a),
  };

  /** Vault refs and audit, never secrets. */
  vault() {
    return this.req("/vault");
  }

  // Public registry: compiled sites as tools. No account needed to read.

  sites(query = "") {
    return this.req(`/sites${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  }

  site(host: string) {
    return this.req(`/sites/${normalizeHost(host)}`);
  }

  openapi(host: string) {
    return this.req(`/sites/${normalizeHost(host)}/openapi.json`);
  }

  /**
   * Run one site tool: `POST /sites/{host}/call/{tool}` with its inputs as the body (metered like a run; only a
   * verified success bills). Resolves with the run for 200 and 202 (`input_required`: answer it with `answer`).
   * Past `deadlineMs` it throws an UnbrowseError with code `run_timeout` whose body names the `runId` to `wait` on;
   * the run keeps going. The tool's inputs, typed request and result: `openapi(host)`.
   */
  callTool<R = Json>(host: string, tool: string, input: Record<string, Json> = {}, opts: SiteCallOptions = {}): Promise<SiteRun<R>> {
    const headers: Record<string, string> = {};
    if (opts.deadlineMs !== undefined) headers["x-unbrowse-deadline-ms"] = String(opts.deadlineMs);
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    if (opts.endUser) headers["x-unbrowse-end-user"] = opts.endUser;
    const body = opts.select?.length ? { ...input, select: opts.select } : input;
    return this.req(`/sites/${normalizeHost(host)}/call/${encodeURIComponent(tool)}`, { method: "POST", body: JSON.stringify(body), headers });
  }

  /**
   * One indexed site as a client: its tools, its OpenAPI document, and calls by tool name.
   *
   *     const docs = ub.forSite("docs.rs");
   *     const run = await docs.call("docs_rs__get_search", { query: "serde" });
   */
  forSite(host: string): SiteClient {
    return new SiteClient(this, normalizeHost(host));
  }

  /** One site as its own MCP server: its compiled tools, a plain-words task, and the recorded browser on that site. */
  siteMcpUrl(host: string): string {
    return `${this.baseUrl}/sites/${normalizeHost(host)}/mcp`;
  }
}

/** Options for one site tool call. */
export type SiteCallOptions = {
  /** Answer within this many ms (5,000–300,000; default 60,000). Past it: UnbrowseError `run_timeout` with the runId. */
  deadlineMs?: number;
  /** A retry with the same key returns the same run instead of starting another. */
  idempotencyKey?: string;
  /** Keep only these parts of the result, e.g. `["results[].{title,url}", "total"]`. Billing is unchanged. */
  select?: string[];
  /** With an organisation key: run as this end user, in their own workspace. */
  endUser?: string;
};

/** What a site tool call answers: the run, with the site's verified `result` when `status` is `succeeded`. */
export type SiteRun<R = Json> = {
  runId: string;
  status: RunView["status"];
  capabilityId?: string | null;
  result?: R;
  error?: { code: string; message: string } | null;
  /** Open questions when `status` is `input_required`: answer them with `answer(runId, …)`. */
  requirements?: RunView["requirements"];
  via?: "http" | "rendered" | null;
  /** The result was over 40,000 characters and was shortened: pass `select`. */
  truncated?: boolean;
  /** `select` paths that matched nothing. */
  selectMissing?: string[];
};

/** One tool as `GET /sites/{host}` lists it. */
export type SiteToolInfo = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, Json>;
  /** An input the tool is known to work with: send it as-is for a first call that works. */
  example?: Record<string, Json>;
  readOnly: boolean;
  version: string;
  public: boolean;
  browserless: boolean;
  /** Runs signed in as you on the site. */
  personal?: boolean;
  /** POST here with the inputs as JSON. */
  endpoint?: string;
  /** The shape of a succeeded run's `result`. */
  resultSchema?: Record<string, Json>;
  /** The same call as curl, TypeScript and Python. */
  samples?: { lang: "curl" | "typescript" | "python"; label: string; source: string }[];
};

/** `GET /sites/{host}`: a site's tools and where its MCP server and OpenAPI document are. */
export type SiteInfo = { host: string; tools: SiteToolInfo[]; mcp: string; openapi: string; docs?: string };

/** One indexed site: `ub.forSite(host)`. */
export class SiteClient {
  constructor(
    private readonly ub: Unbrowse,
    readonly host: string,
  ) {}

  /** The site's tools, each with its inputs, an example, its result shape and ready-to-copy calls. */
  tools(): Promise<SiteInfo> {
    return this.ub.site(this.host) as Promise<SiteInfo>;
  }

  /** The site's OpenAPI 3.1 document: one operation per tool. */
  openapi(): Promise<Record<string, Json>> {
    return this.ub.openapi(this.host) as Promise<Record<string, Json>>;
  }

  /** Run one of the site's tools by name. */
  call<R = Json>(tool: string, input: Record<string, Json> = {}, opts: SiteCallOptions = {}): Promise<SiteRun<R>> {
    return this.ub.callTool<R>(this.host, tool, input, opts);
  }

  /** A tool as a function: `const search = site.tool("docs_rs__get_search"); await search({ query: "serde" })`. */
  tool<R = Json>(name: string): (input?: Record<string, Json>, opts?: SiteCallOptions) => Promise<SiteRun<R>> {
    return (input = {}, opts = {}) => this.call<R>(name, input, opts);
  }

  /** The site as its own MCP server. */
  get mcpUrl(): string {
    return this.ub.siteMcpUrl(this.host);
  }
}

export function normalizeHost(site: string): string {
  let host = site.trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
  return host.replace(/\/.*$/, "").replace(/^www\./, "");
}

/** A saved login as anyone but the vault sees it: never a value. */
export type LoginView = { ref: string; origin: string; label?: string; hints: { username?: string; email?: string }; fields: string[]; createdAt: number; rotatedAt?: number };

/** Whether a run answer is a client-egress step (requests to send) rather than a run. */
export function isEgressStep(v: unknown): v is EgressStep {
  return !!v && typeof v === "object" && (v as { status?: unknown }).status === "egress_required";
}

/**
 * Whether a run answer says the client-egress run is not finished but has nothing to send yet (poll `egress` again):
 * `waiting_for_client`, or any other egress answer that is not a run. A run carries `runId`; an egress step that is not
 * `egress_required` never is the result, so a status the server adds later keeps the loop polling (under its deadline)
 * instead of being printed as the run.
 */
export function isEgressWaiting(v: unknown): v is EgressWaiting {
  if (!v || typeof v !== "object") return false;
  const o = v as { status?: unknown; egressId?: unknown; runId?: unknown };
  return typeof o.egressId === "string" && o.runId === undefined && o.status !== "egress_required";
}

/** Sends one egress request and captures the response as Unbrowse needs it. */
async function sendEgress(send: typeof globalThis.fetch, req: EgressRequest): Promise<EgressResponse> {
  const body: BodyInit | undefined = req.body === undefined ? undefined : req.bodyEncoding === "base64" ? (base64ToBytes(req.body) as unknown as BodyInit) : req.body;
  const res = await send(req.url, { method: req.method, headers: req.headers, redirect: req.redirect, ...(body !== undefined ? { body } : {}) });
  const headers: [string, string][] = [];
  res.headers.forEach((value, name) => headers.push([name, value]));
  // Repeated set-cookie headers are folded by forEach in some runtimes; keep each one when the runtime can.
  const cookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  const pairs = cookies?.length ? [...headers.filter(([n]) => n.toLowerCase() !== "set-cookie"), ...cookies.map((c) => ["set-cookie", c] as [string, string])] : headers;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: pairs, body: bytesToBase64(bytes), bodyEncoding: "base64", ...(res.url ? { url: res.url } : {}) };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
