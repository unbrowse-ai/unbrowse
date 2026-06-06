/**
 * stateless-primitive.ts — the API-native browser surface for agents.
 *
 * Each exported op is a SELF-CONTAINED browser primitive: the caller passes the full target in
 * the request (a url, and for an action a ref + value), and the op runs the whole kuri lifecycle
 * internally — start the broker, open a fresh tab, navigate, perform the act, capture the
 * resulting accessibility snapshot + the network the act produced, then tear the tab down. There
 * is no session id to open/thread/close; the agent never holds browser state.
 *
 * Continuity is carried in the RESPONSE, not on the server: every op returns the post-act
 * `snapshot` (interactive a11y tree with fresh `[eN]` refs) and the current `url`, so the agent's
 * next stateless call uses a ref straight out of the snapshot it was just handed. Cookies and the
 * profile persist in kuri's browser between calls (same origin → same logged-in state), so a
 * multi-step flow is a sequence of independent stateless calls, each one whole.
 *
 * This is the consolidation the project chose: kuri is the ONE interaction engine (no parallel
 * hand-rolled CDP path), exposed statelessly. Real browser, real timing — anti-bot resilience
 * comes from driving an actual Chrome via kuri, not from a synthetic humanizer.
 */
import * as kuri from "./client.js";
import type { KuriHarEntry, KuriCookie } from "./client.js";
import type { AuthVault } from "../values/auth-vault.js";

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
 * Reveal the origin's wallet-sealed cookies/headers and apply them to the tab. Cookies and
 * headers are each stored as ONE sealed JSON bundle under (kind, origin); a wrong wallet reveals
 * nothing and we apply nothing (fail closed). Returns what was applied for the result envelope
 * (counts only — never the values).
 */
async function applyWalletAuth(
  tabId: string,
  origin: string,
  auth: StatelessAuthBinding,
): Promise<{ cookies: number; headers: number }> {
  let cookies = 0;
  let headers = 0;
  // Wallet ISOLATION: kuri's browser profile persists cookies across ops, so a prior wallet's
  // cookie would leak into this op. Clear the jar first, then apply ONLY this wallet's sealed
  // set — so a wrong wallet (which reveals nothing) ends up with a clean, unauthenticated jar.
  try {
    const existing = await kuri.getCookies(tabId);
    if (existing.length) {
      await kuri.setCookies(tabId, existing.map((c) => ({ ...c, expires: 1 })));
    }
  } catch {
    /* best effort — never let a clear failure mask the op */
  }
  try {
    const cookieJson = await auth.vault.reveal("cookie", origin, auth.walletSecret);
    if (cookieJson) {
      const parsed = JSON.parse(cookieJson) as KuriCookie[];
      if (Array.isArray(parsed) && parsed.length) {
        await kuri.setCookies(tabId, parsed);
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
        await kuri.setHeaders(tabId, parsed);
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

function errStr(e: unknown): string {
  if (e instanceof Error) return e.message.slice(0, 240);
  if (typeof e === "string") return e.slice(0, 240);
  try {
    return JSON.stringify(e).slice(0, 240);
  } catch {
    return String(e).slice(0, 240);
  }
}

async function currentUrl(tabId: string): Promise<string> {
  try {
    const u = await kuri.evaluate(tabId, "window.location.href");
    return typeof u === "string" ? u : "";
  } catch {
    return "";
  }
}

/**
 * Run one stateless browser op end-to-end. The single lifecycle every primitive shares:
 *   start broker → fresh tab → HAR on → navigate → settle → [act] → settle → snapshot → HAR off
 *   → close tab. Never throws: every failure path returns `{ok:false, error}` with the tab
 *   cleaned up, so a caller can fire ops without try/finally bookkeeping.
 */
export async function runStateless(op: StatelessOp, input: StatelessInput): Promise<StatelessResult> {
  const filter = input.filter ?? "interactive";
  const settleMs = input.settleMs ?? DEFAULT_SETTLE_MS;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  let tabId: string | undefined;
  try {
    await kuri.start(input.port);
    await kuri.discoverTabs();
    // Create the tab already pointed at the target (/tab/new?url=) then re-assert via /navigate
    // and wait for load — belt and braces so the snapshot never races an about:blank tab.
    tabId = await kuri.newTab(input.url);
    if (!tabId) return { ok: false, op, url: input.url, error: "no_tab" };

    await kuri.harStart(tabId);
    // Wallet-bound auth: reveal + apply the origin's sealed cookies/headers BEFORE the load that
    // should carry them (the tab was created on the url; re-navigate below applies them).
    let authApplied: { cookies: number; headers: number } | undefined;
    if (input.auth) {
      authApplied = await applyWalletAuth(tabId, originOf(input.url), input.auth);
      // Reload so the page re-reads the jar we just cleared+set under this wallet (a same-url
      // navigate can be a no-op; reload forces the document to pick up the wallet's cookies).
      await kuri.reload(tabId).catch(() => {});
    } else {
      await kuri.navigate(tabId, input.url);
    }
    await kuri.waitForLoad(tabId, 15000).catch(() => {});
    await sleep(settleMs);

    // For an action op, the ref must address the page we just loaded. kuri assigns `[eN]` refs
    // during a snapshot, so we MUST snapshot before acting to register the caller's ref into
    // kuri's node map (mirrors orchestrator/browser-agent.ts: snapshot → act). This is what
    // makes a stateless `[eN]` ref (taken from a prior stateless snapshot of this same url)
    // resolve on this fresh load — the snapshot ordering is deterministic for the same page.
    let result: unknown;
    if (op !== "navigate" && op !== "snapshot") {
      if (!input.ref && op !== "scroll") {
        await safeClose(tabId);
        return { ok: false, op, url: input.url, error: `missing_ref_for_${op}` };
      }
      await kuri.snapshot(tabId, filter); // register refs before the act
      // Snapshots DISPLAY refs as `[e0]` but kuri's action API takes the bare `e0` — normalize so
      // the agent can pass a ref exactly as it appears in the snapshot it was handed.
      const ref = (input.ref ?? "").replace(/^\[|\]$/g, "");
      switch (op) {
        case "click":
          result = await kuri.click(tabId, ref);
          break;
        case "fill":
          result = await kuri.fill(tabId, ref, input.value ?? "");
          break;
        case "press":
          result = await kuri.press(tabId, input.value ?? "Enter", ref || undefined);
          break;
        case "scroll":
          result = await kuri.scroll(tabId, input.direction ?? "down");
          break;
      }
      await sleep(settleMs);
    }

    const snap = await kuri.snapshot(tabId, filter);
    const har = await kuri.harStop(tabId);
    const url = await currentUrl(tabId);
    await safeClose(tabId);
    return {
      ok: true,
      op,
      url: url || input.url,
      snapshot: snap,
      network: har.entries,
      result,
      authApplied,
    };
  } catch (e) {
    if (tabId) await safeClose(tabId);
    return { ok: false, op, url: input.url, error: errStr(e) };
  }
}

async function safeClose(tabId: string): Promise<void> {
  try {
    await kuri.closeTab(tabId);
  } catch {
    /* best effort — never let cleanup failure mask the result */
  }
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
