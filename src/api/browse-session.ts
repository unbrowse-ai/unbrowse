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
];

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

function cleanupSessionQueue(sessionId: string): void {
  sessionQueues.delete(sessionId);
}

function resolveSessionClient(session: BrowseSession | undefined, fallback: BrowseSessionClient): BrowseSessionClient {
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
  await client.start().catch(() => {});
  const tabId = await client.newTab();
  if (!tabId) throw new Error("failed to create browse tab");
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
  preferredDomain?: string,
  sessionId?: string,
): Promise<BrowseSession | null> {
  try {
    const tabs = await client.discoverTabs();
    const normalizedPreferred = preferredDomain?.replace(/^www\./, "") ?? "";
    const reservedTabs = ownedTabIds(sessions, sessionId);
    const candidate =
      tabs.find((tab) => {
        if (!tab.id || reservedTabs.has(tab.id)) return false;
        const domain = extractDomain(tab.url);
        return !!domain && !!normalizedPreferred && domain === normalizedPreferred;
      }) ??
      tabs.find((tab) => tab.id && !reservedTabs.has(tab.id) && /^https?:\/\//.test(tab.url ?? ""));

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
  if (!session.tabId) return false;
  const sessionClient = resolveSessionClient(session, client);

  try {
    const tabs = await sessionClient.discoverTabs();
    if (!tabs.some((tab) => tab.id === session.tabId)) return false;
    const currentUrl = await sessionClient.getCurrentUrl(session.tabId);
    return typeof currentUrl === "string" && currentUrl.length > 0;
  } catch {
    return false;
  }
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
  const existingSessions = [...sessions.values()];
  if (existingSessions.length === 1) {
    const existing = existingSessions[0];
    if (await isBrowseSessionLive(existing, client)) return existing;
    const preferredDomain = existing.domain || extractDomain(existing.url);
    const targetSessionId = existing.sessionId;
    const existingClient = resolveSessionClient(existing, client);
    await dropBrowseSession(sessions, existingClient, existing);
    const adopted = await adoptExistingBrowseTab(sessions, existingClient, injectInterceptor, preferredDomain, targetSessionId);
    if (adopted) return adopted;
    return createBrowseSession(sessions, existingClient, injectInterceptor, targetSessionId);
  }

  const live = await listLiveBrowseSessions(sessions, client);
  if (live.length === 1) return live[0];
  if (live.length > 1) throw new BrowseSessionError("session_id_required");

  const existing = existingSessions[0];
  const targetSessionId = existing?.sessionId;
  const preferredDomain = existing?.domain || extractDomain(existing?.url);
  if (existing) await dropBrowseSession(sessions, client, existing);
  const adopted = await adoptExistingBrowseTab(sessions, client, injectInterceptor, preferredDomain, targetSessionId);
  if (adopted) return adopted;
  return createBrowseSession(sessions, client, injectInterceptor, targetSessionId);
}

export async function resetBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  sessionId?: string,
): Promise<BrowseSession> {
  const existing = sessionId
    ? sessions.get(sessionId)
    : [...sessions.values()][0];
  const targetSessionId = sessionId ?? existing?.sessionId;
  const preferredDomain = existing?.domain || extractDomain(existing?.url);
  const existingClient = resolveSessionClient(existing, client);
  await dropBrowseSession(sessions, existingClient, existing);
  const adopted = await adoptExistingBrowseTab(sessions, existingClient, injectInterceptor, preferredDomain, targetSessionId);
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
        removeBrowseSession(sessions, resolved.sessionId);
        throw new BrowseSessionError("session_expired");
      }
      return { session, result, recovered: false };
    } catch (error) {
      if (error instanceof BrowseSessionError) throw error;
      if (isRecoverableBrowseFailure(error)) {
        removeBrowseSession(sessions, resolved.sessionId);
        throw new BrowseSessionError("session_expired");
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
