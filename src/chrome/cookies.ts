// chrome.cookies.* — stateless shape, backed by KvChain (no real Chrome).
//
// Each function mirrors the chrome.cookies.* extension API verbatim
// (https://developer.chrome.com/docs/extensions/reference/cookies/).
// The backing impl routes through KvChain (sealed-cache + ledger) —
// no Chrome process is spawned, no CDP round-trip happens. The state
// lives in the KV chain, durable across unbrowse invocations.
//
// Cookies are keyed `cookie:<host>:<name>` in the chain. Multiple cookies
// with the same name on different paths are keyed separately (the path
// becomes part of the value's metadata, not the key — the key is the
// (host, name) tuple, which is what chrome.cookies.getAll filters on).

import { KvChain } from "./kv-chain.js";

/** chrome.cookies.Cookie — mirrors the chrome extension type. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "no_restriction" | "lax" | "strict";
  session: boolean;
  expirationDate?: number;
  storeId: string;
}

/** chrome.cookies.GetAllDetails — filter shape. */
export interface GetAllDetails {
  url?: string;
  name?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  session?: boolean;
  storeId?: string;
}

/** chrome.cookies.SetDetails — write shape. */
export interface SetDetails {
  url?: string;
  name: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  storeId?: string;
}

/** chrome.cookies.CookieStore — one per KvChain. */
export interface CookieStore {
  id: string;
  chain: KvChain;
}

/** Build a CookieStore over a KvChain. Stateless — no Chrome process. */
export function createStore(chain: KvChain, id = "0"): CookieStore {
  return { id, chain };
}

/** chrome.cookies.getAll — return cookies matching the filter.
 *  Stateless read from the KV chain (tier-1 fast path). */
export async function getAll(
  store: CookieStore,
  details: GetAllDetails = {},
): Promise<Cookie[]> {
  // The KV chain doesn't expose enumeration directly; for Layer 1 we use a
  // secondary index under `cookie:_index:<host>` that tracks the set of
  // (name) keys for each host. getAll walks the index, opens each cookie,
  // and filters in-process.
  const hosts = details.domain
    ? [details.domain]
    : details.url
      ? [safeHost(details.url)]
      : await listAllHosts(store);
  const out: Cookie[] = [];
  for (const host of hosts) {
    if (!host) continue;
    const names = await listNamesForHost(store, host);
    for (const name of names) {
      const c = await store.chain.open<Cookie>(cookieKey(host, name));
      if (!c) continue;
      if (details.name && c.name !== details.name) continue;
      if (details.path && c.path !== details.path) continue;
      if (details.secure !== undefined && c.secure !== details.secure) continue;
      if (details.session !== undefined && c.session !== details.session) continue;
      if (details.url && !cookieMatchesUrl(c, details.url)) continue;
      out.push(c);
    }
  }
  return out;
}

/** chrome.cookies.set — create or overwrite a cookie. Returns the written
 *  cookie or null if the write failed. Writes through the full KV chain:
 *  tier-1 sealed cache + tier-2 ledger row (the IQ tier). */
export async function set(
  store: CookieStore,
  details: SetDetails,
): Promise<Cookie | null> {
  if (!details.url && !details.domain) {
    throw new Error("chrome.cookies.set: url or domain is required");
  }
  const url = details.url;
  const domain = details.domain ?? (url ? safeHost(url) : "");
  if (!domain) {
    throw new Error("chrome.cookies.set: could not derive domain from details");
  }
  const name = details.name;
  const path = details.path ?? "/";
  const cookie: Cookie = {
    name,
    value: details.value ?? "",
    domain,
    hostOnly: !details.domain && !!url, // host-only when domain wasn't explicit
    path,
    secure: details.secure ?? false,
    httpOnly: details.httpOnly ?? false,
    sameSite: details.sameSite ?? "no_restriction",
    session: details.expirationDate === undefined,
    expirationDate: details.expirationDate,
    storeId: details.storeId ?? store.id,
  };
  // Write the cookie + update the host's name index.
  await store.chain.put(cookieKey(domain, name), cookie);
  await addNameToHostIndex(store, domain, name);
  return cookie;
}

/** chrome.cookies.remove — delete a cookie. Returns the removed cookie's
 *  url+name, or null if it didn't exist. Writes a tombstone row. */
export async function remove(
  store: CookieStore,
  details: { url: string; name: string; storeId?: string },
): Promise<{ url: string; name: string; storeId: string } | null> {
  const host = safeHost(details.url);
  if (!host) return null;
  const existing = await store.chain.open<Cookie>(cookieKey(host, details.name));
  if (!existing) return null;
  await store.chain.del(cookieKey(host, details.name));
  await removeNameFromHostIndex(store, host, details.name);
  return { url: details.url, name: details.name, storeId: details.storeId ?? store.id };
}

/** chrome.cookies.getAllCookieStores — one store for now (the KvChain). */
export async function getAllCookieStores(store: CookieStore): Promise<CookieStore[]> {
  return [store];
}

/** chrome.cookies.onChanged — event stub. Stateless impl has no events;
 *  callers poll getAll() or replay the ledger. Returns a no-op unsub. */
export function onChanged(_store: CookieStore, _cb: (change: { removed: boolean; cookie: Cookie; cause: string }) => void): () => void {
  return () => { /* no-op — ledger replay is the durable source */ };
}

// ─── key layout + index helpers ─────────────────────────────────────────────

function cookieKey(host: string, name: string): string {
  return `cookie:${host}:${name}`;
}

function hostIndexKey(host: string): string {
  return `cookie:_index:${host}`;
}

function allHostsIndexKey(): string {
  return "cookie:_index:_all_hosts";
}

async function listNamesForHost(store: CookieStore, host: string): Promise<string[]> {
  const names = await store.chain.open<string[]>(hostIndexKey(host));
  return names ?? [];
}

async function listAllHosts(store: CookieStore): Promise<string[]> {
  const hosts = await store.chain.open<string[]>(allHostsIndexKey());
  return hosts ?? [];
}

async function addNameToHostIndex(store: CookieStore, host: string, name: string): Promise<void> {
  const names = await listNamesForHost(store, host);
  if (!names.includes(name)) {
    await store.chain.put(hostIndexKey(host), [...names, name]);
  }
  const hosts = await listAllHosts(store);
  if (!hosts.includes(host)) {
    await store.chain.put(allHostsIndexKey(), [...hosts, host]);
  }
}

async function removeNameFromHostIndex(store: CookieStore, host: string, name: string): Promise<void> {
  const names = await listNamesForHost(store, host);
  if (names.includes(name)) {
    await store.chain.put(hostIndexKey(host), names.filter((n) => n !== name));
  }
}

// ─── url/domain match (subset of chrome's rules) ─────────────────────────────

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function cookieMatchesUrl(c: Cookie, url: string): boolean {
  let host: string;
  let path: string;
  let isSecure: boolean;
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
    isSecure = u.protocol === "https:";
  } catch {
    return false;
  }
  // domain match: c.domain is either a host or a dot-prefixed domain
  const cd = c.domain.replace(/^\./, "").toLowerCase();
  const hostLower = host.toLowerCase();
  if (cd !== hostLower && !hostLower.endsWith(`.${cd}`)) return false;
  // path prefix match
  if (!path.startsWith(c.path)) return false;
  // secure cookie must only be sent over https
  if (c.secure && !isSecure) return false;
  return true;
}
