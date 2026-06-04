/**
 * `unbrowse act proxy-rotate [--country=US]` — rotate the residential proxy.
 *
 * 1:1 mapping (kind-map.ts row "act proxy-rotate"):
 *   CLI subcommand  : act proxy-rotate
 *   MCP tool        : unbrowse_proxy_rotate
 *   Op kind   : act:proxy_rotate
 *   Verb            : act
 *
 * Behavior:
 *   1. Read iproyal creds from `~/.identity/iproyal-creds` (600-perm file).
 *      Honest 503 if missing — the agent gets `error: iproyal_creds_missing`
 *      with the file path it must populate, not a silent fallback.
 *   2. Build `--proxy-server=http://geo.iproyal.com:12321` with the country
 *      lock encoded into the password (per reference_iproyal_proxy memory:
 *      `<password>_country-<iso2>`). Username:password are URL-encoded.
 *   3. Spawn a new Chrome with the proxy arg. The OLD session's Chrome
 *      stays running (rotate creates an additive session, not a replace) —
 *      the caller decides whether to `act close` the old one.
 *   4. Persist a new session record and return its sessionId.
 *
 * Audit POST (W24.2 — A2 closure): the handler emits a sig-keyed
 * `proxy-rotate` act-act receipt. The receipt body carries
 * pointer-only (sessionId + proxy host hash) — NEVER iproyal
 * username/password (those stay strictly local per the KEEP-LOCAL
 * invariant below). The receipt is the witness that "this agent
 * rotated proxy here at time T"; the rotation pattern is itself
 * forensic data.
 *
 * ── KEEP-LOCAL invariant (Day-2 §B, Day-6 W2 confirmation) ────────────────
 *
 * iproyal credentials in `~/.identity/iproyal-creds` are TRUST-ROOT
 * credentials — they're the proxy-auth platform the agent must already
 * trust to do residential rotation at all. They are NOT operational
 * state to migrate across the boundary. The proxy creds:
 *
 *   1. STAY LOCAL — never wire-bound, never written to KV, never POSTed
 *      anywhere. The handler reads them, builds the proxy URL, and the
 *      bytes never escape this process.
 *   2. The rotated SESSION (chromeWsUrl, contextId, targetId, sessionId)
 *      crosses the boundary via the SESSION_STATE row that `act
 *      session-park` posts — NOT via this handler. session-park reads
 *      the session record (writeSessionRecord routes to tmp/<sigHash>/)
 *      and posts the pointer-only park body.
 *   3. The output JSON envelope carries `proxy_server` (host:port —
 *      data, NOT a secret) and the new `session_id`. It NEVER carries
 *      `username`, `password`, or `passwordWithCountry` (those are
 *      held in the in-process `proxy` struct only, consumed by
 *      Fetch.continueWithAuth at request time when W5/W6 interceptor
 *      wave lands).
 *
 * Why KEEP-LOCAL is right: residential proxy creds are scoped to the
 * machine that paid for them. Migrating them across the boundary would
 * be a platform-prescription violation (contract ee1f5409) — the
 * platform ENABLES the rotation; the credentials are the operator's.
 *
 * Exit codes:
 *   0   success — new session record written
 *   65  CDP spawn failed
 *   503 (mapped to exit 1) iproyal creds file missing (honest empty-state)
 *   1   other failure
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createBrowserContext,
  createTarget,
  spawnChrome,
} from "../../cdp/index.js";
import type { ParsedV7Args } from "../args.js";
import { writeSessionRecord, type BrowseSessionRecord } from "../_session.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { emitBreathActStateless } from "../_act-audit.js";

const EX_CDP = 65;
const DEFAULT_IPROYAL_HOST = "geo.iproyal.com";
const DEFAULT_IPROYAL_PORT = "12321";

interface IproyalCreds {
  username: string;
  password: string;
  endpoint?: string; // host:port, defaults to geo.iproyal.com:12321
}

/**
 * Parse `~/.identity/iproyal-creds`. Accepted forms (line-oriented):
 *   username=...
 *   password=...
 *   endpoint=geo.iproyal.com:12321  (optional)
 *
 * Lines starting with '#' are comments. Lines without '=' are skipped.
 * Throws an Error with code 'iproyal_creds_missing' if the file is absent
 * or unreadable; the handler maps that to an honest 503-shaped envelope.
 */
async function readIproyalCreds(): Promise<IproyalCreds> {
  const path = join(homedir(), ".identity", "iproyal-creds");
  let raw: string;
  try {
    const st = await stat(path);
    if (!st.isFile()) {
      const err = new Error(`iproyal_creds_not_a_file:${path}`);
      (err as Error & { code?: string }).code = "iproyal_creds_missing";
      throw err;
    }
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const e = new Error(`iproyal_creds_missing:${path}`);
      (e as Error & { code?: string }).code = "iproyal_creds_missing";
      throw e;
    }
    throw err;
  }
  const out: Partial<IproyalCreds> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key === "username") out.username = val;
    else if (key === "password") out.password = val;
    else if (key === "endpoint") out.endpoint = val;
  }
  if (!out.username || !out.password) {
    const e = new Error(`iproyal_creds_malformed:${path}:need username and password`);
    (e as Error & { code?: string }).code = "iproyal_creds_missing";
    throw e;
  }
  return out as IproyalCreds;
}

/**
 * Build the proxy URL per reference_iproyal_proxy.md:
 *   http://<USER>:<PASS>[_country-<iso2>]@<HOST>:<PORT>
 * Credentials are URL-encoded; country lock appends to the password.
 *
 * Returned as a single --proxy-server-compatible URL. Chrome accepts the
 * embedded creds form via the proxy-auth challenge → Fetch.continueWithAuth
 * once a v7.x interceptor wave lands; today (W3 baseline) Chrome can use
 * the URL-form directly via `--proxy-server` only when creds are stripped
 * (Chrome rejects embedded creds in --proxy-server). To stay honest, we
 * surface BOTH the bare server URL (for --proxy-server) AND the creds for
 * a future Fetch.continueWithAuth wiring. v7.0 returns the server form.
 */
export function buildIproyalProxyUrl(opts: {
  creds: IproyalCreds;
  country?: string;
}): { server: string; username: string; password: string; passwordWithCountry: string } {
  const endpoint = opts.creds.endpoint || `${DEFAULT_IPROYAL_HOST}:${DEFAULT_IPROYAL_PORT}`;
  const server = `http://${endpoint}`;
  const passwordWithCountry = opts.country
    ? `${opts.creds.password}_country-${opts.country.toLowerCase()}`
    : opts.creds.password;
  return {
    server,
    username: opts.creds.username,
    password: opts.creds.password,
    passwordWithCountry,
  };
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("act", "proxy-rotate")!;

  if (parsed.wantsHelp) {
    helpExit(
      "act proxy-rotate",
      {
        summary: "Rotate the residential proxy session (iproyal sticky-IP refresh).",
        usage: "unbrowse act proxy-rotate [--country <iso2>] [--session <id>]",
        positional: [],
        flags: [
          { name: "--session", description: "Browse session id (default: spawn a new one).", value_expected: true },
          { name: "--country", description: "Country lock (ISO-3166-1 alpha-2, e.g. US, MY, SG).", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "act",
      },
      opts,
    );
  }

  const country = typeof parsed.flags.country === "string" ? parsed.flags.country : undefined;

  // ── Read iproyal creds (honest 503 if missing) ───────────────────────────
  let creds: IproyalCreds;
  try {
    creds = await readIproyalCreds();
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === "iproyal_creds_missing") {
      emit(
        {
          ok: false,
          subcommand: "act proxy-rotate",
          op_kind: meta.op_kind,
          error: "iproyal_creds_missing",
          status: 503,
          hint:
            "create ~/.identity/iproyal-creds (mode 600) with `username=...` and `password=...` lines. See reference_iproyal_proxy memory for the credential source.",
          path_expected: join(homedir(), ".identity", "iproyal-creds"),
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  const proxy = buildIproyalProxyUrl({ creds, country });

  // ── Spawn a fresh Chrome through the proxy ───────────────────────────────
  // Chrome's --proxy-server accepts host:port without creds; auth is
  // satisfied via Fetch.continueWithAuth at request time. We pass the bare
  // server URL here; a future W5/W6 wiring will arm the interceptor with
  // `proxy.username` / `proxy.passwordWithCountry`.
  let conn;
  let target;
  try {
    conn = await spawnChrome({
      headless: true,
      proxy: proxy.server,
      perContextProxy: false,
    });
    const ctx = await createBrowserContext(conn);
    // about:blank is fine — the rotated session is for subsequent
    // `act go <url>` to navigate through.
    target = await createTarget(conn, "about:blank", { browserContextId: ctx.browserContextId });
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // Make sure ~/.unbrowse/sessions/ exists before writing.
  await mkdir(join(homedir(), ".unbrowse", "sessions"), { recursive: true });

  const sessionId = randomUUID();
  const rec: BrowseSessionRecord = {
    sessionId,
    contextId: target.browserContextId ?? "",
    targetId: target.targetId,
    chromeWsUrl: conn.endpoint,
    chromePid: conn.pid,
    createdAt: Date.now(),
  };
  await writeSessionRecord(rec);

  // W24.2 — emit a sig-keyed `proxy-rotate` act-act receipt. Selector
  // overload: pass the proxy SERVER (host:port — not secret) which the
  // helper sha256-hashes before crossing the wire. Country lock is
  // surfaced as the URL slot (sha256(country-iso2) hash buckets country
  // distribution forensically without leaking which datacenter).
  const rotateAudit = await emitBreathActStateless({
    sessionId,
    actType: "proxy-rotate",
    selector: proxy.server,
    currentUrl: country ? `proxy-rotate://country/${country}` : "proxy-rotate://no-country",
  });

  emit(
    {
      ok: true,
      subcommand: "act proxy-rotate",
      op_kind: meta.op_kind,
      session_id: sessionId,
      proxy_server: proxy.server,
      country: country ?? null,
      // creds are NOT echoed — only the server is data, the password is a
      // secret (URL-form proxy auth is consulted via Fetch.continueWithAuth
      // at request time, not surfaced here).
      chrome_ws_url: conn.endpoint,
      audit: rotateAudit.skipped
        ? false
        : {
            ok: rotateAudit.ok,
            idempotent: rotateAudit.idempotent,
            binding_missing: rotateAudit.bindingMissing,
            receipt_id: rotateAudit.receiptId,
            cache_key: rotateAudit.cacheKey,
            variant: "act-act",
            act_type: "proxy-rotate",
          },
    },
    opts,
  );
  process.exit(0);
}
