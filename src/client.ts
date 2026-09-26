import type { Json, RunRequest, RunView } from "./types.ts";

export class Unbrowse {
  constructor(private opts: { apiKey: string; baseUrl: string }) {}

  private async req(path: string, init?: RequestInit) {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? res.statusText);
    return body;
  }

  run(request: RunRequest): Promise<RunView> {
    return this.req("/runs", { method: "POST", body: JSON.stringify(request) });
  }

  inspect(runId: string): Promise<RunView> {
    return this.req(`/runs/${runId}`);
  }

  resume(runId: string, expectedStateRevision: number, responses: Json[]) {
    return this.req(`/runs/${runId}/responses`, {
      method: "POST",
      body: JSON.stringify({ expected_state_revision: expectedStateRevision, responses }),
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

  /** One site as its own MCP server: its compiled tools, a plain-words task, and the recorded browser on that site. */
  siteMcpUrl(host: string): string {
    return `${this.opts.baseUrl}/sites/${host.toLowerCase().replace(/^www\./, "")}/mcp`;
  }
}

/** A saved login as anyone but the vault sees it: never a value. */
export type LoginView = { ref: string; origin: string; label?: string; hints: { username?: string; email?: string }; fields: string[]; createdAt: number; rotatedAt?: number };
