/**
 * W4-F: `unbrowse cookies` subcommand — remote cookie jar opt-in.
 *
 * Backend wave-1 shipped the encrypted vault at /v1/account/cookies/*;
 * this command is the CLI side that puts cookies into it and pulls them
 * back when the user opts in. Opt-in is per-invocation: nothing happens
 * to your cookies unless you run `unbrowse cookies push <domain>`.
 *
 * Vault encryption (recap from the backend service docs):
 *  - per-user data key, wrapped AES-GCM by COOKIE_VAULT_MASTER_KEY
 *  - ciphertext stored in KV under cookievault:<user_id>:<domain>
 *  - cross-user pull returns 403 (verified by no-mock tests in wave 1)
 *
 * Auth: uses the same API key as the rest of the CLI (resolved by
 * cli-config.ts). Returns a process exit code per UNIX convention so
 * scripted callers can chain.
 */

import { getApiKey } from "./client/index.js";
import { DEFAULT_BACKEND_URL } from "./version.js";

const BACKEND_URL = process.env.UNBROWSE_BACKEND_URL || DEFAULT_BACKEND_URL;

interface CookieRecord {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

interface SyncedDomain {
  domain: string;
  last_sync: string;
  cookie_count: number;
}

function log(msg: string): void {
  console.log(`[cookies] ${msg}`);
}
function warn(msg: string): void {
  console.warn(`[cookies] ${msg}`);
}

function getBearer(): string {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      "no API key configured; run `unbrowse account --register --email you@example.com` first",
    );
  }
  return key;
}

async function authedFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getBearer()}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      return j.message ?? j.error ?? text;
    } catch {
      return text || res.statusText;
    }
  } catch {
    return res.statusText;
  }
}

async function listSynced(): Promise<SyncedDomain[]> {
  const res = await authedFetch("GET", "/v1/account/cookies");
  if (res.status === 503) {
    warn("cookie cloud sync is not enabled on this deployment yet (FLEX_COOKIE_VAULT_MASTER_KEY unset on the worker)");
    return [];
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await readErrorBody(res)}`);
  }
  const json = (await res.json()) as { domains: SyncedDomain[] };
  return Array.isArray(json.domains) ? json.domains : [];
}

async function harvestCookiesForDomain(domain: string): Promise<CookieRecord[]> {
  // Source priority: real Chrome/Firefox SQLite -> local Kuri user-data-dir.
  // We reuse the same harvester the resolve/fetch path already uses so the
  // push covers the same cookies a real call would have used.
  try {
    const { findBestBrowserSession } = await import("./auth/browser-cookies.js");
    const session = findBestBrowserSession(domain);
    if (session?.cookies?.length) {
      return session.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));
    }
  } catch (err) {
    warn(`browser-cookies harvester unavailable: ${(err as Error).message}`);
  }
  return [];
}

async function cmdPush(domain: string): Promise<number> {
  if (!domain) {
    warn("usage: unbrowse cookies push <domain>");
    return 2;
  }
  const cookies = await harvestCookiesForDomain(domain);
  if (cookies.length === 0) {
    warn(`no cookies found for ${domain} in any local browser; sign in via the browser first or run \`unbrowse auth ${domain}\``);
    return 1;
  }
  const res = await authedFetch("PUT", `/v1/account/cookies/${encodeURIComponent(domain)}`, {
    cookies,
  });
  if (res.status === 503) {
    warn("cookie cloud sync is not enabled on this deployment yet (vault master key unset)");
    return 1;
  }
  if (!res.ok) {
    warn(`push failed: HTTP ${res.status}: ${await readErrorBody(res)}`);
    return 1;
  }
  const body = (await res.json()) as { domain: string; cookie_count: number; last_sync: string };
  log(`pushed ${body.cookie_count} cookie${body.cookie_count === 1 ? "" : "s"} for ${body.domain} (synced ${body.last_sync})`);
  return 0;
}

async function cmdPull(domain: string): Promise<number> {
  if (!domain) {
    warn("usage: unbrowse cookies pull <domain>");
    return 2;
  }
  const res = await authedFetch("GET", `/v1/account/cookies/${encodeURIComponent(domain)}`);
  if (res.status === 503) {
    warn("cookie cloud sync is not enabled on this deployment yet");
    return 1;
  }
  if (res.status === 404) {
    warn(`no synced cookies for ${domain}; push from a machine where you are signed in first`);
    return 1;
  }
  if (!res.ok) {
    warn(`pull failed: HTTP ${res.status}: ${await readErrorBody(res)}`);
    return 1;
  }
  const body = (await res.json()) as { domain: string; cookies: CookieRecord[] };
  // Auto-injection into the local Kuri profile is wave-5: the existing
  // browser-cookies harvester reads real Chrome/Firefox SQLite, but the
  // symmetric write path (push into Kuri's per-domain cookie store) is
  // a separate primitive that needs Kuri-side support. Until then, print
  // the cookie set as JSON so users can pipe it into their own injector.
  log(`pulled ${body.cookies.length} cookie${body.cookies.length === 1 ? "" : "s"} for ${body.domain}; auto-inject lands in wave 5`);
  console.log(JSON.stringify({ domain: body.domain, cookies: body.cookies }, null, 2));
  return 0;
}

async function cmdList(): Promise<number> {
  const domains = await listSynced();
  if (domains.length === 0) {
    log("no domains synced. push one with `unbrowse cookies push <domain>`.");
    return 0;
  }
  log(`${domains.length} synced domain${domains.length === 1 ? "" : "s"}:`);
  for (const d of domains) {
    console.log(`  ${d.domain.padEnd(40)} ${d.cookie_count} cookie${d.cookie_count === 1 ? "" : "s"}  last sync ${d.last_sync}`);
  }
  return 0;
}

async function cmdRemove(domain: string): Promise<number> {
  if (!domain) {
    warn("usage: unbrowse cookies remove <domain>");
    return 2;
  }
  const res = await authedFetch("DELETE", `/v1/account/cookies/${encodeURIComponent(domain)}`);
  if (!res.ok && res.status !== 404) {
    warn(`remove failed: HTTP ${res.status}: ${await readErrorBody(res)}`);
    return 1;
  }
  log(`removed ${domain} from your remote cookie vault`);
  return 0;
}

async function cmdPurge(flags: Record<string, unknown>): Promise<number> {
  if (!flags.yes) {
    warn("refusing to purge without --yes; this deletes every synced domain's encrypted cookies");
    return 2;
  }
  const res = await authedFetch("DELETE", "/v1/account/cookies");
  if (!res.ok) {
    warn(`purge failed: HTTP ${res.status}: ${await readErrorBody(res)}`);
    return 1;
  }
  const body = (await res.json()) as { purged_domains: number };
  log(`purged ${body.purged_domains} domain${body.purged_domains === 1 ? "" : "s"} from the vault`);
  return 0;
}

export async function cmdCookies(
  args: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const sub = args[1];
  const target = args[2];
  let code = 0;
  switch (sub) {
    case "push":
      code = await cmdPush(target);
      break;
    case "pull":
      code = await cmdPull(target);
      break;
    case "list":
    case undefined:
      code = await cmdList();
      break;
    case "remove":
    case "rm":
      code = await cmdRemove(target);
      break;
    case "purge":
      code = await cmdPurge(flags);
      break;
    default:
      warn(`unknown subcommand: ${sub}`);
      warn("usage: unbrowse cookies [list|push <domain>|pull <domain>|remove <domain>|purge --yes]");
      code = 2;
  }
  if (code !== 0) process.exit(code);
}
