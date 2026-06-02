// CDP_PRIMITIVES.md §iproyal-proxy-as-breath-effect — geo.iproyal.com:12321 builder
//
// Eph 6:11 — "Put on the whole armor of God, that you may be able to stand
// against the wiles of the devil." The proxy is the network-layer armor;
// without it, every CDP-level spoof above is a paper helm. iproyal supplies
// the residential exit IP; the URL form below carries country-lock + sticky
// session into the upstream's auth grammar.
//
// W13 — real impl. Reads creds from ~/.identity/iproyal-creds (mode 600 JSON
// or KV-pair file; both forms accepted). Returns honest 503-shaped envelope
// when creds are absent — never crashes the caller.

import { readFile, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProxyConfig } from "../types.js";

export const DEFAULT_IPROYAL_HOST = "geo.iproyal.com";
export const DEFAULT_IPROYAL_PORT = 12321;
export const IPROYAL_CREDS_PATH = join(homedir(), ".identity", "iproyal-creds");

export interface IproyalCreds {
  username: string;
  password: string;
  host: string;
  port: number;
}

export type IproyalLoadResult =
  | { ok: true; creds: IproyalCreds }
  | {
      ok: false;
      status: 503;
      error: "iproyal_creds_missing" | "iproyal_creds_malformed" | "iproyal_creds_unreadable";
      path: string;
      hint: string;
    };

/**
 * Load iproyal creds from ~/.identity/iproyal-creds. Accepts BOTH:
 *  - JSON form: `{"user":"u","pass":"p","host":"geo.iproyal.com","port":12321}`
 *    (also accepts `username`/`password` keys interchangeably)
 *  - KV form (one per line): `username=u\npassword=p\nendpoint=host:port`
 *
 * Returns an envelope-shaped result — no exceptions on the missing-file or
 * malformed paths. Caller emits the envelope to the user and falls through
 * to direct-connect mode.
 */
export async function load(): Promise<IproyalLoadResult> {
  const path = IPROYAL_CREDS_PATH;
  let raw: string;
  try {
    const st = await stat(path);
    if (!st.isFile()) {
      return {
        ok: false,
        status: 503,
        error: "iproyal_creds_missing",
        path,
        hint: `path exists but is not a regular file. Replace with a 600-perm JSON or KV file (see ~/.claude/projects/-Users-lekt9-Projects-unbrowse-ecosystem-unbrowse/memory/reference_iproyal_proxy.md).`,
      };
    }
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        status: 503,
        error: "iproyal_creds_missing",
        path,
        hint: `create ${path} (mode 600). Two formats accepted: JSON {"user":"...","pass":"...","host":"geo.iproyal.com","port":12321} OR KV pairs (username=..., password=..., endpoint=host:port).`,
      };
    }
    return {
      ok: false,
      status: 503,
      error: "iproyal_creds_unreadable",
      path,
      hint: `read failed: ${code ?? (err instanceof Error ? err.message : String(err))}`,
    };
  }

  const parsed = parseCreds(raw);
  if (!parsed) {
    return {
      ok: false,
      status: 503,
      error: "iproyal_creds_malformed",
      path,
      hint: `file present but missing user/pass fields. JSON keys: user|username + pass|password (host/port optional). KV keys: username, password, endpoint=host:port (or host=..., port=...).`,
    };
  }
  return { ok: true, creds: parsed };
}

let _syncCache: { creds: IproyalCreds | null; mtimeMs: number } | undefined;

/**
 * Synchronous, mtime-cached creds-file loader for the hot fetch path
 * (`resolveProxyUrl` in execution/proxy-fetch). Reads ~/.identity/iproyal-creds
 * — the SAME file the browser/CDP proxy path uses — so one creds file drives
 * both the browser and the HTTP-fetch egress (the network-descent layer of the
 * stack). Returns null when the file is missing/malformed; the caller falls
 * through to the next proxy in precedence. The secret never lives in source.
 */
export function loadCredsFileSync(): IproyalCreds | null {
  try {
    const st = statSync(IPROYAL_CREDS_PATH);
    if (_syncCache && _syncCache.mtimeMs === st.mtimeMs) return _syncCache.creds;
    const creds = parseCreds(readFileSync(IPROYAL_CREDS_PATH, "utf8"));
    _syncCache = { creds, mtimeMs: st.mtimeMs };
    return creds;
  } catch {
    return null;
  }
}

function parseCreds(raw: string): IproyalCreds | null {
  // Try JSON first.
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const user = pickString(obj, "user", "username");
      const pass = pickString(obj, "pass", "password");
      if (!user || !pass) return null;
      const host = pickString(obj, "host") || DEFAULT_IPROYAL_HOST;
      const portRaw = obj.port;
      const port =
        typeof portRaw === "number"
          ? portRaw
          : typeof portRaw === "string" && /^\d+$/.test(portRaw)
            ? Number(portRaw)
            : DEFAULT_IPROYAL_PORT;
      return { username: user, password: pass, host, port };
    } catch {
      return null;
    }
  }
  // KV form.
  const out: Partial<IproyalCreds> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k === "username" || k === "user") out.username = v;
    else if (k === "password" || k === "pass") out.password = v;
    else if (k === "host") out.host = v;
    else if (k === "port") out.port = /^\d+$/.test(v) ? Number(v) : undefined;
    else if (k === "endpoint") {
      const [h, p] = v.split(":");
      if (h) out.host = h;
      if (p && /^\d+$/.test(p)) out.port = Number(p);
    }
  }
  if (!out.username || !out.password) return null;
  return {
    username: out.username,
    password: out.password,
    host: out.host || DEFAULT_IPROYAL_HOST,
    port: out.port || DEFAULT_IPROYAL_PORT,
  };
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Build the credential-embedded URL form (per reference_iproyal_proxy memory).
 * Country lock encodes into the password as `<password>_country-<iso2>`.
 * Sticky session encodes as `_session-<id>`. Both URL-encoded.
 *
 * Returned form: `http://<user>:<pass>@<host>:<port>` — used by upstreams
 * that accept embedded creds (libcurl-impersonate front, generic
 * HTTP-CONNECT). Chrome's `--proxy-server` does NOT accept embedded creds;
 * for that path, see `buildIproyalProxy()` which returns the bare server
 * URL and lets `auth-challenge.ts` satisfy auth at request time.
 */
export function buildIproyalProxyUrl(opts: {
  user: string;
  pass: string;
  host: string;
  port: number;
  country?: string;
  sessionId?: string;
}): string {
  const passWithMeta = decoratePassword(opts.pass, opts.country, opts.sessionId);
  const u = encodeURIComponent(opts.user);
  const p = encodeURIComponent(passWithMeta);
  return `http://${u}:${p}@${opts.host}:${opts.port}`;
}

function decoratePassword(pass: string, country?: string, sessionId?: string): string {
  let out = pass;
  if (country) out += `_country-${country.toLowerCase()}`;
  if (sessionId) out += `_session-${sessionId}`;
  return out;
}

/**
 * Build a ProxyConfig pointed at iproyal. Returns the BARE server URL (no
 * embedded creds) plus username/password fields so the caller can either
 * (a) use --proxy-server=<server> and satisfy auth via Fetch.continueWithAuth,
 * or (b) use the embedded-creds URL form via buildIproyalProxyUrl().
 */
export function buildIproyalProxy(opts: {
  username: string;
  password: string;
  country?: string;
  sessionId?: string;
  bypassList?: string;
  host?: string;
  port?: number;
}): ProxyConfig {
  const host = opts.host || DEFAULT_IPROYAL_HOST;
  const port = opts.port || DEFAULT_IPROYAL_PORT;
  const passwordWithMeta = decoratePassword(opts.password, opts.country, opts.sessionId);
  return {
    server: `http://${host}:${port}`,
    username: opts.username,
    password: passwordWithMeta,
    bypassList: opts.bypassList,
    country: opts.country,
  };
}

/**
 * Legacy alias — preserved for src/cli-v7/breath/proxy-rotate.ts callers
 * that already import the credential-URL helper.
 */
export function buildIproyalCredsUrl(opts: {
  username: string;
  password: string;
  country?: string;
  sessionId?: string;
  host?: string;
  port?: number;
}): string {
  return buildIproyalProxyUrl({
    user: opts.username,
    pass: opts.password,
    host: opts.host || DEFAULT_IPROYAL_HOST,
    port: opts.port || DEFAULT_IPROYAL_PORT,
    country: opts.country,
    sessionId: opts.sessionId,
  });
}
