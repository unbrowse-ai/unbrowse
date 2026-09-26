// @unbrowse/sdk — the Unbrowse REST API (/api/v1). Grown from unbrowse6 src/lib/unbrowse/client.ts.
import type { Json, RunRequest, RunView } from "./types.ts";

export const DEFAULT_BASE_URL = "https://unbrowse.ai/api/v1";

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

  /** Run one site tool (metered like a run). */
  callTool(host: string, tool: string, input: Record<string, Json> = {}) {
    return this.post(`/sites/${normalizeHost(host)}/call/${encodeURIComponent(tool)}`, input);
  }

  /** One site as its own MCP server: its compiled tools, a plain-words task, and the recorded browser on that site. */
  siteMcpUrl(host: string): string {
    return `${this.baseUrl}/sites/${normalizeHost(host)}/mcp`;
  }
}

export function normalizeHost(site: string): string {
  let host = site.trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
  return host.replace(/\/.*$/, "").replace(/^www\./, "");
}

/** A saved login as anyone but the vault sees it: never a value. */
export type LoginView = { ref: string; origin: string; label?: string; hints: { username?: string; email?: string }; fields: string[]; createdAt: number; rotatedAt?: number };
