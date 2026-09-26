// Credentials for the hosted service: an API key, or an OAuth 2.1 token from `unbrowse login`
// (dynamic client registration + PKCE + a loopback redirect). Stored at ~/.config/unbrowse/cli.json, mode 0600.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Stored = {
  baseUrl?: string;
  apiKey?: string;
  oauth?: { clientId: string; accessToken: string; refreshToken?: string; expiresAt?: number };
};

export function configPath(): string {
  const root = process.env.UNBROWSE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "unbrowse");
  return join(root, "cli.json");
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

/** The token for a call: env key, then stored key, then OAuth (refreshed when it is about to expire). */
export async function currentToken(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (process.env.UNBROWSE_API_KEY) return process.env.UNBROWSE_API_KEY;
  const stored = load();
  if (stored.baseUrl && stored.baseUrl !== baseUrl) return undefined;
  if (stored.apiKey) return stored.apiKey;
  const o = stored.oauth;
  if (!o) return undefined;
  if (o.expiresAt && o.refreshToken && Date.now() > o.expiresAt - 60_000) {
    try {
      const fresh = await tokenRequest(baseUrl, { grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.clientId }, fetchImpl);
      save({ ...stored, oauth: { clientId: o.clientId, ...fresh, refreshToken: fresh.refreshToken ?? o.refreshToken } });
      return fresh.accessToken;
    } catch {
      return o.accessToken;
    }
  }
  return o.accessToken;
}

export function describe(baseUrl: string): string {
  if (process.env.UNBROWSE_API_KEY) return "API key from UNBROWSE_API_KEY";
  const stored = load();
  if (stored.baseUrl && stored.baseUrl !== baseUrl) return `not signed in to ${baseUrl} (stored login is for ${stored.baseUrl})`;
  if (stored.apiKey) return `API key ${mask(stored.apiKey)} in ${configPath()}`;
  if (stored.oauth) return `OAuth sign-in in ${configPath()}`;
  return "not signed in";
}

export function mask(key: string): string {
  return key.length <= 12 ? "…" : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

type Tokens = { accessToken: string; refreshToken?: string; expiresAt?: number };

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
 * Browser sign-in. Registers a public client for a loopback redirect, opens the authorize page,
 * waits for the code on 127.0.0.1, exchanges it with the PKCE verifier and stores the tokens.
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
      resource: `${baseUrl}/mcp`,
    }).toString();
    opts.log(`Opening ${url.origin}/authorize in your browser. If it does not open, visit:\n${url.toString()}`);
    opts.open(url.toString());

    const timer = setTimeout(() => settle({ error: "timed out waiting for the browser sign-in" }), opts.timeoutMs ?? 300_000);
    const answer = await got;
    clearTimeout(timer);
    if (!answer.code) throw new Error(answer.error ?? "sign-in failed");

    const tokens = await tokenRequest(
      baseUrl,
      { grant_type: "authorization_code", code: answer.code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier },
      fetchImpl,
    );
    save({ baseUrl, oauth: { clientId: client.client_id, ...tokens } });
  } finally {
    server.close();
  }
}
