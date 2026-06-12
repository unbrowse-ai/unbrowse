/**
 * stateless-primitive.ts — the API-native browser surface for agents.
 *
 * Each exported op is a SELF-CONTAINED browser primitive: the caller passes the full target in
 * the request (a url, and for an action a ref + value), and the op runs the whole browser
 * lifecycle internally — launch an owned Chrome/CDP lease, navigate, perform the act, capture the
 * resulting snapshot + the network the act produced, then tear the lease down. There is no session
 * id to open/thread/close; the agent never holds browser state.
 *
 * Continuity is carried in the RESPONSE, not on the server: every op returns the post-act
 * `snapshot` (interactive a11y tree with fresh `[eN]` refs) and the current `url`, so the agent's
 * next stateless call uses a ref straight out of the snapshot it was just handed. Cross-call
 * continuity comes from explicit wallet/profile inputs, not a shared tab registry. A multi-step
 * flow is a sequence of independent stateless calls, each one whole.
 *
 * This is the consolidation path: Kuri's useful primitives are now direct binary-owned CDP calls.
 * Real browser, real timing — but no separate Kuri authority, broker, or shared tab registry.
 */
import type { AuthVault } from "../values/auth-vault.js";
import type { CapabilitySource, CapabilityStatus } from "../superpattern/bridge-manifest.js";
import { spawnChrome } from "../cdp/chrome.js";
import { closeTarget, createTarget } from "../cdp/target.js";
import type { CDPConnection, Target } from "../cdp/types.js";

export interface KuriCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}

export interface KuriHarEntry {
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    postData?: { text: string };
  };
  response: {
    status: number;
    headers: Array<{ name: string; value: string }>;
    content?: { text?: string; mimeType?: string };
  };
  startedDateTime: string;
}

export type StatelessOp = "navigate" | "snapshot" | "click" | "fill" | "press" | "scroll";

/**
 * Wallet-bound auth for a stateless op. Auth material (cookies/headers/PII) is NEVER carried as
 * cleartext in the request — it is sealed to the holder's wallet in an {@link AuthVault} and
 * REVEALED per-origin under the caller's `walletSecret` right before the act. A wrong wallet
 * reveals nothing (fails closed), so the op runs unauthenticated rather than leaking. This is the
 * pointer-not-payload model the covenant substrate already enforces (cli-v7/_stateless.ts), here
 * applied to the browser surface: the request carries the origin + wallet identity, not secrets.
 */
export interface StatelessAuthBinding {
  /** Wallet secret the origin's auth is sealed to. Never logged. */
  walletSecret: string;
  /** Vault of sealed (cookie/header) entries, namespaced by origin. */
  vault: AuthVault;
}

export interface StatelessResult {
  /** True iff the op completed without error. */
  ok: boolean;
  /** The op performed. */
  op: StatelessOp;
  /** The current page url AFTER the act (an act can navigate; use this for the next call). */
  url: string;
  /** Post-act interactive a11y snapshot — fresh `[eN]` refs for the next stateless call. */
  snapshot?: string;
  /** Network requests captured during the op (the act's API traffic — the agent's payload). */
  network?: KuriHarEntry[];
  /** Raw kuri action result, when the op returns one. */
  result?: unknown;
  /** Counts of wallet-sealed auth applied for the origin (never the values). */
  authApplied?: { cookies: number; headers: number };
  /** Sanitized error string when ok=false. */
  error?: string;
}

export interface CapabilityResultEnvelope {
  status: CapabilityStatus;
  kind: "browser.stateless";
  source: CapabilitySource;
  data: {
    op: StatelessOp;
    url: string;
    snapshot?: string;
    network?: KuriHarEntry[];
    result?: unknown;
  };
  requirements: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  evidence: {
    runtime: "stateless_binary";
    primitive_module: "src/kuri/stateless-primitive.ts";
    browser_lease: {
      lease_id: string;
      op: StatelessOp;
      url: string;
      acquired_at: string;
      released_at: string;
      helper_pid: number | null;
    };
    auth_applied?: { cookies: number; headers: number };
  };
  next_action: Record<string, unknown> | null;
}

export interface StatelessInput {
  /** Target page. Required — this is what makes the call self-contained. */
  url: string;
  /** Action target ref (`[eN]` from a prior snapshot) or CSS selector. Required for click/fill/press. */
  ref?: string;
  /** Value for fill, or key for press. */
  value?: string;
  /** Scroll direction for scroll. */
  direction?: "up" | "down" | "left" | "right";
  /** Snapshot filter (e.g. "interactive"). Defaults to "interactive". */
  filter?: string;
  /** Settle window (ms) after the act before snapshotting. Default 1200. */
  settleMs?: number;
  /** Override kuri broker port. */
  port?: number;
  /**
   * Wallet-bound auth. When present, the op reveals the origin's sealed cookies/headers under
   * `walletSecret` and applies them to the tab before navigating. NOTE: there is deliberately NO
   * cleartext cookie/header/token field on this input — auth crosses the boundary ONLY as a
   * wallet-sealed pointer, never as a raw secret.
   */
  auth?: StatelessAuthBinding;
}

/**
 * Reveal the origin's wallet-sealed cookies/headers and apply them to the target. Cookies and
 * headers are each stored as ONE sealed JSON bundle under (kind, origin); a wrong wallet reveals
 * nothing and we apply nothing (fail closed). Returns what was applied for the result envelope
 * (counts only — never the values).
 */
async function applyWalletAuth(
  target: Target,
  origin: string,
  auth: StatelessAuthBinding,
): Promise<{ cookies: number; headers: number }> {
  let cookies = 0;
  let headers = 0;
  try {
    await target.cdp.call("Network.clearBrowserCookies", {}, target.sessionId);
  } catch {
    /* best effort — never let a clear failure mask the op */
  }
  try {
    const cookieJson = await auth.vault.reveal("cookie", origin, auth.walletSecret);
    if (cookieJson) {
      const parsed = JSON.parse(cookieJson) as KuriCookie[];
      if (Array.isArray(parsed) && parsed.length) {
        await target.cdp.call("Network.setCookies", {
          cookies: parsed.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path ?? "/",
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: normalizeSameSite(cookie.sameSite),
            expires: cookie.expires,
            url: cookie.domain ? undefined : origin,
          })),
        }, target.sessionId);
        cookies = parsed.length;
      }
    }
  } catch {
    /* malformed/absent → apply nothing, never throw */
  }
  try {
    const headerJson = await auth.vault.reveal("header", origin, auth.walletSecret);
    if (headerJson) {
      const parsed = JSON.parse(headerJson) as Record<string, string>;
      const keys = Object.keys(parsed ?? {});
      if (keys.length) {
        await target.cdp.call("Network.setExtraHTTPHeaders", { headers: parsed }, target.sessionId);
        headers = keys.length;
      }
    }
  } catch {
    /* fail closed */
  }
  return { cookies, headers };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const DEFAULT_SETTLE_MS = 1200;

function normalizeSameSite(value: string | undefined): "Strict" | "Lax" | "None" | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "lax") return "Lax";
  if (normalized === "none" || normalized === "no_restriction") return "None";
  return undefined;
}

function errStr(e: unknown): string {
  if (e instanceof Error) return e.message.slice(0, 240);
  if (typeof e === "string") return e.slice(0, 240);
  try {
    return JSON.stringify(e).slice(0, 240);
  } catch {
    return String(e).slice(0, 240);
  }
}

async function evaluateValue<T = unknown>(target: Target, expression: string): Promise<T | undefined> {
  try {
    const out = await target.cdp.call<
      { expression: string; awaitPromise: boolean; returnByValue: boolean; userGesture?: boolean },
      { result?: { value?: T }; exceptionDetails?: unknown }
    >("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, target.sessionId);
    if (out.exceptionDetails) return undefined;
    return out.result?.value;
  } catch {
    return undefined;
  }
}

async function currentUrl(target: Target): Promise<string> {
  const u = await evaluateValue<string>(target, "window.location.href");
  return typeof u === "string" ? u : "";
}

function waitForCdpEvent(conn: CDPConnection, sessionId: string, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve();
    }, timeoutMs);
    const unsub = conn.on(event, (_params, sid) => {
      if (sid !== sessionId) return;
      clearTimeout(timer);
      unsub();
      resolve();
    });
  });
}

function headerPairs(headers: Record<string, unknown> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

function captureNetwork(target: Target): { entries: KuriHarEntry[]; stop: () => void } {
  const entries: KuriHarEntry[] = [];
  const entriesById = new Map<string, KuriHarEntry>();
  const offRequest = target.cdp.on("Network.requestWillBeSent", (raw, sid) => {
    if (sid !== target.sessionId || !raw || typeof raw !== "object") return;
    const ev = raw as {
      requestId?: string;
      wallTime?: number;
      request?: { method?: string; url?: string; headers?: Record<string, unknown>; postData?: string };
    };
    if (!ev.requestId || !ev.request?.url) return;
    const request = {
      method: ev.request.method ?? "GET",
      url: ev.request.url,
      headers: headerPairs(ev.request.headers),
      ...(ev.request.postData ? { postData: { text: ev.request.postData } } : {}),
    };
    const entry = {
      request,
      response: { status: 0, headers: [] },
      startedDateTime: new Date((ev.wallTime ?? Date.now() / 1000) * 1000).toISOString(),
    };
    entriesById.set(ev.requestId, entry);
    entries.push(entry);
  });
  const offResponse = target.cdp.on("Network.responseReceived", (raw, sid) => {
    if (sid !== target.sessionId || !raw || typeof raw !== "object") return;
    const ev = raw as {
      requestId?: string;
      response?: { status?: number; headers?: Record<string, unknown>; mimeType?: string };
    };
    if (!ev.requestId) return;
    const entry = entriesById.get(ev.requestId);
    if (!entry) return;
    entry.response = {
      status: ev.response?.status ?? 0,
      headers: headerPairs(ev.response?.headers),
      content: ev.response?.mimeType ? { mimeType: ev.response.mimeType } : undefined,
    };
  });
  return {
    entries,
    stop: () => {
      offRequest();
      offResponse();
    },
  };
}

const SNAPSHOT_SCRIPT = String.raw`
(() => {
  const candidates = Array.from(document.querySelectorAll(
    'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="menuitem"],[tabindex]:not([tabindex="-1"])'
  ));
  const visible = candidates.filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }).slice(0, 120);
  globalThis.__unbrowseStatelessRefs = visible;
  const roleOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return el.getAttribute('type') || 'input';
    return tag;
  };
  const nameOf = (el) => (
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('placeholder') ||
    el.innerText ||
    el.value ||
    el.href ||
    ''
  ).replace(/\s+/g, ' ').trim().slice(0, 160);
  return visible.map((el, i) => ('[e' + i + '] ' + roleOf(el) + ' ' + nameOf(el)).trim()).join('\n');
})()
`;

async function snapshot(target: Target): Promise<string> {
  return (await evaluateValue<string>(target, SNAPSHOT_SCRIPT)) ?? "";
}

function actionScript(op: StatelessOp, ref: string | undefined, value: string | undefined, direction: StatelessInput["direction"]): string {
  return `
(() => {
  const ref = ${JSON.stringify(ref ?? "")};
  const value = ${JSON.stringify(value ?? "")};
  const direction = ${JSON.stringify(direction ?? "down")};
  const byRef = /^e\\d+$/.test(ref) ? (globalThis.__unbrowseStatelessRefs || [])[Number(ref.slice(1))] : null;
  const el = byRef || (ref ? document.querySelector(ref) : null);
  const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  if (${JSON.stringify(op)} === "scroll") {
    const delta = direction === "up" ? -600 : direction === "left" ? -600 : 600;
    if (direction === "left" || direction === "right") window.scrollBy({ left: delta, behavior: "instant" });
    else window.scrollBy({ top: delta, behavior: "instant" });
    return { ok: true, action: "scroll" };
  }
  if (!el) return { ok: false, error: "selector_not_found" };
  el.scrollIntoView({ block: "center", inline: "center" });
  if (${JSON.stringify(op)} === "click") {
    el.click();
    return { ok: true, action: "click" };
  }
  if (${JSON.stringify(op)} === "fill") {
    el.focus();
    el.value = value;
    fire(el, "input");
    fire(el, "change");
    return { ok: true, action: "fill" };
  }
  if (${JSON.stringify(op)} === "press") {
    el.focus();
    const key = value || "Enter";
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    return { ok: true, action: "press", key };
  }
  return { ok: false, error: "unsupported_op" };
})()
`;
}

/**
 * Run one stateless browser op end-to-end. The single lifecycle every primitive shares:
 *   spawn Chrome → fresh target → Network on → navigate → settle → [act] → settle → snapshot
 *   → close target/browser. Never throws: every failure path returns `{ok:false, error}` with the tab
 *   cleaned up, so a caller can fire ops without try/finally bookkeeping.
 */
export async function runStateless(op: StatelessOp, input: StatelessInput): Promise<StatelessResult> {
  const filter = input.filter ?? "interactive";
  const settleMs = input.settleMs ?? DEFAULT_SETTLE_MS;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  let conn: CDPConnection | undefined;
  let target: Target | undefined;
  let network: ReturnType<typeof captureNetwork> | undefined;
  try {
    conn = await spawnChrome({});
    target = await createTarget(conn, "about:blank");
    await target.cdp.call("Page.enable", {}, target.sessionId);
    await target.cdp.call("Runtime.enable", {}, target.sessionId);
    await target.cdp.call("Network.enable", {}, target.sessionId);
    network = captureNetwork(target);

    let authApplied: { cookies: number; headers: number } | undefined;
    if (input.auth) {
      authApplied = await applyWalletAuth(target, originOf(input.url), input.auth);
    }
    const load = waitForCdpEvent(conn, target.sessionId, "Page.loadEventFired", 15_000);
    await target.cdp.call("Page.navigate", { url: input.url }, target.sessionId);
    await load;
    await sleep(settleMs);

    let result: unknown;
    if (op !== "navigate" && op !== "snapshot") {
      if (!input.ref && op !== "scroll") {
        return { ok: false, op, url: input.url, error: `missing_ref_for_${op}` };
      }
      await snapshot(target);
      const ref = (input.ref ?? "").replace(/^\[|\]$/g, "");
      result = await evaluateValue(target, actionScript(op, ref, input.value, input.direction));
      if (result && typeof result === "object" && (result as { ok?: boolean }).ok === false) {
        return { ok: false, op, url: await currentUrl(target) || input.url, error: String((result as { error?: unknown }).error ?? "action_failed") };
      }
      await sleep(settleMs);
    }

    const snap = filter === "none" ? "" : await snapshot(target);
    const url = await currentUrl(target);
    return {
      ok: true,
      op,
      url: url || input.url,
      snapshot: snap,
      network: network.entries,
      result,
      authApplied,
    };
  } catch (e) {
    return { ok: false, op, url: input.url, error: errStr(e) };
  } finally {
    try { network?.stop(); } catch { /* ignore */ }
    try { if (target) await closeTarget(target); } catch { /* ignore */ }
    try { await conn?.close(); } catch { /* ignore */ }
  }
}

function leaseId(op: StatelessOp, url: string, acquiredAt: string): string {
  const encoded = new TextEncoder().encode(`${op}\n${url}\n${acquiredAt}\n${process.pid}`);
  let hash = 2166136261;
  for (const byte of encoded) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `browser-lease-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function statelessResultToCapabilityResult(
  result: StatelessResult,
  acquiredAt = new Date().toISOString(),
  releasedAt = new Date().toISOString(),
): CapabilityResultEnvelope {
  const status: CapabilityStatus = result.ok ? "ok" : "unavailable";
  return {
    status,
    kind: "browser.stateless",
    source: result.ok ? "browser_capture_fallback" : "unavailable",
    data: {
      op: result.op,
      url: result.url,
      ...(result.snapshot !== undefined ? { snapshot: result.snapshot } : {}),
      ...(result.network !== undefined ? { network: result.network } : {}),
      ...(result.result !== undefined ? { result: result.result } : {}),
    },
    requirements: result.ok ? {} : {
      unavailable: {
        reason: result.error ?? "browser_runtime_failed",
      },
    },
    artifacts: {},
    evidence: {
      runtime: "stateless_binary",
      primitive_module: "src/kuri/stateless-primitive.ts",
      browser_lease: {
        lease_id: leaseId(result.op, result.url, acquiredAt),
        op: result.op,
        url: result.url,
        acquired_at: acquiredAt,
        released_at: releasedAt,
        helper_pid: null,
      },
      ...(result.authApplied ? { auth_applied: result.authApplied } : {}),
    },
    next_action: result.ok ? null : {
      title: "Browser primitive unavailable",
      reason: result.error ?? "browser_runtime_failed",
    },
  };
}

// ─── Thin per-primitive wrappers (the agent-facing surface) ────────────────────

/** Load a url and return its interactive snapshot + the network it fetched. No session. */
export const statelessNavigate = (input: StatelessInput) => runStateless("navigate", input);
/** Snapshot a url's interactive a11y tree (fresh refs) without acting. */
export const statelessSnapshot = (input: StatelessInput) => runStateless("snapshot", input);
/** Click `ref` on `url`; return the post-click snapshot + the API traffic the click triggered. */
export const statelessClick = (input: StatelessInput) => runStateless("click", input);
/** Fill `ref` on `url` with `value`; return the post-fill snapshot. */
export const statelessFill = (input: StatelessInput) => runStateless("fill", input);
/** Press `value` (key) on `url`, optionally focused on `ref`. */
export const statelessPress = (input: StatelessInput) => runStateless("press", input);
/** Scroll `url` in `direction`; return the revealed snapshot. */
export const statelessScroll = (input: StatelessInput) => runStateless("scroll", input);
