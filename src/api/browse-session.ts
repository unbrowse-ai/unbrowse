import { getKuriErrorMessage } from "../kuri/client.js";

export interface BrowseSession {
  tabId: string;
  url: string;
  harActive: boolean;
  domain: string;
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

export function extractBrowseFailureMessage(value: unknown): string | null {
  return typeof value === "string" ? value : getKuriErrorMessage(value);
}

export function isRecoverableBrowseFailure(value: unknown): boolean {
  const message = extractBrowseFailureMessage(value);
  if (!message) return false;
  const normalized = message.toLowerCase();
  return RECOVERABLE_BROWSE_FAILURES.some((needle) => normalized.includes(needle));
}

async function createBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
): Promise<BrowseSession> {
  await client.start().catch(() => {});
  const tabId = await client.newTab();
  await client.harStart(tabId).catch(() => {});
  await injectInterceptor(tabId);
  const session: BrowseSession = { tabId, url: "about:blank", harActive: true, domain: "" };
  sessions.set("default", session);
  return session;
}

function extractDomain(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function adoptExistingBrowseTab(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
  preferredDomain?: string,
): Promise<BrowseSession | null> {
  try {
    const tabs = await client.discoverTabs();
    const normalizedPreferred = preferredDomain?.replace(/^www\./, "") ?? "";
    const candidate =
      tabs.find((tab) => {
        const domain = extractDomain(tab.url);
        return !!domain && !!normalizedPreferred && domain === normalizedPreferred;
      }) ??
      tabs.find((tab) => /^https?:\/\//.test(tab.url ?? ""));

    if (!candidate?.id) return null;
    await client.harStart(candidate.id).catch(() => {});
    await injectInterceptor(candidate.id);
    const session: BrowseSession = {
      tabId: candidate.id,
      url: candidate.url ?? "about:blank",
      harActive: true,
      domain: extractDomain(candidate.url),
    };
    sessions.set("default", session);
    return session;
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
  await client.closeTab(session.tabId).catch(() => {});
  if (sessions.get("default")?.tabId === session.tabId) {
    sessions.delete("default");
  }
}

export async function isBrowseSessionLive(
  session: BrowseSession,
  client: BrowseSessionClient,
): Promise<boolean> {
  if (!session.tabId) return false;

  try {
    const tabs = await client.discoverTabs();
    if (!tabs.some((tab) => tab.id === session.tabId)) return false;
    const currentUrl = await client.getCurrentUrl(session.tabId);
    return typeof currentUrl === "string" && currentUrl.length > 0;
  } catch {
    return false;
  }
}

export async function resetBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
): Promise<BrowseSession> {
  const existing = sessions.get("default");
  const preferredDomain = existing?.domain || extractDomain(existing?.url);
  await dropBrowseSession(sessions, client, existing);
  const adopted = await adoptExistingBrowseTab(sessions, client, injectInterceptor, preferredDomain);
  if (adopted) return adopted;
  return createBrowseSession(sessions, client, injectInterceptor);
}

export async function getOrCreateBrowseSession(
  sessions: Map<string, BrowseSession>,
  client: BrowseSessionClient,
  injectInterceptor: (tabId: string) => Promise<unknown>,
): Promise<BrowseSession> {
  const existing = sessions.get("default");
  if (existing && await isBrowseSessionLive(existing, client)) return existing;
  const preferredDomain = existing?.domain || extractDomain(existing?.url);
  if (existing) await dropBrowseSession(sessions, client, existing);
  const adopted = await adoptExistingBrowseTab(sessions, client, injectInterceptor, preferredDomain);
  if (adopted) return adopted;
  return createBrowseSession(sessions, client, injectInterceptor);
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

  session = await resetBrowseSession(sessions, client, injectInterceptor);
  const result = await run(session);
  return { session, result, recovered: true };
}
