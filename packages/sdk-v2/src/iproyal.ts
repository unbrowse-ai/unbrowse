/**
 * iproyal — SDK-level egress URL resolver. Pure functions only.
 *
 * Mirrors src/execution/proxy-fetch.ts:resolveEgressProxy + resolveProxyUrl,
 * with the same precedence (UNBROWSE_DIRECT_EGRESS > UNBROWSE_PROXY_URL >
 * IPRoyal env > IPRoyal file) and the same credential handling (env first,
 * file second, never in source, never in logs).
 *
 * Statelessness invariants (mirrors src/chrome/CONTRACT.md):
 *   - No module-level state.
 *   - File creds are read via a dependency-injected loader, so the pure
 *     function can be tested without touching ~/.identity/iproyal-creds.
 *   - Credentials are redacted in any URL returned for logging — the full
 *     password stays in memory only, never written to stderr.
 */

export interface IproyalCreds {
  username: string;
  password: string;
  host: string;
  port: number;
}

export interface EgressEnv {
  UNBROWSE_DIRECT_EGRESS?: string;
  UNBROWSE_PROXY_URL?: string;
  IPROYAL_USER?: string;
  IPROYAL_PASS?: string;
}

/** Default IPRoyal endpoint, used when file creds are partial. */
export const DEFAULT_IPROYAL_HOST = "geo.iproyal.com";
export const DEFAULT_IPROYAL_PORT = 12321;

/**
 * Resolve the proxy URL from env vars alone. Returns undefined when
 * UNBROWSE_DIRECT_EGRESS is set OR no creds are present.
 */
export function resolveProxyUrl(
  env: EgressEnv,
  loadFileCreds: (() => IproyalCreds | null) | null = null,
): string | undefined {
  if (env.UNBROWSE_DIRECT_EGRESS === "1") return undefined;
  if (env.UNBROWSE_PROXY_URL) return env.UNBROWSE_PROXY_URL;

  const user = env.IPROYAL_USER;
  const pass = env.IPROYAL_PASS;
  if (user && pass) {
    return formatIproyalUrl({ username: user, password: pass, host: DEFAULT_IPROYAL_HOST, port: DEFAULT_IPROYAL_PORT });
  }

  if (loadFileCreds) {
    const file = loadFileCreds();
    if (file) return formatIproyalUrl(file);
  }
  return undefined;
}

/**
 * Resolve the full egress URL, with per-call override. The SDK's
 * ProxyResource.fetch() passes `egress.mode: "residential"` to force IPRoyal
 * even when env says direct; `egress.country` and `egress.session_id` append
 * to the IPRoyal password.
 *
 * Precedence: per-call override > UNBROWSE_DIRECT_EGRESS > UNBROWSE_PROXY_URL > IPRoyal.
 */
export function resolveEgressProxy(
  env: EgressEnv,
  egressOverride: {
    mode?: "direct" | "residential";
    country?: string;
    session_id?: string;
  } | null,
  loadFileCreds: (() => IproyalCreds | null) | null = null,
): string | undefined {
  if (egressOverride?.mode === "direct") return undefined;
  if (egressOverride?.mode === "residential") {
    // Forced residential — ignore UNBROWSE_DIRECT_EGRESS, build IPRoyal URL
    // from any available creds (env over file).
    const user = env.IPROYAL_USER;
    const pass = env.IPROYAL_PASS;
    let creds: IproyalCreds | null = null;
    if (user && pass) {
      creds = { username: user, password: pass, host: DEFAULT_IPROYAL_HOST, port: DEFAULT_IPROYAL_PORT };
    } else if (loadFileCreds) {
      creds = loadFileCreds();
    }
    if (!creds) {
      // Forced residential but no creds — fall through to env-based resolution
      // (which will also return undefined since UNBROWSE_DIRECT_EGRESS would
      // have short-circuited already). The worker surfaces this as a 502.
      return resolveProxyUrl({ ...env, UNBROWSE_DIRECT_EGRESS: undefined }, loadFileCreds);
    }
    const withOverrides = applyIproyalOverrides(creds, egressOverride);
    return formatIproyalUrl(withOverrides);
  }
  return resolveProxyUrl(env, loadFileCreds);
}

/**
 * Append `_country-<cc>` and `_session-<id>` to the password. IPRoyal's
 * documented convention.
 */
export function applyIproyalOverrides(
  creds: IproyalCreds,
  egress: { country?: string; session_id?: string } | null,
): IproyalCreds {
  if (!egress || (!egress.country && !egress.session_id)) return creds;
  let pw = creds.password;
  if (egress.country) pw = `${pw}_country-${egress.country}`;
  if (egress.session_id) pw = `${pw}_session-${egress.session_id}`;
  return { ...creds, password: pw };
}

/**
 * Build the proxy URL `http://user:pass@host:port`. Use this for the SDK's
 * fetch dispatcher; never log the output unchanged — redact via
 * `redactProxyUrl` for stderr.
 */
export function formatIproyalUrl(creds: IproyalCreds): string {
  return `http://${creds.username}:${creds.password}@${creds.host}:${creds.port}`;
}

/** Redact credentials from a proxy URL for safe stderr / log output. */
export function redactProxyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.username) u.username = "***";
    if (u.password) u.password = "";
    return u.toString();
  } catch {
    // Not a URL — best-effort redaction of anything that looks like user:pass@.
    return url.replace(/:\/\/[^@]+@/, "://***@");
  }
}

/**
 * Read creds from `~/.identity/iproyal-creds` (mode 600). Real impl in the
 * runtime SDK shipping surface; injected here as a stub so test suites can
 * stay hermetic. The real loader is wired in client.ts at construction.
 *
 * File format (one line, newline-delimited): `username password host port`.
 */
export function readIproyalCredsFile(path = "~/.identity/iproyal-creds"): IproyalCreds | null {
  const fs = tryImportFs();
  if (!fs) return null;
  const expanded = path.replace(/^~/, process.env.HOME ?? "");
  if (!fs.existsSync(expanded)) return null;
  try {
    const text = fs.readFileSync(expanded, "utf8").trim();
    const [username, password, host, portStr] = text.split(/\s+/);
    if (!username || !password) return null;
    const port = portStr ? Number(portStr) : DEFAULT_IPROYAL_PORT;
    if (!Number.isFinite(port)) return null;
    return {
      username,
      password,
      host: host ?? DEFAULT_IPROYAL_HOST,
      port,
    };
  } catch {
    return null;
  }
}

function tryImportFs(): typeof import("node:fs") | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:fs");
  } catch {
    return null;
  }
}