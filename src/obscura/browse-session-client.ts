/**
 * A `BrowseSessionClient` backed by the obscura broker — the first real cut at
 * replacing kuri on the server `/v1/browse/*` surface.
 *
 * `src/api/browse-session.ts` never depended on kuri itself; it depends on a
 * narrow six-method interface (start / newTab / harStart / closeTab /
 * discoverTabs / getCurrentUrl). That is the whole seam: satisfy the interface
 * from the obscura broker and the server session registry becomes Chrome-free
 * without a line of its own logic changing.
 *
 * Two shape differences with kuri, both deliberate:
 *
 *   harStart is a NO-OP. kuri had to be told to start recording; obscura's
 *   broker observes every request for the life of the page, so "start recording"
 *   has nothing to do. Reporting success for a no-op is honest here — the
 *   post-condition the caller wants (traffic is being recorded) holds.
 *
 *   newTab returns obscura's tab id when the build exposes tabs, and otherwise
 *   the single-page sentinel. obscura's MCP server holds ONE shared page per
 *   broker process (one V8 isolate), so a "tab" is the page; callers that want
 *   isolation start another broker rather than another tab.
 */

import {
  ObscuraHttpClient,
  startObscuraSession,
  stopObscuraSession,
  type ObscuraSessionRecord,
} from "./session-broker.js";
import type { BrowseSessionClient, BrowseTabRef } from "../api/browse-session.js";

/**
 * Is there a live broker on this port?
 *
 * Bounded on purpose: `ObscuraHttpClient.rpc` has no timeout, so probing a port
 * held by a hung process would hang the CLI forever. A port we cannot reach
 * within the budget is treated as gone — the cost of that being wrong is one
 * extra browser, while the cost of hanging is the whole command.
 */
async function brokerResponds(client: ObscuraHttpClient, timeoutMs = 2_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.start(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("broker probe timeout")), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The id used when the obscura build exposes no separate tab handle. */
export const OBSCURA_SINGLE_TAB = "obscura-page";

/** First `"id": "..."`-ish token in a browser_tab_* reply, or null. Pure. */
export function parseTabId(raw: string): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    const cand = Array.isArray(j) ? j[0] : j;
    const id = cand?.id ?? cand?.tabId ?? cand?.target_id;
    if (typeof id === "string" && id) return id;
    if (typeof id === "number") return String(id);
  } catch {
    /* not JSON — fall through to the text forms below */
  }
  const m = t.match(/\b(?:tab|target)[ _-]?(?:id)?\s*[:=]?\s*([A-Za-z0-9_-]{2,})/i);
  return m ? m[1] : null;
}

/** Tab refs from a browser_tab_list reply — one per line or a JSON array. Pure. */
export function parseTabList(raw: string): BrowseTabRef[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) {
      return j
        .map((e) => ({ id: String(e?.id ?? e?.tabId ?? ""), url: typeof e?.url === "string" ? e.url : undefined }))
        .filter((e) => e.id);
    }
  } catch {
    /* not JSON — parse the human line form below */
  }
  const out: BrowseTabRef[] = [];
  for (const line of t.split("\n")) {
    const m = line.match(/([A-Za-z0-9_-]{2,})\s+(https?:\/\/\S+)/);
    if (m) out.push({ id: m[1], url: m[2] });
  }
  return out;
}

export interface ObscuraBrowseClientOptions {
  /** Reuse an already-running broker instead of spawning one. */
  client?: ObscuraHttpClient;
  port?: number;
  binPath?: string;
  stealth?: boolean;
}

/**
 * Satisfies `BrowseSessionClient` over an obscura broker. Spawns its own broker
 * on `start()` unless one was injected, so the server can own the lifecycle the
 * same way it owned kuri's.
 */
export class ObscuraBrowseSessionClient implements BrowseSessionClient {
  private client: ObscuraHttpClient | null;
  private record: ObscuraSessionRecord | null = null;
  private port: number | null;
  private opts: ObscuraBrowseClientOptions;

  constructor(opts: ObscuraBrowseClientOptions = {}) {
    this.opts = opts;
    this.client = opts.client ?? null;
    this.port = opts.port ?? null;
  }

  async start(): Promise<void> {
    if (this.client) return;
    // A port names an ALREADY-OPEN page — adopt it rather than opening another.
    //
    // Until this existed, `port` was decoration: start() looked only at
    // `this.client` (which only an injected client sets), so a passed port was
    // overwritten by a freshly spawned broker on the very next line. Measured
    // consequence: `go https://defillama.com` navigated the broker on :41165,
    // then `run-js "location.href"` spawned its OWN broker and answered
    // "about:blank" — a session that reported success and could not be read
    // back. It also leaked a browser per invocation; 17 were up at once.
    if (this.port !== null) {
      const adopted = new ObscuraHttpClient(this.port);
      if (await brokerResponds(adopted)) {
        this.client = adopted;
        return;
      }
      // The record outlived its broker. Spawning is right here — the page is
      // gone either way, and refusing would strand the caller on a dead pid.
      this.port = null;
    }
    this.record = await startObscuraSession({
      binPath: this.opts.binPath,
      extraArgs: this.opts.stealth ? ["--stealth"] : [],
    });
    this.port = this.record.port;
    this.client = new ObscuraHttpClient(this.record.port);
  }

  private need(): ObscuraHttpClient {
    if (!this.client) throw new Error("obscura browse client not started");
    return this.client;
  }

  async newTab(): Promise<string> {
    try {
      const id = parseTabId(await this.need().tool("browser_tab_new"));
      if (id) return id;
    } catch {
      /* this build cannot OPEN a tab — it may still list the one it has */
    }
    // Adopt the id `discoverTabs` will report rather than inventing one. These
    // two must agree: liveness checks the recorded tab id against discovery, so
    // a synthetic id recorded against a build that lists a real one reads as a
    // dead session. discoverTabs already falls back to the placeholder when
    // there is no tab model, so that case is unchanged.
    const tabs = await this.discoverTabs().catch(() => []);
    return tabs.length === 1 && tabs[0]?.id ? tabs[0].id : OBSCURA_SINGLE_TAB;
  }

  /**
   * No-op: the broker records every request for the life of the page, so there
   * is no recording to switch on. Resolving is the honest answer — the caller's
   * post-condition (traffic is being captured) already holds.
   */
  async harStart(_tabId: string): Promise<void> {
    return;
  }

  async closeTab(tabId: string): Promise<void> {
    if (tabId && tabId !== OBSCURA_SINGLE_TAB) {
      try {
        await this.need().tool("browser_tab_close", { id: tabId });
        return;
      } catch {
        /* fall through to ending the broker */
      }
    }
    if (this.record) {
      stopObscuraSession(this.record.sessionId);
      this.record = null;
      this.client = null;
    }
  }

  async discoverTabs(): Promise<BrowseTabRef[]> {
    try {
      const tabs = parseTabList(await this.need().tool("browser_tab_list"));
      if (tabs.length > 0) return tabs;
    } catch {
      /* fall through to the single-page view */
    }
    const url = await this.getCurrentUrl(OBSCURA_SINGLE_TAB).catch(() => "");
    return [{ id: OBSCURA_SINGLE_TAB, url: url || undefined }];
  }

  async getCurrentUrl(_tabId: string): Promise<string> {
    const href = await this.need().evaluate("location.href");
    const t = (href ?? "").trim();
    return t && t !== "null" && t !== "undefined" ? t : "";
  }

  getPort(): number {
    return this.port ?? 0;
  }

  // ── The wider surface `src/api/routes.ts` actually calls on a session broker.
  // BrowseSessionClient is only the six methods the registry needs; the route
  // handlers reach for a further ~14. Each maps to an obscura MCP tool verified
  // live this session. `tabId` is accepted and ignored: a broker holds one page,
  // so the tab IS the page (see the class docstring).

  async evaluate(_tabId: string, expression: string): Promise<unknown> {
    return this.need().evaluate(expression);
  }

  async getPageHtml(_tabId: string): Promise<string> {
    const html = await this.need().evaluate("document.documentElement.outerHTML");
    const t = (html ?? "").trim();
    return t && t !== "null" && t !== "undefined" ? t : "";
  }

  async click(_tabId: string, ref: string): Promise<unknown> {
    return this.need().click(ref);
  }

  async fill(_tabId: string, ref: string, value: string): Promise<unknown> {
    return this.need().fill(ref, value);
  }

  async select(_tabId: string, ref: string, value: string): Promise<unknown> {
    return this.need().selectOption(ref, value);
  }

  async press(_tabId: string, key: string, _ref?: string): Promise<unknown> {
    return this.need().press(key);
  }

  async keyboardType(_tabId: string, text: string): Promise<unknown> {
    // No focus model on obscura, so there is no "type into whatever has focus".
    // Refuse in the same voice `breath type` uses rather than typing into a
    // silently-wrong element.
    void text;
    throw new Error(
      "unsupported_on_obscura:keyboardType — obscura has no focused-element model; use fill(tabId, ref, value)",
    );
  }

  async scroll(_tabId: string, direction: "up" | "down" | "left" | "right" = "down", amount = 500): Promise<unknown> {
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    return this.need().scroll({ dx, dy });
  }

  async goBack(_tabId: string): Promise<unknown> {
    return this.need().back();
  }

  async goForward(_tabId: string): Promise<unknown> {
    return this.need().forward();
  }

  /** obscura's jar, parsed to kuri's cookie shape. Never logs a value. */
  async getCookies(_tabId: string): Promise<Array<Record<string, unknown>>> {
    const raw = await this.need().getCookies();
    try {
      const j = JSON.parse((raw ?? "").trim());
      return Array.isArray(j) ? (j as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  }

  /**
   * The broker records for the life of the page, so there is no recording to
   * stop — and no HAR to hand back. Returning empty entries is the honest shape:
   * the obscura capture path reads traffic from the sidecar's NDJSON, not from a
   * HAR the broker never produced.
   */
  async harStop(_tabId: string): Promise<{ entries: unknown[]; raw: unknown }> {
    return { entries: [], raw: null };
  }

  /** Nothing to rehydrate: obscura loads no extensions. */
  async bestEffortRehydratePlugins(_tabId: string): Promise<{ ok: boolean; reason: string }> {
    return { ok: true, reason: "obscura_loads_no_plugins" };
  }

  /**
   * Refuses, like `eval screenshot`. obscura has no layout or paint engine, so
   * there is no image to return — an empty string here would be read as a
   * successful blank capture.
   */
  async screenshot(_tabId: string): Promise<string> {
    throw new Error(
      "unsupported_on_obscura:screenshot — obscura has no layout or paint engine; use getPageHtml or a snapshot",
    );
  }

  // ── The rest of the surface. Derived by diffing every `broker.*` / `client.*`
  // call in src/api/routes.ts against what this class implements, because the
  // registry's interface is only six methods and TypeScript cannot see the gap
  // through the cast at the call site — a missing method would not fail at the
  // seam, it would crash on the first handler that reached for it.

  async navigate(_tabId: string, url: string): Promise<void> {
    await this.need().navigate(url);
  }

  async getText(_tabId: string): Promise<string> {
    const t = await this.need().text();
    const s = (t ?? "").trim();
    return s && s !== "null" && s !== "undefined" ? s : "";
  }

  async getMarkdown(_tabId: string): Promise<string> {
    return (await this.need().markdown()) ?? "";
  }

  /** The ref listing `eval snap` uses — obscura's own `ref=eN` table. */
  async snapshot(_tabId: string, _filter?: string): Promise<string> {
    return (await this.need().interactiveElements()) ?? "";
  }

  /** Post-load injection: evaluating the source in the live page is the same effect. */
  async scriptInject(_tabId: string, source: string): Promise<unknown> {
    return this.need().evaluate(source);
  }

  /**
   * PRE-load injection has no MCP surface (the crate has add_preload_script; the
   * broker does not expose it). It is not load-bearing here: unbrowse used it to
   * install a fetch/XHR interceptor, and the broker already records every
   * request for the life of the page — the thing the interceptor existed to do.
   * Reports that honestly rather than pretending the script was installed.
   */
  async addInitScript(_tabId: string, _script: string): Promise<unknown> {
    return { ok: false, reason: "obscura_broker_has_no_preload_hook_recording_is_native" };
  }

  /** No-op: the broker records from the first request; there is nothing to enable. */
  async networkEnable(_tabId: string): Promise<void> {
    return;
  }

  /** obscura's navigate already awaits load, so this is a settle, not a wait. */
  async waitForLoad(_tabId: string, _timeoutMs?: number): Promise<{ ok: boolean; url?: string }> {
    const url = await this.getCurrentUrl(_tabId).catch(() => "");
    return { ok: true, url: url || undefined };
  }

  /** Liveness = the broker answers a trivial evaluate. */
  async health(): Promise<{ ok: boolean; tabs?: number }> {
    try {
      await this.need().evaluate("1");
      return { ok: true, tabs: 1 };
    } catch {
      return { ok: false };
    }
  }

  /** End the broker process this client owns. */
  async stop(): Promise<void> {
    if (this.record) {
      stopObscuraSession(this.record.sessionId);
      this.record = null;
      this.client = null;
    }
  }
}
