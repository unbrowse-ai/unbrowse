/**
 * OpenClaw Browser Client — HTTP client for OpenClaw's browser control API.
 *
 * Port 18791 is the browser control service (gateway + 2).
 * All operations return structured data for easy integration.
 */

const DEFAULT_PORT = 18791;

export interface BrowserStatus {
  enabled?: boolean;
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
  ok?: boolean;
  format?: "ai" | "aria";
  targetId?: string;
  url: string;
  title?: string;
  snapshot?: string;
  refs?: Record<string, { role: string; name?: string; nth?: number }>;
  nodes?: Array<{
    ref: string;
    role: string;
    name: string;
    value?: string;
    description?: string;
    depth?: number;
  }>;
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
  result?: unknown;
  targetId?: string;
  url?: string;
}

export class OpenClawBrowser {
  private port: number;
  private profile?: string;

  constructor(port = DEFAULT_PORT, profile?: string) {
    this.port = port;
    this.profile = profile?.trim() || undefined;
  }

  private withProfile(path: string): string {
    if (!this.profile) return path;
    const [base, rawQuery = ""] = path.split("?", 2);
    const params = new URLSearchParams(rawQuery);
    if (!params.has("profile")) {
      params.set("profile", this.profile);
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T | null> {
    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}${this.withProfile(path)}`, {
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
      const resp = await fetch(`http://127.0.0.1:${this.port}${this.withProfile("/")}`, {
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
      const resp = await fetch(
        `http://127.0.0.1:${this.port}${this.withProfile(`/tabs/${encodeURIComponent(targetId)}`)}`,
        {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
        },
      );
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Get page snapshot with interactive elements. */
  async snapshot(opts?: {
    format?: "ai" | "aria";
    mode?: "efficient";
    interactive?: boolean;
    labels?: boolean;
    refs?: "role" | "aria";
    targetId?: string;
    selector?: string;
    frame?: string;
    limit?: number;
    maxChars?: number;
  }): Promise<SnapshotResult | null> {
    const params = new URLSearchParams();
    params.set("format", opts?.format ?? "ai");
    if (opts?.mode) params.set("mode", opts.mode);
    if (opts?.refs) params.set("refs", opts.refs);
    if (opts?.targetId) params.set("targetId", opts.targetId);
    if (opts?.selector) params.set("selector", opts.selector);
    if (opts?.frame) params.set("frame", opts.frame);
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.maxChars != null) params.set("maxChars", String(opts.maxChars));
    if (opts?.interactive) params.set("interactive", "true");
    if (opts?.labels) params.set("labels", "1");
    const qs = params.toString();
    const raw = await this.request<SnapshotResult>(`/snapshot${qs ? `?${qs}` : ""}`);
    if (!raw) return null;
    return this.normalizeSnapshot(raw);
  }

  private normalizeSnapshot(raw: SnapshotResult): SnapshotResult {
    if (raw.elements?.length) return raw;
    const elements: SnapshotElement[] = [];
    for (const [ref, meta] of Object.entries(raw.refs ?? {})) {
      elements.push({
        ref,
        role: meta?.role,
        name: meta?.name,
        tag: meta?.role,
        text: meta?.name,
      });
    }
    if (elements.length === 0 && Array.isArray(raw.nodes)) {
      for (const node of raw.nodes) {
        elements.push({
          ref: node.ref,
          role: node.role,
          name: node.name,
          tag: node.role,
          text: node.name,
          value: node.value,
        });
      }
    }
    return { ...raw, elements };
  }

  /** Execute browser action (click, type, etc.). */
  async act(action: {
    kind:
      | "click"
      | "type"
      | "press"
      | "hover"
      | "scroll"
      | "scrollIntoView"
      | "drag"
      | "select"
      | "fill"
      | "resize"
      | "wait"
      | "evaluate"
      | "close";
    targetId?: string;
    ref?: string;
    selector?: string;
    text?: string;
    key?: string;
    submit?: boolean;
    slowly?: boolean;
    double?: boolean;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
    values?: string[];
    fields?: Array<{ ref: string; type: string; value?: string | number | boolean }>;
    width?: number;
    height?: number;
    startRef?: string;
    endRef?: string;
    timeMs?: number;
    textGone?: string;
    url?: string;
    loadState?: "networkidle" | "load" | "domcontentloaded";
    fn?: string;
    timeoutMs?: number;
    direction?: "up" | "down";
    delayMs?: number;
  }): Promise<ActResult> {
    try {
      const payload = this.normalizeActPayload(action);
      const resp = await fetch(`http://127.0.0.1:${this.port}${this.withProfile("/act")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const body = (await resp.json().catch(() => ({}))) as ActResult & { message?: string };
      if (!resp.ok) {
        return {
          ok: false,
          error: body.error ?? body.message ?? resp.statusText ?? `HTTP ${resp.status}`,
        };
      }
      return {
        ok: body.ok ?? false,
        error: body.error,
        result: body.result,
        targetId: body.targetId,
        url: body.url,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private normalizeActPayload(action: any): Record<string, unknown> {
    // Legacy shim for callers that still send custom scroll direction.
    if (action.kind === "scroll") {
      return {
        kind: "press",
        key: action.direction === "up" ? "PageUp" : "PageDown",
      };
    }

    const payload: Record<string, unknown> = { ...action };

    if (payload.kind === "press") {
      payload.key = payload.key ?? payload.text ?? "";
      delete payload.text;
    }

    if (payload.kind === "select") {
      const values = Array.isArray(payload.values)
        ? payload.values.filter((v) => typeof v === "string" && v.length > 0)
        : [];
      if (values.length === 0 && typeof payload.text === "string" && payload.text.length > 0) {
        payload.values = [payload.text];
      }
      delete payload.text;
    }

    if (payload.kind === "click" && payload.doubleClick == null && payload.double != null) {
      payload.doubleClick = payload.double;
      delete payload.double;
    }

    // OpenClaw /act selector is only accepted for wait; strip it elsewhere.
    if (payload.kind !== "wait") {
      delete payload.selector;
    }

    return payload;
  }

  /** Wait for a condition. */
  async wait(opts: {
    timeMs?: number;
    url?: string;
    selector?: string;
    text?: string;
    textGone?: string;
    load?: "networkidle" | "load" | "domcontentloaded";
    loadState?: "networkidle" | "load" | "domcontentloaded";
    fn?: string;
    timeoutMs?: number;
  }): Promise<boolean> {
    const result = await this.act({
      kind: "wait",
      timeMs: opts.timeMs,
      url: opts.url,
      selector: opts.selector,
      text: opts.text,
      textGone: opts.textGone,
      loadState: opts.loadState ?? opts.load,
      fn: opts.fn,
      timeoutMs: opts.timeoutMs,
    });
    return result.ok;
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
      const path = this.withProfile(`/screenshot${qs ? `?${qs}` : ""}`);
      const resp = await fetch(`http://127.0.0.1:${this.port}${path}`, {
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
    const result = await this.act({
      kind: "evaluate",
      fn,
      ref,
    });
    return result.result;
  }
}

/** Singleton instance for convenience. */
let defaultClient: OpenClawBrowser | null = null;

export function getOpenClawBrowser(port = DEFAULT_PORT, profile?: string): OpenClawBrowser {
  const normalizedProfile = profile?.trim() || undefined;
  const samePort = defaultClient && (defaultClient as any).port === port;
  const sameProfile = defaultClient && (defaultClient as any).profile === normalizedProfile;
  if (!defaultClient || !samePort || !sameProfile) {
    defaultClient = new OpenClawBrowser(port, normalizedProfile);
  }
  return defaultClient;
}
