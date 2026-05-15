import { randomUUID } from "node:crypto";
import { getKuriErrorMessage } from "../kuri/client.js";
import { recordSessionCreate, recordSessionDrop, recordSessionUpdate } from "./session-store.js";

export interface BrowseSession {
  sessionId: string;
  tabId: string;
  url: string;
  harActive: boolean;
  domain: string;
  brokerPort?: number;
  client?: BrowseSessionClient;
}

export interface BrowseTabRef {
  id: string;
  url?: string;
}

export interface BrowseSessionClient {
  start(): Promise<void>;
  newTab(): Promise<string>;
  harStart(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  discoverTabs(): Promise<BrowseTabRef[]>;
  getCurrentUrl(tabId: string): Promise<string>;
  getPort?(): number;
}

export type BrowseSessionErrorCode =
  | "no_active_session"
  | "session_id_required"
  | "session_not_found"
  | "session_expired";

export class BrowseSessionError extends Error {
  code: BrowseSessionErrorCode;
  statusCode: number;

  constructor(code: BrowseSessionErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BrowseSessionError";
    this.code = code;
    this.statusCode = browseSessionErrorStatus(code);
  }
}

const RECOVERABLE_BROWSE_FAILURES = [
  "cdp command failed",
  "transport closed",
  "target closed",
  "tab not found",
  "session closed",
  "connection refused",
  "unable to connect",
  "operation was aborted",
  "aborterror",
  "execution context was destroyed",
  "cannot find context with specified id",
  "no such target",
  "socket connection was closed unexpectedly",
  "econnreset",
];

const LIVE_CHECK_RETRIES = 3;
const LIVE_CHECK_RETRY_DELAY_MS = 100;

const sessionQueues = new Map<string, Promise<void>>();

function browseSessionErrorStatus(code: BrowseSessionErrorCode): number {
  switch (code) {
    case "session_not_found":
      return 404;
    case "no_active_session":
      return 404;
    case "session_id_required":
      return 409;
    case "session_expired":
      return 409;
  }
}

export function extractBrowseFailureMessage(value: unknown): string | null {
  return typeof value === "string" ? value : getKuriErrorMessage(value);
}

export function isRecoverableBrowseFailure(value: unknown): boolean {
  const message = extractBrowseFailureMessage(value);
  if (!message) return false;
  const normalized = message.toLowerCase();
  return RECOVERABLE_BROWSE_FAILURES.some((needle) => normalized.includes(needle));
}

function normalizeSessionId(sessionId?: string): string {
  return sessionId?.trim() || randomUUID();
}

function extractDomain(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeBrowseUrl(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function normalizeBrowsePathname(pathname: string): string {
  if (!pathname) return "/";
  return pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
}

function matchesPreferredBrowseTab(tabUrl: string | undefined, preferredUrl: string | undefined): boolean {
  const candidate = normalizeBrowseUrl(tabUrl);
  const preferred = normalizeBrowseUrl(preferredUrl);
  if (!candidate || !preferred) return false;
  if (candidate.hostname.replace(/^www\./, "") !== preferred.hostname.replace(/^www\./, "")) return false;
  return normalizeBrowsePathname(candidate.pathname) === normalizeBrowsePathname(preferred.pathname);
}

function matchesPreferredBrowseDomain(tabUrl: string | undefined, preferredUrl: string | undefined): boolean {
  const candidate = normalizeBrowseUrl(tabUrl);
  const preferred = normalizeBrowseUrl(preferredUrl);
  if (!candidate || !preferred) return false;
  return candidate.hostname.replace(/^www\./, "") === preferred.hostname.replace(/^www\./, "");
}

function isPlaceholderBrowseUrl(url: string | undefined): boolean {
  if (!url) return true;
  const normalized = url.trim().toLowerCase();
  return normalized === "about:blank"
    || normalized.startsWith("chrome://newtab")
    || normalized.startsWith("chrome://new-tab-page")
    || normalized.startsWith("edge://newtab");
}

function hasMeaningfulBrowseUrl(url: string | undefined): boolean {
  return hasKnownBrowseUrl(url) && !isPlaceholderBrowseUrl(url);
}

function cleanupSessionQueue(sessionId: string): void {
  sessionQueues.delete(sessionId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasKnownBrowseUrl(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

function resolveSessionClient(session: BrowseSession | undefined, fallback: BrowseSessionClient): BrowseSessionClient {
  const fallbackPort = fallback.getPort?.();
  if (session?.brokerPort !== undefined && fallbackPort === session.brokerPort) return fallback;
  return session?.client ?? fallback;
}

export function createRegisteredBrowseSession(
  sessions: Map<string, BrowseSession>,
  input: {
    sessionId?: string;
    tabId: string;
    url: string;
    domain: string;
    harActive?: boolean;
    brokerPort?: number;
    client?: BrowseSessionClient;
  },
): BrowseSession {
  const existing = [...sessions.values()].find((session) => session.tabId === input.tabId);
  if (existing) {
    const urlChanged = existing.url !== input.url;
    const domainChanged = existing.domain !== input.domain;
    const harChanged = input.harActive !== undefined && existing.harActive !== input.harActive;
    existing.url = input.url;
    existing.domain = input.domain;
    existing.harActive = input.harActive ?? existing.harActive;
    existing.brokerPort = input.brokerPort ?? existing.brokerPort;
    existing.client = input.client ?? existing.client;
    if (urlChanged || domainChanged || harChanged) {
      void recordSessionUpdate({
        sessionId: existing.sessionId,
        url: urlChanged ? input.url : undefined,
        domain: domainChanged ? input.domain : undefined,
        harActive: harChanged ? input.harActive : undefined,
      });
    }
    return existing;
  }

  const sessionId = normalizeSessionId(input.sessionId);
  const session: BrowseSession = {
    sessionId,
    tabId: input.tabId,
    url: input.url,
    domain: input.domain,
    harActive: input.harActive ?? true,
    brokerPort: input.brokerPort,
    client: input.client,
  };
  sessions.set(sessionId, session);
  void recordSessionCreate({
    sessionId,
    tabId: session.tabId,
    url: session.url,
    domain: session.domain,
    harActive: session.harActive,
    brokerPort: session.brokerPort,
    ts: Date.now(),
  });
  return session;
}

export function removeBrowseSession(
  sessions: Map<string, BrowseSession>,
  sessionId: string,
): BrowseSession | undefined {
  const existing = sessions.get(sessionId);
  sessions.delete(sessionId);
  cleanupSessionQueue(sessionId);
  if (existing) {
    void recordSessionDrop(sessionId);
  }
  return existing;
}

function ownedTabIds(
  sessions: Map<string, BrowseSession>,
  excludeSessionId?: string,
): Set<string> {
  return new Set(
    [...sessions.values()]
      .filter((session) => session.sessionId !== excludeSessionId)
      .map((session) => session.tabId),
  );
}

async function createBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  sessionId?: string,
): Promise<BrowseSession> {
  await client.start();
  const tabId = await client.newTab();
  if (!tabId) throw new Error("Failed to create browser tab");
  await client.harStart(tabId).catch(() => {});
  await injectInterceptor(tabId);
  return createRegisteredBrowseSession(sessions, {
    sessionId,
    tabId,
    url: "about:blank",
    domain: "",
    harActive: true,
    brokerPort: client.getPort?.(),
    client,
  });
}

async function adoptExistingBrowseTab(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  preferredUrl?: string,
  sessionId?: string,
): Promise<BrowseSession | null> {
  try {
    await client.start();
    const tabs = await client.discoverTabs();
    if (!preferredUrl) return null;
    const reservedTabs = ownedTabIds(sessions, sessionId);
    const candidate = tabs.find((tab) => {
      if (!tab.id || reservedTabs.has(tab.id)) return false;
      return matchesPreferredBrowseTab(tab.url, preferredUrl);
    });

    if (!candidate?.id) return null;
    await client.harStart(candidate.id).catch(() => {});
    await injectInterceptor(candidate.id);
    return createRegisteredBrowseSession(sessions, {
      sessionId,
      tabId: candidate.id,
      url: candidate.url ?? "about:blank",
      domain: extractDomain(candidate.url),
      harActive: true,
      brokerPort: client.getPort?.(),
      client,
    });
  } catch {
    return null;
  }
}

async function dropBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  session: BrowseSession | undefined,
): Promise<void> {
  if (!session) return;
  await resolveSessionClient(session, client).closeTab(session.tabId).catch(() => {});
  removeBrowseSession(sessions, session.sessionId);
}

export async function isBrowseSessionLive(
  session: BrowseSession,
  client: BrowseSessionClient,
): Promise<boolean> {
  const dbg = (reason: string, extra: Record<string, unknown> = {}): void => {
    if (!process.env.UNBROWSE_BROWSE_LIVENESS_DEBUG) return;
    console.warn("[browse-liveness] not live", JSON.stringify({
      session_id: session.sessionId,
      tab_id: session.tabId,
      url: session.url,
      reason,
      ...extra,
    }));
  };

  if (!session.tabId) {
    dbg("no_tab_id");
    return false;
  }
  const sessionClient = resolveSessionClient(session, client);

  try {
    await sessionClient.start();
  } catch (error) {
    if (isRecoverableBrowseFailure(error)) {
      dbg("session_client_start_recoverable", { error: String((error as Error)?.message ?? error) });
      return false;
    }
    throw error;
  }

  for (let attempt = 0; attempt < LIVE_CHECK_RETRIES; attempt += 1) {
    try {
      const tabs = await sessionClient.discoverTabs();
      let exactTab = tabs.find((tab) => tab.id === session.tabId);
      // Adopt a freshly-minted CDP target id when there's exactly one tab in a
      // restarted broker AND its url exactly matches the session url (or both
      // are placeholder). Linux runners exhibit kuri broker churn that mints a
      // new id for the same Chrome tab between calls; this rebinds the session
      // to the new id instead of failing as session_expired.
      // Tight URL match (not domain match) — different URL on same domain
      // means the user navigated to a different state we shouldn't adopt.
      if (!exactTab && tabs.length === 1) {
        const lone = tabs[0]!;
        const sameUrl = !!session.url && !!lone.url && session.url === lone.url;
        const bothPlaceholder = isPlaceholderBrowseUrl(session.url) && isPlaceholderBrowseUrl(lone.url);
        if (sameUrl || bothPlaceholder) {
          dbg("adopting_single_tab_after_id_drift", {
            old_tab_id: session.tabId,
            new_tab_id: lone.id,
            match: sameUrl ? "exact_url" : "both_placeholder",
          });
          session.tabId = lone.id;
          exactTab = lone;
        }
      }
      if (!exactTab) {
        // Distinguish empty-registry (kuri/Chrome disconnect, sometimes
        // recoverable on cold Linux runners) from tab-missing (our specific
        // tab is dead, not recoverable from here). On empty-registry, try
        // restarting the session client before giving up.
        const emptyRegistry = tabs.length === 0;
        if (emptyRegistry && attempt < LIVE_CHECK_RETRIES - 1) {
          try { await sessionClient.start(); } catch { /* ignore */ }
        }
        if (attempt < LIVE_CHECK_RETRIES - 1) {
          await sleep(emptyRegistry ? LIVE_CHECK_RETRY_DELAY_MS * 5 : LIVE_CHECK_RETRY_DELAY_MS);
          continue;
        }
        dbg("tab_not_in_discover", {
          attempt,
          discovered_tab_ids: tabs.map((t) => t.id),
          discovered_tab_count: tabs.length,
          empty_registry: emptyRegistry,
        });
        return false;
      }
      session.brokerPort = sessionClient.getPort?.() ?? session.brokerPort;
      session.client = sessionClient;
      if (hasMeaningfulBrowseUrl(exactTab.url)) {
        session.url = exactTab.url!;
        session.domain = extractDomain(session.url);
      }

      try {
        const currentUrl = await sessionClient.getCurrentUrl(session.tabId);
        if (hasMeaningfulBrowseUrl(currentUrl)) {
          session.url = currentUrl;
          session.domain = extractDomain(currentUrl);
          session.brokerPort = sessionClient.getPort?.() ?? session.brokerPort;
          session.client = sessionClient;
          return true;
        }
        if (
          isPlaceholderBrowseUrl(currentUrl)
          && isPlaceholderBrowseUrl(exactTab.url)
          && isPlaceholderBrowseUrl(session.url)
        ) {
          session.url = currentUrl || exactTab.url || session.url;
          session.domain = extractDomain(session.url);
          session.brokerPort = sessionClient.getPort?.() ?? session.brokerPort;
          session.client = sessionClient;
          return true;
        }
      } catch (error) {
        if (!isRecoverableBrowseFailure(error)) {
          dbg("get_current_url_unrecoverable", { error: String((error as Error)?.message ?? error) });
          return false;
        }
      }

      if (hasMeaningfulBrowseUrl(session.url) || hasMeaningfulBrowseUrl(exactTab.url)) {
        if (hasMeaningfulBrowseUrl(exactTab.url)) {
          session.url = exactTab.url!;
          session.domain = extractDomain(session.url);
        }
        return true;
      }
    } catch (error) {
      if (!isRecoverableBrowseFailure(error)) {
        dbg("loop_unrecoverable", { error: String((error as Error)?.message ?? error) });
        return false;
      }
    }

    if (attempt < LIVE_CHECK_RETRIES - 1) await sleep(LIVE_CHECK_RETRY_DELAY_MS);
  }

  dbg("retries_exhausted_url_check_failed");
  return false;
}

async function listLiveBrowseSessions(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
): Promise<BrowseSession[]> {
  const live: BrowseSession[] = [];
  const stale: string[] = [];

  for (const session of sessions.values()) {
    if (await isBrowseSessionLive(session, client)) {
      live.push(session);
    } else {
      stale.push(session.sessionId);
    }
  }

  for (const sessionId of stale) removeBrowseSession(sessions, sessionId);
  return live;
}

export async function resolveRequestedBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  requestedSessionId?: string,
): Promise<BrowseSession> {
  if (requestedSessionId) {
    const session = sessions.get(requestedSessionId);
    if (!session) throw new BrowseSessionError("session_not_found");
    if (!(await isBrowseSessionLive(session, client))) {
      removeBrowseSession(sessions, requestedSessionId);
      throw new BrowseSessionError("session_expired");
    }
    return session;
  }

  const live = await listLiveBrowseSessions(sessions, client);
  if (live.length === 0) throw new BrowseSessionError("no_active_session");
  // Auto-resolve only when exactly one session is live. With multiple live
  // sessions (parallel agent callers), silently picking the most recent
  // would leak Agent A's snap/close/click into Agent B's tab. Force the
  // caller to be explicit. unbrowse_go returns the session_id in its
  // response; subsequent calls must thread it back. Mirrors the
  // session_id_required behavior in getOrCreateBrowseSession (L505).
  if (live.length > 1) throw new BrowseSessionError("session_id_required");
  return live[0];
}

export async function getOrCreateBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
): Promise<BrowseSession> {
  await client.start();
  const existingSessions = [...sessions.values()];
  if (existingSessions.length === 1) {
    const existing = existingSessions[0];
    if (await isBrowseSessionLive(existing, client)) return existing;
    const preferredUrl = existing.url;
    const targetSessionId = existing.sessionId;
    const existingClient = resolveSessionClient(existing, client);
    await dropBrowseSession(sessions, existingClient, existing);
    const adopted = await adoptExistingBrowseTab(sessions, existingClient, injectInterceptor, preferredUrl, targetSessionId);
    if (adopted) return adopted;
    return createBrowseSession(sessions, existingClient, injectInterceptor, targetSessionId);
  }

  const live = await listLiveBrowseSessions(sessions, client);
  if (live.length === 1) return live[0];
  if (live.length > 1) throw new BrowseSessionError("session_id_required");

  const existing = existingSessions[0];
  const targetSessionId = existing?.sessionId;
  const preferredUrl = existing?.url;
  if (existing) await dropBrowseSession(sessions, client, existing);
  const adopted = await adoptExistingBrowseTab(sessions, client, injectInterceptor, preferredUrl, targetSessionId);
  if (adopted) return adopted;
  return createBrowseSession(sessions, client, injectInterceptor, targetSessionId);
}

export async function resetBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  sessionId?: string,
): Promise<BrowseSession> {
  await client.start();
  const existing = sessionId
    ? sessions.get(sessionId)
    : [...sessions.values()][0];
  const targetSessionId = sessionId ?? existing?.sessionId;
  const preferredUrl = existing?.url;
  const existingClient = resolveSessionClient(existing, client);
  await dropBrowseSession(sessions, existingClient, existing);
  const adopted = await adoptExistingBrowseTab(sessions, existingClient, injectInterceptor, preferredUrl, targetSessionId);
  if (adopted) return adopted;
  return createBrowseSession(sessions, existingClient, injectInterceptor, targetSessionId);
}

async function withSessionQueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const waitTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = prev.catch(() => {}).then(() => waitTurn);
  sessionQueues.set(sessionId, gate);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (sessionQueues.get(sessionId) === gate) cleanupSessionQueue(sessionId);
  }
}

export async function withRecoveredBrowseSession<T>(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  run: (session: BrowseSession) => Promise<T>,
  shouldReset?: (result: T) => boolean,
): Promise<{ session: BrowseSession; result: T; recovered: boolean }> {
  let session = await getOrCreateBrowseSession(sessions, client, injectInterceptor);

  try {
    const result = await run(session);
    if (!shouldReset || !shouldReset(result)) {
      return { session, result, recovered: false };
    }
  } catch (error) {
    if (!isRecoverableBrowseFailure(error)) throw error;
  }

  session = await resetBrowseSession(sessions, client, injectInterceptor, session.sessionId);
  const result = await run(session);
  return { session, result, recovered: true };
}

export async function withSerializedRecoveredBrowseSession<T>(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  requestedSessionId: string | undefined,
  run: (session: BrowseSession) => Promise<T>,
  shouldReset?: (result: T) => boolean,
): Promise<{ session: BrowseSession; result: T; recovered: boolean }> {
  // Recovery path: don't pre-liveness-check. The strict resolve removes the
  // session on failure, which strips the recovery wrapper's ability to reset.
  // Look up by id (or auto-pick), then let run() fail recoverably so reset
  // can swap in a fresh tab.
  let resolvedId: string;
  if (requestedSessionId) {
    if (!sessions.has(requestedSessionId)) {
      throw new BrowseSessionError("session_not_found");
    }
    resolvedId = requestedSessionId;
  } else {
    const resolved = await resolveRequestedBrowseSession(sessions, client, undefined);
    resolvedId = resolved.sessionId;
  }

  return withSessionQueue(resolvedId, async () => {
    let session = sessions.get(resolvedId);
    if (!session) throw new BrowseSessionError("session_expired");
    const sessionClient = resolveSessionClient(session, client);

    try {
      const result = await run(session);
      if (!shouldReset || !shouldReset(result)) {
        return { session, result, recovered: false };
      }
    } catch (error) {
      if (!isRecoverableBrowseFailure(error)) throw error;
    }

    session = await resetBrowseSession(sessions, sessionClient, injectInterceptor, resolvedId);
    const result = await run(session);
    return { session, result, recovered: true };
  });
}

export async function withSerializedStrictBrowseSession<T>(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  requestedSessionId: string | undefined,
  run: (session: BrowseSession) => Promise<T>,
  shouldExpire?: (result: T) => boolean,
): Promise<{ session: BrowseSession; result: T; recovered: false }> {
  const resolved = await resolveRequestedBrowseSession(sessions, client, requestedSessionId);
  return withSessionQueue(resolved.sessionId, async () => {
    const session = sessions.get(resolved.sessionId);
    if (!session) throw new BrowseSessionError("session_expired");

    const live = await isBrowseSessionLive(session, client);
    if (!live) {
      removeBrowseSession(sessions, resolved.sessionId);
      throw new BrowseSessionError("session_expired");
    }

    try {
      const result = await run(session);
      if (shouldExpire?.(result)) {
        const stillLive = await isBrowseSessionLive(session, client);
        if (!stillLive) {
          removeBrowseSession(sessions, resolved.sessionId);
          throw new BrowseSessionError("session_expired");
        }
      }
      return { session, result, recovered: false };
    } catch (error) {
      if (error instanceof BrowseSessionError) throw error;
      if (isRecoverableBrowseFailure(error)) {
        const stillLive = await isBrowseSessionLive(session, client);
        if (!stillLive) {
          removeBrowseSession(sessions, resolved.sessionId);
          throw new BrowseSessionError("session_expired");
        }
      }
      throw error;
    }
  });
}

export async function getOrCreateNavigateBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  requestedSessionId?: string,
): Promise<BrowseSession> {
  if (requestedSessionId) {
    const session = sessions.get(requestedSessionId);
    if (!session) throw new BrowseSessionError("session_not_found");
    return session;
  }
  return createBrowseSession(sessions, client, injectInterceptor);
}

export interface SnapResponseInput {
  snapshot: unknown;
  session: BrowseSession;
  currentUrl: string | null | undefined;
}

export interface SnapResponse {
  snapshot: unknown;
  session_id: string;
  tab_id: string;
  current_url: string;
  current_domain: string;
  landed_domain_mismatch?: true;
  expected_domain?: string;
}

/**
 * Build the response for /v1/browse/snap. Surfaces the observed url and
 * domain so the calling agent can detect when the tab has drifted away
 * from the page it opened (e.g. a redirect to a captcha, or an unrelated
 * tab adopted under the same sessionId). The substrate reports what it
 * sees; the agent judges whether that matches the user intent.
 */
export function buildSnapResponse(input: SnapResponseInput): SnapResponse {
  const { snapshot, session, currentUrl } = input;
  const observedUrl = typeof currentUrl === "string" && currentUrl.startsWith("http")
    ? currentUrl
    : session.url;
  const observedDomain = extractDomain(observedUrl) || session.domain;

  const response: SnapResponse = {
    snapshot,
    session_id: session.sessionId,
    tab_id: session.tabId,
    current_url: observedUrl,
    current_domain: observedDomain,
  };

  const expectedDomain = session.domain;
  if (
    typeof currentUrl === "string"
    && currentUrl.startsWith("http")
    && expectedDomain
    && observedDomain
    && expectedDomain !== observedDomain
  ) {
    response.landed_domain_mismatch = true;
    response.expected_domain = expectedDomain;
  }

  return response;
}
