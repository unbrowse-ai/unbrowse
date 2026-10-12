// Credentials for the hosted service: an API key, or an OAuth 2.1 token from `unbrowse login`
// (dynamic client registration + PKCE + a loopback redirect). Stored at ~/.config/unbrowse/cli.json, mode 0600.
// Named accounts (`--account work`) each keep their own sign-in at ~/.config/unbrowse/accounts/<name>/cli.json.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export type Stored = {
  baseUrl?: string;
  apiKey?: string;
  oauth?: { clientId: string; accessToken: string; refreshToken?: string; expiresAt?: number };
};

export function configRoot(): string {
  return process.env.UNBROWSE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "unbrowse");
}

/** The account this process uses; undefined is the default one (cli.json). Set once per command by `selectAccount`. */
let selected: string | undefined;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const defaultFile = () => join(configRoot(), "account");

/** A usable account name (letters, digits, `-`, `_`; it names a directory and a background service). */
export function checkAccount(name: string): string {
  if (name !== "default" && !ACCOUNT_NAME.test(name)) throw new Error(`invalid account name "${name}": use letters, digits, - and _ (up to 40)`);
  return name;
}

/** The account `accounts use` made the default, if any. */
export function savedAccount(): string | undefined {
  try {
    const name = readFileSync(defaultFile(), "utf8").trim();
    return name && ACCOUNT_NAME.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Pick the account for this command: `--account`, then UNBROWSE_ACCOUNT, then the saved default, else the default one. */
export function selectAccount(name?: string): string {
  const pick = name ?? (process.env.UNBROWSE_ACCOUNT || undefined) ?? savedAccount();
  selected = !pick || checkAccount(pick) === "default" ? undefined : pick;
  return account();
}

/** The selected account's name ("default" for the unnamed one). */
export function account(): string {
  return selected ?? "default";
}

/** Make `name` the account commands use when none is named ("default" goes back to the unnamed one). */
export function useAccount(name: string): void {
  if (checkAccount(name) === "default") return void rmSync(defaultFile(), { force: true });
  mkdirSync(configRoot(), { recursive: true, mode: 0o700 });
  writeFileSync(defaultFile(), `${name}\n`, { mode: 0o600 });
}

/** The sign-ins saved on this machine, without their secrets. */
export function listAccounts(): { name: string; baseUrl?: string; signIn: "api key" | "oauth" | "none" }[] {
  const read = (path: string) => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Stored;
    } catch {
      return undefined;
    }
  };
  const row = (name: string, s: Stored) => ({ name, ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}), signIn: s.apiKey ? ("api key" as const) : s.oauth ? ("oauth" as const) : ("none" as const) });
  const out = [];
  const main = read(join(configRoot(), "cli.json"));
  if (main) out.push(row("default", main));
  let names: string[] = [];
  try {
    names = readdirSync(join(configRoot(), "accounts")).filter((n) => ACCOUNT_NAME.test(n)).sort();
  } catch {
    /* no named accounts yet */
  }
  for (const n of names) {
    const s = read(join(configRoot(), "accounts", n, "cli.json"));
    if (s) out.push(row(n, s));
  }
  return out;
}

export function configPath(): string {
  return selected ? join(configRoot(), "accounts", selected, "cli.json") : join(configRoot(), "cli.json");
}

export function load(): Stored {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Stored;
  } catch {
    return {};
  }
}

export function save(stored: Stored): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clear(): void {
  rmSync(configPath(), { force: true });
}

/**
 * The key the v1 CLI (before 12) saved in ~/.unbrowse/config.json. v1 keys were carried over to the hosted service
 * and still work, so someone who upgraded is not sent to sign in to a new, empty account. Only a real v1 key
 * (`ubr_` + 48 hex), only for the hosted origin.
 */
export function v1Key(baseUrl: string): string | undefined {
  if (!/^https:\/\/(www\.|api\.|v3\.)?unbrowse\.ai\/?$/.test(baseUrl)) return undefined;
  try {
    const key = (JSON.parse(readFileSync(join(process.env.HOME || homedir(), ".unbrowse", "config.json"), "utf8")) as { api_key?: unknown }).api_key;
    return typeof key === "string" && /^ubr_[0-9a-f]{48}$/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An Unbrowse sign-in this machine's MCP host already holds, so a person who connected Unbrowse in their agent is
 * not asked to sign in again here. Only Claude Code keeps its MCP tokens in a file (~/.claude/.credentials.json;
 * on macOS they are in the Keychain and this finds nothing). Only a token for this origin's REST audience counts:
 * the server binds each token to `/api` or `/mcp`, and a `/mcp` one is refused on `/api`. The token is borrowed,
 * never refreshed: refreshing rotates the refresh token and would sign the host out. UNBROWSE_SHARED_SIGNIN=0 turns it off.
 */
export function sharedSignIn(baseUrl: string, now = Date.now()): { token: string; from: string } | undefined {
  if (process.env.UNBROWSE_SHARED_SIGNIN === "0") return undefined;
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME || homedir(), ".claude");
  let entries: unknown[];
  try {
    entries = Object.values((JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")) as { mcpOAuth?: Record<string, unknown> }).mcpOAuth ?? {});
  } catch {
    return undefined;
  }
  const api = new URL(apiResource(baseUrl));
  // Several matches (two accounts, a stale copy): the one valid longest, so the choice does not depend on file order.
  let best: { token: string; from: string; expiresAt: number } | undefined;
  for (const e of entries as { serverName?: unknown; serverUrl?: unknown; accessToken?: unknown; expiresAt?: unknown }[]) {
    if (typeof e?.serverUrl !== "string" || typeof e.accessToken !== "string" || !e.accessToken) continue;
    if (typeof e.expiresAt === "number" && now > e.expiresAt - 60_000) continue;
    let url: URL;
    try {
      url = new URL(e.serverUrl);
    } catch {
      continue;
    }
    if (url.origin !== api.origin || !(url.pathname === api.pathname || url.pathname.startsWith(`${api.pathname}/`))) continue;
    const expiresAt = typeof e.expiresAt === "number" ? e.expiresAt : 0; // unknown expiry ranks last
    if (!best || expiresAt > best.expiresAt) best = { token: e.accessToken, from: `Claude Code's MCP sign-in (${String(e.serverName ?? url.origin + url.pathname)})`, expiresAt };
  }
  return best && { token: best.token, from: best.from };
}

/** The token for a call: env key, then stored key, then OAuth (refreshed when it is about to expire), then a v1 key, then an MCP host's sign-in. */
export async function currentToken(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (process.env.UNBROWSE_API_KEY) return process.env.UNBROWSE_API_KEY;
  const stored = load();
  if (stored.baseUrl && stored.baseUrl !== baseUrl) return undefined;
  if (stored.apiKey) return stored.apiKey;
  const o = stored.oauth;
  // A named account only ever uses its own sign-in: borrowing the v1 key or Claude Code's would act as someone else.
  if (!o) return selected ? undefined : (v1Key(baseUrl) ?? sharedSignIn(baseUrl)?.token);
  if (o.expiresAt && o.refreshToken && Date.now() > o.expiresAt - 60_000) {
    try {
      const fresh = await tokenRequest(baseUrl, { grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.clientId, resource: apiResource(baseUrl) }, fetchImpl);
      save({ ...stored, oauth: { clientId: o.clientId, ...fresh, refreshToken: fresh.refreshToken ?? o.refreshToken } });
      return fresh.accessToken;
    } catch {
      return o.accessToken;
    }
  }
  return o.accessToken;
}

/** The token to send to `target` (the proxy's MCP URL): a token borrowed from Claude Code only goes to its own origin. */
export async function tokenFor(baseUrl: string, target: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const token = await currentToken(baseUrl, fetchImpl);
  if (!token) return undefined;
  let same = false;
  try {
    same = new URL(target, baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    /* not a URL: not this origin */
  }
  return same || signInSource(baseUrl) !== "shared" ? token : undefined;
}

/** Where `currentToken` gets this origin's sign-in: the environment, this CLI's own store, a v1 key, or Claude Code's. */
export function signInSource(baseUrl: string): "env" | "stored" | "v1" | "shared" | undefined {
  if (process.env.UNBROWSE_API_KEY) return "env";
  const stored = load();
  if (stored.baseUrl && stored.baseUrl !== baseUrl) return undefined;
  if (stored.apiKey || stored.oauth) return "stored";
  if (selected) return undefined;
  if (v1Key(baseUrl)) return "v1";
  return sharedSignIn(baseUrl) ? "shared" : undefined;
}

export function describe(baseUrl: string): string {
  if (process.env.UNBROWSE_API_KEY) return "API key from UNBROWSE_API_KEY";
  const stored = load();
  if (stored.baseUrl && stored.baseUrl !== baseUrl) return `not signed in to ${baseUrl} (stored login is for ${stored.baseUrl})`;
  if (stored.apiKey) return `API key ${mask(stored.apiKey)} in ${configPath()}`;
  if (stored.oauth) return `OAuth sign-in in ${configPath()}`;
  if (selected) return `not signed in (account "${selected}": \`unbrowse login --account ${selected}\`)`;
  const v1 = !stored.baseUrl ? v1Key(baseUrl) : undefined;
  if (v1) return `v1 API key ${mask(v1)} from ~/.unbrowse/config.json (still works; \`unbrowse login\` replaces it)`;
  const shared = !stored.baseUrl ? sharedSignIn(baseUrl) : undefined;
  if (shared) return `${shared.from}, shared (\`unbrowse login\` gives the CLI its own)`;
  return "not signed in";
}

export function mask(key: string): string {
  return key.length <= 12 ? "…" : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

type Tokens = { accessToken: string; refreshToken?: string; expiresAt?: number };

/** OAuth audience for this CLI. The REST API, not the remote MCP server. */
export function apiResource(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api`;
}

async function tokenRequest(baseUrl: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<Tokens> {
  const res = await fetchImpl(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error_description ?? body.error ?? `token endpoint answered HTTP ${res.status}`);
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined };
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Browser sign-in for the REST API. Registers a public client for a loopback redirect, opens the
 * authorize page with resource `{origin}/api`, waits for the code on 127.0.0.1, exchanges it
 * with the PKCE verifier and stores the tokens. This client does not request the MCP audience.
 */
export async function oauthLogin(
  baseUrl: string,
  opts: { open: (url: string) => void; log: (line: string) => void; fetch?: typeof fetch; timeoutMs?: number },
): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  let settle!: (v: { code?: string; error?: string }) => void;
  const got = new Promise<{ code?: string; error?: string }>((r) => (settle = r));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const ok = u.searchParams.get("state") === state && !!u.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(ok ? "<p>Signed in to Unbrowse. You can close this tab.</p>" : "<p>Sign-in failed. Return to the terminal.</p>");
    settle(ok ? { code: u.searchParams.get("code")! } : { error: u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? "state mismatch" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const reg = await fetchImpl(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Unbrowse CLI",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await reg.json().catch(() => ({}))) as { client_id?: string; error_description?: string };
    if (!reg.ok || !client.client_id) throw new Error(`client registration failed: ${client.error_description ?? `HTTP ${reg.status}`}`);

    const url = new URL(`${baseUrl}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "unbrowse",
      resource: apiResource(baseUrl),
    }).toString();
    opts.log(`Opening ${url.origin}/authorize in your browser. If it does not open, visit:\n${url.toString()}`);
    opts.open(url.toString());

    const timer = setTimeout(() => settle({ error: "timed out waiting for the browser sign-in" }), opts.timeoutMs ?? 300_000);
    const answer = await got;
    clearTimeout(timer);
    if (!answer.code) throw new Error(answer.error ?? "sign-in failed");

    const tokens = await tokenRequest(
      baseUrl,
      { grant_type: "authorization_code", code: answer.code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: apiResource(baseUrl) },
      fetchImpl,
    );
    save({ baseUrl, oauth: { clientId: client.client_id, ...tokens } });
  } finally {
    server.close();
  }
}

/**
 * Device sign-in (RFC 8628) for a machine with no browser and no loopback — a remote agent's VM, a CI box, an
 * SSH session. Registers a client named for this host, asks the server for a short code, prints where to approve
 * it, and polls until the person approves on another device. The resulting login is this client's own, so it can
 * be revoked on its own without touching other agents.
 */
export async function deviceLogin(
  baseUrl: string,
  opts: { log: (line: string) => void; fetch?: typeof fetch; clientName?: string; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const name = opts.clientName ?? `Unbrowse CLI (${hostname()})`;
  const redirectUri = `${baseUrl.replace(/\/+$/, "")}/device/done`;

  const reg = await fetchImpl(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  const client = (await reg.json().catch(() => ({}))) as { client_id?: string; error_description?: string };
  if (!reg.ok || !client.client_id) throw new Error(`client registration failed: ${client.error_description ?? `HTTP ${reg.status}`}`);

  const da = await fetchImpl(`${baseUrl}/oauth/device_authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: client.client_id, resource: apiResource(baseUrl) }).toString(),
  });
  const dev = (await da.json().catch(() => ({}))) as { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; expires_in?: number; interval?: number; error_description?: string; error?: string };
  if (!da.ok || !dev.device_code || !dev.user_code) throw new Error(`could not start device sign-in: ${dev.error_description ?? dev.error ?? `HTTP ${da.status}`}`);

  opts.log(`To sign in, open ${dev.verification_uri} on any device and enter the code:\n\n    ${dev.user_code}\n\n(or open ${dev.verification_uri_complete} to skip typing it). Waiting for approval…`);

  const deadline = now() + (dev.expires_in ?? 600) * 1000;
  let interval = Math.max(1, dev.interval ?? 5);
  while (now() < deadline) {
    await sleep(interval * 1000);
    const res = await fetchImpl(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dev.device_code, client_id: client.client_id }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (res.ok && body.access_token) {
      save({ baseUrl, oauth: { clientId: client.client_id, accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: body.expires_in ? now() + body.expires_in * 1000 : undefined } });
      return;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (body.error === "access_denied") throw new Error("the sign-in was denied");
    if (body.error === "expired_token") throw new Error("the code expired before it was approved; run `unbrowse login` again");
    throw new Error(body.error_description ?? body.error ?? `device sign-in failed (HTTP ${res.status})`);
  }
  throw new Error("timed out waiting for approval");
}
