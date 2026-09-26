import type { Json, RunRequest, RunView } from "./types.ts";

export class Unbrowse {
  constructor(private opts: { apiKey?: string; baseUrl: string }) {}

  private async req(path: string, init?: RequestInit) {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? body?.error_description ?? res.statusText), { status: res.status, body });
    return body;
  }

  run(request: RunRequest): Promise<RunView> {
    return this.req("/runs", { method: "POST", body: JSON.stringify(request) });
  }

  inspect(runId: string): Promise<RunView> {
    return this.req(`/runs/${runId}`);
  }

  /**
   * Answer a run's open requirements. The server reads snake_case (`requirement_id`, `expected_revision`);
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
    return this.req(`/runs/${runId}/responses`, {
      method: "POST",
      body: JSON.stringify({ expected_state_revision: expectedStateRevision, responses: wire }),
    });
  }

  cancel(runId: string) {
    return this.req(`/runs/${runId}/cancel`, { method: "POST" });
  }

  discover(query: string) {
    return this.req("/capabilities/search", { method: "POST", body: JSON.stringify({ query }) });
  }

  /**
   * The password manager, for services that keep their own "save your login" page (e.g. Kata): values go in,
   * only masked hints come back. One login per site; saving again for the same origin updates it.
   */
  logins = {
    list: (): Promise<{ logins: LoginView[] }> => this.req("/logins"),
    save: (login: { origin: string; label?: string; username?: string; email?: string; password?: string; totp?: string }): Promise<{ login: LoginView; updated: boolean }> =>
      this.req("/logins", { method: "POST", body: JSON.stringify(login) }),
    remove: (by: { origin: string } | { ref: string }): Promise<{ removed: number }> =>
      this.req("/logins/remove", { method: "POST", body: JSON.stringify(by) }),
  };

  usage() {
    return this.req("/usage");
  }

  me() {
    return this.req("/me");
  }

  /** Compile HAR files or traces of a task done by hand into a one-call capability. */
  learn(body: { har?: Json; traces?: Json[]; goal?: string; title?: string }) {
    return this.req("/learn", { method: "POST", body: JSON.stringify(body) });
  }

  learned(id?: string) {
    return this.req(id ? `/learned/${encodeURIComponent(id)}` : "/learned");
  }

  /** The public registry of compiled sites; no account needed. */
  sites(query = "") {
    return this.req(`/sites${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  }

  site(host: string) {
    return this.req(`/sites/${host.toLowerCase().replace(/^www\./, "")}`);
  }

  /** One site as its own MCP server: its compiled tools, a plain-words task, and the recorded browser on that site. */
  siteMcpUrl(host: string): string {
    return `${this.opts.baseUrl}/sites/${host.toLowerCase().replace(/^www\./, "")}/mcp`;
  }
}

/** A saved login as anyone but the vault sees it: never a value. */
export type LoginView = { ref: string; origin: string; label?: string; hints: { username?: string; email?: string }; fields: string[]; createdAt: number; rotatedAt?: number };
