/**
 * OpenClaw Browser Client — HTTP client for OpenClaw's browser control API.
 *
 * Port 18791 is the browser control service (gateway + 2).
 * All operations return structured data for easy integration.
 */

const DEFAULT_PORT = 18791;

export interface BrowserStatus {
  running: boolean;
  profile?: string;
  targetId?: string;
}

export interface SnapshotElement {
  ref: string;
  role?: string;
  name?: string;
  tag?: string;
  text?: string;
  value?: string;
  options?: string[];
}

export interface SnapshotResult {
  url: string;
  title: string;
  snapshot?: string;
  elements?: SnapshotElement[];
  stats?: { refs: number; interactive: number };
}

export interface CapturedRequest {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface ActResult {
  ok: boolean;
  error?: string;
}

export class OpenClawBrowser {
  private port: number;

  constructor(port = DEFAULT_PORT) {
    this.port = port;
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T | null> {
    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        signal: AbortSignal.timeout(30000),
        ...opts,
      });
      if (!resp.ok) return null;
      return await resp.json() as T;
    } catch {
      return null;
    }
  }

  /** Check if browser control service is available. */
  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}/`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Get browser status. */
  async status(): Promise<BrowserStatus | null> {
    return this.request<BrowserStatus>("/");
  }

  /** Start the browser if not running. */
  async start(): Promise<boolean> {
    const resp = await this.request<{ ok: boolean }>("/start", { method: "POST" });
    return resp?.ok ?? false;
  }

  /** Ensure browser is running. */
  async ensureRunning(): Promise<boolean> {
    const status = await this.status();
    if (status?.running) return true;
    return this.start();
  }

  /** Navigate to URL. */
  async navigate(url: string): Promise<boolean> {
    const resp = await this.request<{ ok: boolean }>("/navigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    return resp?.ok ?? false;
  }

  /** Open URL in a new tab. Returns targetId. */
  async openTab(url: string): Promise<string | null> {
    const resp = await this.request<{ targetId?: string }>("/tabs/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    return resp?.targetId ?? null;
  }

  /** Close a tab by targetId. */
  async closeTab(targetId: string): Promise<boolean> {
    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}/tabs/${targetId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Get page snapshot with interactive elements. */
  async snapshot(opts?: { interactive?: boolean; labels?: boolean }): Promise<SnapshotResult | null> {
    const params = new URLSearchParams();
    if (opts?.interactive) params.set("interactive", "true");
    if (opts?.labels) params.set("labels", "true");
    const qs = params.toString();
    return this.request<SnapshotResult>(`/snapshot${qs ? `?${qs}` : ""}`);
  }

  /** Execute browser action (click, type, etc.). */
  async act(action: {
    kind: "click" | "type" | "press" | "hover" | "scroll" | "select";
    ref?: string;
    selector?: string;
    text?: string;
    submit?: boolean;
    double?: boolean;
    direction?: "up" | "down";
  }): Promise<ActResult> {
    const resp = await this.request<{ ok: boolean; error?: string }>("/act", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    return { ok: resp?.ok ?? false, error: resp?.error };
  }

  /** Wait for a condition. */
  async wait(opts: {
    url?: string;
    selector?: string;
    text?: string;
    load?: "networkidle" | "load" | "domcontentloaded";
    timeoutMs?: number;
  }): Promise<boolean> {
    const resp = await this.request<{ ok: boolean }>("/wait", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    return resp?.ok ?? false;
  }

  /** Get captured network requests. */
  async requests(opts?: { filter?: string; clear?: boolean }): Promise<CapturedRequest[]> {
    const params = new URLSearchParams();
    if (opts?.filter) params.set("filter", opts.filter);
    if (opts?.clear) params.set("clear", "true");
    const qs = params.toString();
    const resp = await this.request<{ requests?: CapturedRequest[] }>(`/requests${qs ? `?${qs}` : ""}`);
    return resp?.requests ?? [];
  }

  /** Get cookies. */
  async cookies(): Promise<Record<string, string>> {
    const resp = await this.request<{ cookies?: Array<{ name: string; value: string }> }>("/cookies");
    const cookies: Record<string, string> = {};
    for (const c of resp?.cookies ?? []) {
      cookies[c.name] = c.value;
    }
    return cookies;
  }

  /** Set cookies. */
  async setCookies(cookies: Array<{ name: string; value: string; domain?: string; url?: string }>): Promise<boolean> {
    const resp = await this.request<{ ok: boolean }>("/cookies/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies }),
    });
    return resp?.ok ?? false;
  }

  /** Get localStorage or sessionStorage. */
  async storage(kind: "local" | "session"): Promise<Record<string, string>> {
    const resp = await this.request<{ storage?: Record<string, string> }>(`/storage/${kind}`);
    return resp?.storage ?? {};
  }

  /** Set storage values. */
  async setStorage(kind: "local" | "session", data: Record<string, string>): Promise<boolean> {
    const resp = await this.request<{ ok: boolean }>(`/storage/${kind}/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return resp?.ok ?? false;
  }

  /** Set extra HTTP headers for all requests. */
  async setHeaders(headers: Record<string, string>): Promise<boolean> {
    const resp = await this.request<{ ok: boolean }>("/set/headers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers }),
    });
    return resp?.ok ?? false;
  }

  /** Take a screenshot. Returns base64 data or file path. */
  async screenshot(opts?: { fullPage?: boolean; ref?: string }): Promise<string | null> {
    const params = new URLSearchParams();
    if (opts?.fullPage) params.set("full-page", "true");
    if (opts?.ref) params.set("ref", opts.ref);
    const qs = params.toString();

    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}/screenshot${qs ? `?${qs}` : ""}`, {
        method: "POST",
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { screenshot?: string; path?: string };
      return data.screenshot ?? data.path ?? null;
    } catch {
      return null;
    }
  }

  /** Evaluate JavaScript in the page context. */
  async evaluate(fn: string, ref?: string): Promise<unknown> {
    const resp = await this.request<{ result?: unknown }>("/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fn, ref }),
    });
    return resp?.result;
  }
}

/** Singleton instance for convenience. */
let defaultClient: OpenClawBrowser | null = null;

export function getOpenClawBrowser(port = DEFAULT_PORT): OpenClawBrowser {
  if (!defaultClient || (defaultClient as any).port !== port) {
    defaultClient = new OpenClawBrowser(port);
  }
  return defaultClient;
}
