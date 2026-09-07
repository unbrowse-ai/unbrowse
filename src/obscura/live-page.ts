/**
 * The obscura live-page ADAPTER for the v7 CLI handlers.
 *
 * `breath go` opens a page; later processes (`eval text`, `breath click`, …)
 * re-attach to it. With Chrome that handle is a `BrowseSessionRecord`
 * (`chromeWsUrl` + `chromePid`). obscura reuses THE SAME record shape, which is
 * why the whole session substrate keeps working untouched:
 *
 *   chromeWsUrl  ->  http://127.0.0.1:<port>/mcp   (the broker endpoint)
 *   chromePid    ->  the detached `obscura mcp --http` pid
 *   targetId     ->  "obscura"                     (the backend sentinel)
 *
 * Because `chromePid` is a real live process, `isProcessAlive`,
 * `mostRecentLiveSession`, `reapStaleSessions` and `close`'s SIGTERM all behave
 * identically — no parallel session store, no forked lifecycle.
 *
 * Each handler then needs only a guarded early branch:
 *
 *     const rec = await resolveSession(sessionFlag);
 *     if (isObscuraSession(rec)) { ...drive obscuraClient(rec)...; return; }
 *
 * Selected by `UNBROWSE_BROWSER_BACKEND=obscura` at `breath go`; every later
 * call detects the backend from the record itself, so the env need not persist.
 */

import {
  ObscuraHttpClient,
  startObscuraSession,
  stopObscuraSession,
  readObscuraSession,
  type ObscuraSessionRecord,
} from "./session-broker.js";
import type { BrowseSessionRecord } from "../cli-v7/_session.js";
import { parseTabList } from "./browse-session-client.js";

/** targetId sentinel marking a session as obscura-backed. */
export const OBSCURA_TARGET_ID = "obscura";

/** True when the obscura backend is selected for new page sessions. */
export function obscuraBackendSelected(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.UNBROWSE_BROWSER_BACKEND ?? "").trim().toLowerCase();
  return !["cdp", "chrome", "kuri", "chromium"].includes(v);
}

/**
 * Is this session driven by obscura rather than Chrome/CDP? Recognized by the
 * record's own SHAPE (an http(s) `/mcp` endpoint, or the sentinel targetId) —
 * never by consulting the environment, so a session opened with the backend set
 * stays drivable after the env is gone.
 */
export function isObscuraSession(rec: Pick<BrowseSessionRecord, "chromeWsUrl" | "targetId">): boolean {
  if (rec.targetId === OBSCURA_TARGET_ID) return true;
  return /^https?:\/\/[^/]+\/mcp$/.test(String(rec.chromeWsUrl ?? ""));
}

/** The broker endpoint URL for a port. */
export function brokerEndpoint(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}/mcp`;
}

/** Port encoded in an obscura session record's endpoint, or null. */
export function portFromEndpoint(endpoint: string): number | null {
  const m = String(endpoint ?? "").match(/^https?:\/\/[^:/]+:(\d+)\/mcp$/);
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * obscura's MCP returns an evaluate result as TEXT. A JS `null`/`undefined`
 * (the "element not found" signal the CDP path gets from `result.value === null`)
 * arrives as the literal string "null"/"undefined", and an absent result as "".
 * One shared reading of that, so no handler re-invents it.
 */
export function isObscuraNull(raw: string | null | undefined): boolean {
  const t = String(raw ?? "").trim();
  return t === "" || t === "null" || t === "undefined";
}

/** An HTTP MCP client bound to this session's broker. Throws if not obscura. */
export function obscuraClient(
  rec: Pick<BrowseSessionRecord, "chromeWsUrl" | "targetId">,
  fetchImpl?: typeof fetch,
): ObscuraHttpClient {
  const port = portFromEndpoint(rec.chromeWsUrl);
  if (port === null) {
    throw new Error(`not an obscura session endpoint: ${rec.chromeWsUrl}`);
  }
  return new ObscuraHttpClient(port, fetchImpl ?? fetch);
}

/** Shape a broker record as the CLI's BrowseSessionRecord. Pure. */
export function toBrowseSessionRecord(broker: ObscuraSessionRecord): BrowseSessionRecord {
  return {
    sessionId: broker.sessionId,
    contextId: OBSCURA_TARGET_ID,
    targetId: OBSCURA_TARGET_ID,
    chromeWsUrl: brokerEndpoint(broker.port),
    chromePid: broker.pid,
    createdAt: broker.createdAt,
  };
}

export interface OpenObscuraPageResult {
  record: BrowseSessionRecord;
  client: ObscuraHttpClient;
  /** The settled URL after navigation (best-effort). */
  url: string;
}

/**
 * `breath go` on obscura: start a broker, navigate it, and return the record to
 * persist plus a live client. No Chrome is launched and no CDP socket opened.
 */
export async function openObscuraPage(
  url: string,
  opts: { binPath?: string; stealth?: boolean; readyTimeoutMs?: number; proxy?: string } = {},
): Promise<OpenObscuraPageResult> {
  const extraArgs: string[] = [];
  if (opts.stealth) extraArgs.push("--stealth");
  // obscura takes the proxy at process start, so a rotation is a fresh broker
  // rather than a live re-config — same shape as respawning Chrome with a new
  // --proxy-server, minus the Chrome.
  if (opts.proxy) extraArgs.push("--proxy", opts.proxy);
  const broker = await startObscuraSession({
    binPath: opts.binPath,
    extraArgs,
    readyTimeoutMs: opts.readyTimeoutMs,
  });
  const record = toBrowseSessionRecord(broker);
  const client = new ObscuraHttpClient(broker.port);
  try {
    await client.navigate(url);
  } catch (err) {
    // Never leak a broker process when the first navigation fails.
    stopObscuraSession(broker.sessionId);
    throw err;
  }
  let settled = url;
  try {
    const href = await client.evaluate("location.href");
    if (href && href.trim()) settled = href.trim();
  } catch {
    /* best-effort settled URL */
  }
  return { record: { ...record, ...(await brokerTabIdentity(client, settled)) }, client, url: settled };
}

/**
 * The identity a LATER process needs to recognise this page: the tab id the
 * broker itself reports, plus the settled URL.
 *
 * Asked, never assumed. The placeholder id this replaces made every rehydrated
 * obscura session read as dead — liveness compares the recorded tab id against
 * `discoverTabs()`, and a build that cannot OPEN a tab (`browser_tab_new`) may
 * still LIST the one it has (measured: recorded `obscura-page`, discovered
 * `tab-1`, so `run-js` answered `no_active_session` for a page that was loaded
 * and evaluable the whole time). Records no tab id when the build has no tab
 * model — honest, and the placeholder then stands exactly as before.
 */
async function brokerTabIdentity(
  client: ObscuraHttpClient,
  settledUrl: string,
): Promise<{ tabId?: string; url: string }> {
  try {
    const tabs = parseTabList(await client.tool("browser_tab_list"));
    if (tabs.length === 1 && tabs[0]?.id) return { tabId: tabs[0].id, url: settledUrl };
  } catch {
    /* no tab model in this build */
  }
  return { url: settledUrl };
}

/**
 * Navigate a session that is ALREADY obscura-backed (the `go --session <id>`
 * re-use path). Returns the record to re-persist (createdAt refreshed, every
 * other pointer field preserved) and the settled URL.
 */
export async function navigateObscuraSession(
  rec: BrowseSessionRecord,
  url: string,
): Promise<{ record: BrowseSessionRecord; url: string }> {
  const client = obscuraClient(rec);
  await client.navigate(url);
  let settled = url;
  try {
    const href = await client.evaluate("location.href");
    if (!isObscuraNull(href)) settled = href.trim();
  } catch {
    /* best-effort settled URL */
  }
  return {
    record: { ...rec, createdAt: Date.now(), ...(await brokerTabIdentity(client, settled)) },
    url: settled,
  };
}

/** Tear down an obscura session's broker (used by `breath close`). */
export function closeObscuraPage(sessionId: string): boolean {
  return stopObscuraSession(sessionId);
}

/** True when a broker record for this session still exists on disk. */
export function hasObscuraBroker(sessionId: string): boolean {
  return readObscuraSession(sessionId) !== null;
}
