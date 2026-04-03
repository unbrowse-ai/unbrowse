import { randomUUID } from "node:crypto";
import { getKuriErrorMessage } from "../kuri/client.js";

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
  "execution context was destroyed",
  "cannot find context with specified id",
  "no such target",
  "socket connection was closed unexpectedly",
  "econnreset",
];

const LIVE_CHECK_RETRIES = 8;
const LIVE_CHECK_RETRY_DELAY_MS = 250;

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

function pickLiveBrowseTab(
  tabs: BrowseTabRef[],
  sessionTabId: string,
  preferredUrl: string | undefined,
  fallbackUrl: string | undefined,
): BrowseTabRef | undefined {
  const exact = tabs.find((tab) => tab.id === sessionTabId);
  if (exact && !isPlaceholderBrowseUrl(exact.url)) return exact;

  const preferredReal = tabs.find((tab) => {
    if (isPlaceholderBrowseUrl(tab.url)) return false;
    return matchesPreferredBrowseTab(tab.url, preferredUrl)
      || matchesPreferredBrowseTab(tab.url, fallbackUrl);
  });
  if (preferredReal) return preferredReal;

  if (exact) return exact;

  return tabs.find((tab) => matchesPreferredBrowseTab(tab.url, preferredUrl)
    || matchesPreferredBrowseTab(tab.url, fallbackUrl));
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
    existing.url = input.url;
    existing.domain = input.domain;
    existing.harActive = input.harActive ?? existing.harActive;
    existing.brokerPort = input.brokerPort ?? existing.brokerPort;
    existing.client = input.client ?? existing.client;
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
  return session;
}

export function removeBrowseSession(
  sessions: Map<string, BrowseSession>,
  sessionId: string,
): BrowseSession | undefined {
  const existing = sessions.get(sessionId);
  sessions.delete(sessionId);
  cleanupSessionQueue(sessionId);
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

export async function rebindBrowseSessionToMatchingTab(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  sessionId: string,
  preferredUrl?: string,
): Promise<BrowseSession | null> {
  const existing = sessions.get(sessionId);
  if (!existing) return null;
  const rebound = await adoptExistingBrowseTab(
    sessions,
    resolveSessionClient(existing, client),
    injectInterceptor,
    preferredUrl ?? existing.url,
    sessionId,
  );
  if (!rebound) return null;
  existing.tabId = rebound.tabId;
  existing.url = rebound.url;
  existing.domain = rebound.domain;
  existing.harActive = rebound.harActive;
  existing.brokerPort = rebound.brokerPort;
  existing.client = rebound.client;
  sessions.set(sessionId, existing);
  return existing;
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
  if (!session.tabId) return false;
  const sessionClient = resolveSessionClient(session, client);
  let tabSeen = false;
  let lastKnownUrl = session.url;

  try {
    await sessionClient.start();
  } catch (error) {
    if (isRecoverableBrowseFailure(error)) return false;
    throw error;
  }

  for (let attempt = 0; attempt < LIVE_CHECK_RETRIES; attempt += 1) {
    try {
      const tabs = await sessionClient.discoverTabs();
      const liveTab = pickLiveBrowseTab(tabs, session.tabId, session.url, lastKnownUrl);
      if (!liveTab) {
        if (attempt < LIVE_CHECK_RETRIES - 1) {
          await sleep(LIVE_CHECK_RETRY_DELAY_MS);
          continue;
        }
        return false;
      }
      if (liveTab.id !== session.tabId) {
        session.tabId = liveTab.id;
        session.url = liveTab.url ?? session.url;
        session.domain = extractDomain(session.url);
        session.brokerPort = sessionClient.getPort?.() ?? session.brokerPort;
        session.client = sessionClient;
      }
      tabSeen = true;
      if (hasMeaningfulBrowseUrl(liveTab.url)) lastKnownUrl = liveTab.url!;

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
          liveTab.id === session.tabId
          && isPlaceholderBrowseUrl(currentUrl)
          && isPlaceholderBrowseUrl(liveTab.url)
          && isPlaceholderBrowseUrl(session.url)
        ) {
          session.url = currentUrl || liveTab.url || session.url;
          session.domain = extractDomain(session.url);
          session.brokerPort = sessionClient.getPort?.() ?? session.brokerPort;
          session.client = sessionClient;
          return true;
        }
      } catch (error) {
        if (!isRecoverableBrowseFailure(error)) return false;
      }

      if (hasMeaningfulBrowseUrl(lastKnownUrl)) {
        session.url = lastKnownUrl;
        session.domain = extractDomain(lastKnownUrl);
        session.brokerPort = sessionClient.getPort?.() ?? session.brokerPort;
        session.client = sessionClient;
        return true;
      }
    } catch (error) {
      if (!isRecoverableBrowseFailure(error)) return false;
    }

    if (attempt < LIVE_CHECK_RETRIES - 1) await sleep(LIVE_CHECK_RETRY_DELAY_MS);
  }

  return tabSeen && hasMeaningfulBrowseUrl(lastKnownUrl);
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
    return session;
  }

  const live = await listLiveBrowseSessions(sessions, client);
  if (live.length === 0) throw new BrowseSessionError("no_active_session");
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
  const resolved = await resolveRequestedBrowseSession(sessions, client, requestedSessionId);
  return withSessionQueue(resolved.sessionId, async () => {
    let session = sessions.get(resolved.sessionId);
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

    session = await resetBrowseSession(sessions, sessionClient, injectInterceptor, resolved.sessionId);
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

  const live = await listLiveBrowseSessions(sessions, client);
  if (live.length === 0) return createBrowseSession(sessions, client, injectInterceptor);
  if (live.length > 1) throw new BrowseSessionError("session_id_required");
  return live[0];
}
