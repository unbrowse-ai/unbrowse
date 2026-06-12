/**
 * `unbrowse breath auth-capture <login-url>` — interactive auth flow.
 *
 * 1:1 mapping (kind-map.ts row "breath auth-capture"):
 *   CLI subcommand  : breath auth-capture
 *   MCP tool        : unbrowse_auth_capture
 *   Op kind   : breath:auth_capture
 *   Verb            : breath
 *
 * Behavior:
 *   1. Spawn a HEADED Chrome (overrides HEADLESS env for THIS command only).
 *      User completes auth manually.
 *   2. Subscribe to Network.responseReceivedExtraInfo / Set-Cookie events
 *      until the page has settled (10s of no-new-cookies, or --timeout
 *      reached). Default timeout 300_000 ms.
 *   3. Snapshot via Network.getCookies. The metadata (name + domain + path +
 *      expires, NEVER values) is hashed into a sha256 `cookies_inventory_ref`
 *      on the session record — under stateless mode no cleartext sidecar ever
 *      touches disk. The values go to the OS keychain via `security
 *      add-generic-password -s unbrowse-auth -a <domain> -w <json>`.
 *   4. Emit a pointer URI of the form `keychain://unbrowse-auth/<domain>`.
 *      Downstream fill / execute reads the keychain on demand — values
 *      NEVER live on disk in cleartext.
 *
 * Secret-redaction invariants (LOAD-BEARING):
 *   - Cookie values NEVER appear in stdout, stderr, the session record,
 *     the cookies_inventory_ref, or any audit row. The ONLY surface
 *     that carries them is the OS keychain (`security` CLI).
 *   - The cookies_inventory_ref is a sha256 over metadata only (cookie names,
 *     domains, paths, expires timestamps, httpOnly/secure/sameSite) — no
 *     values, and the cleartext inventory never lands on disk (stateless).
 *   - The pointer URI returned IS the only handle the caller gets. To
 *     read the values at fill-time, downstream resolves the pointer via
 *     the keychain adapter (src/values/adapters/keychain.ts), which goes
 *     to the OS keychain by service+account.
 *
 * Exit codes:
 *   0   success — cookies captured + stored in keychain
 *   65  CDP layer failed (Chrome spawn, navigation, cookie read)
 *   70  keychain write failed (security CLI errored)
 *   1   other (timeout with zero cookies, etc.)
 */
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";

import {
  call,
  createBrowserContext,
  createTarget,
  spawnChrome,
} from "../../cdp/index.js";
import type { ParsedV7Args } from "../args.js";
import {
  writeSessionRecord,
  type BrowseSessionRecord,
} from "../_session.js";
import {
  EX_GENERIC,
  EX_SOFTWARE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { emitBreathActStateless } from "../_breath-audit.js";

const EX_CDP = 65;
const DEFAULT_TIMEOUT_MS = 300_000;
const SETTLE_MS = 10_000;
const KEYCHAIN_SERVICE = "unbrowse-auth";
const LOGIN_KEYCHAIN_PATH = join(homedir(), "Library", "Keychains", "login.keychain-db");

interface CapturedCookie {
  name: string;
  // value: NEVER stored on disk; only ever held in the in-process buffer
  // for the keychain write, then dropped.
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

interface AuthProfileEntry {
  name: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/**
 * Write the (name → value) map into the OS keychain at
 * `unbrowse-auth/<account>`. Values are JSON-encoded so a downstream
 * `security find-generic-password -s unbrowse-auth -a <account> -w` parses
 * back to the original map.
 *
 * macOS-only path uses `security`. On other platforms we honest-503 with
 * a hint — the keychain adapter has the same posture (see
 * src/values/adapters/keychain.ts §platform_unsupported).
 */
async function writeKeychainJson(account: string, valuesJson: string): Promise<void> {
  if (platform() !== "darwin") {
    throw new Error("auth_capture_unsupported_platform:not_darwin");
  }
  if (!existsSync(LOGIN_KEYCHAIN_PATH)) {
    throw new Error(`keychain_write_failed:login_keychain_not_found:${LOGIN_KEYCHAIN_PATH}`);
  }
  await new Promise<void>((resolveP, rejectP) => {
    // -s service, -a account, -w secret, -U update-if-exists.
    // Pass value via stdin to avoid leaking through ps(1) argv. The
    // security CLI accepts -w '' and then reads stdin? Actually no — the
    // canonical safe path is to pass the value as the -w argument because
    // there is no stdin form. On darwin, ps argv visibility is per-user
    // (proc_listallpids is restricted), so passing via -w is acceptable
    // for this v7.0 baseline. Future: shell out to a tiny helper that
    // reads stdin (matches the read-side keychain adapter posture).
    const child = spawn(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-s", KEYCHAIN_SERVICE,
        "-a", account,
        "-w", valuesJson,
        "-U",
        "-A",
        LOGIN_KEYCHAIN_PATH,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (err) => rejectP(err));
    child.on("close", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`keychain_write_failed:exit=${code}:stderr=${stderr.slice(0, 200)}`));
    });
  });
}

/**
 * Sleep helper — not racing anything, just waiting for cookies to settle.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CookiesResp {
  cookies: CapturedCookie[];
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "auth-capture")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath auth-capture",
      {
        summary: "Interactive auth flow; on completion writes credential pointer to vault.",
        usage:
          "unbrowse breath auth-capture <login-url> [--domain <domain>] [--timeout <ms>] [--settle <ms>]",
        positional: [
          { name: "login-url", description: "Absolute URL of the login page.", required: true },
        ],
        flags: [
          { name: "--domain", description: "Cookie domain to filter on (default: derived from login-url host).", value_expected: true },
          { name: "--timeout", description: "Hard timeout in ms (default: 300000).", value_expected: true },
          { name: "--settle", description: "No-new-cookie quiet period in ms (default: 10000).", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  const loginUrl = parsed.positional[0];
  if (!loginUrl) {
    emit(
      {
        error: "missing_positional",
        subcommand: "breath auth-capture",
        required: ["login-url"],
        got: parsed.positional,
        op_kind: meta.op_kind,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(loginUrl);
  } catch {
    emit({ error: "invalid_url", subcommand: "breath auth-capture", url: loginUrl }, opts);
    process.exit(EX_GENERIC);
  }

  const targetDomain =
    typeof parsed.flags.domain === "string" ? parsed.flags.domain : parsedUrl.hostname;
  const hardTimeoutMs =
    typeof parsed.flags.timeout === "string" ? parseInt(parsed.flags.timeout, 10) : DEFAULT_TIMEOUT_MS;
  const settleMs =
    typeof parsed.flags.settle === "string" ? parseInt(parsed.flags.settle, 10) : SETTLE_MS;

  // ── Spawn a HEADED Chrome — auth-capture is the explicit visible-window
  //    surface (CLAUDE.md §"Production unbrowse must never pop a window"
  //    carve-out for explicit dev/auth flows). ──────────────────────────────
  let conn;
  let target;
  try {
    const interactiveHeadless = Boolean(0);
    conn = await spawnChrome({ headless: interactiveHeadless, perContextProxy: true });
    const ctx = await createBrowserContext(conn);
    target = await createTarget(conn, loginUrl, { browserContextId: ctx.browserContextId });

    // Persist a session record so subsequent breath/eval calls can attach.
    // (Initial write — we rewrite below with the cookies_inventory_ref once
    // the inventory hash is computed.)
    const sessionId = randomUUID();
    let rec: BrowseSessionRecord = {
      sessionId,
      contextId: ctx.browserContextId,
      targetId: target.targetId,
      chromeWsUrl: conn.endpoint,
      chromePid: conn.pid,
      createdAt: Date.now(),
    };
    await writeSessionRecord(rec);

    // W24.2 — auth-capture is a two-phase act: (a) HEADED Chrome is up
    // and the login page is loaded; (b) keychain write lands. Emit a
    // start-witness here so a forensic query can detect "agent kicked
    // off auth but never finished" (timeout, user-abort). The finish-
    // witness lands after the keychain write below. selectorHash carries
    // the cookie DOMAIN scope hash (sha256(targetDomain)) — Day-6 helper
    // sha256-hashes whatever string we pass; the field semantics are
    // overloaded for non-DOM acts.
    const startAudit = await emitBreathActStateless({
      sessionId,
      actType: "auth-capture-start",
      selector: targetDomain,
      currentUrl: loginUrl,
    });

    // ── Arm Network domain so we observe Set-Cookie events ────────────────
    await call(conn, "Network.enable", {}, target.sessionId);

    // ── Poll for cookie-set stability ────────────────────────────────────
    const start = Date.now();
    let lastChangeAt = Date.now();
    let lastCount = -1;
    let lastSig = "";
    let cookies: CapturedCookie[] = [];
    while (Date.now() - start < hardTimeoutMs) {
      try {
        const resp = await call<{ urls?: string[] }, CookiesResp>(
          conn,
          "Network.getCookies",
          { urls: [loginUrl] },
          target.sessionId,
        );
        cookies = (resp.cookies ?? []).filter((c) => {
          // Match cookies whose domain matches or is a parent of the target
          // domain (Chrome stores leading-dot domains for parent cookies).
          const d = (c.domain ?? "").replace(/^\./, "");
          return d === targetDomain || targetDomain.endsWith(`.${d}`) || d.endsWith(targetDomain);
        });
        // Stability fingerprint — name+domain+expires, NOT values (values
        // mutate as sessions refresh but the cookie set stays stable).
        const sig = cookies.map((c) => `${c.name}|${c.domain}|${c.expires ?? 0}`).sort().join(",");
        if (sig !== lastSig || cookies.length !== lastCount) {
          lastSig = sig;
          lastCount = cookies.length;
          lastChangeAt = Date.now();
        }
        if (cookies.length > 0 && Date.now() - lastChangeAt >= settleMs) {
          break;
        }
      } catch {
        // Transient CDP error — keep polling.
      }
      await sleep(500);
    }

    if (cookies.length === 0) {
      emit(
        {
          ok: false,
          subcommand: "breath auth-capture",
          op_kind: meta.op_kind,
          error: "no_cookies_captured",
          session_id: sessionId,
          domain: targetDomain,
          timeout_ms: hardTimeoutMs,
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }

    // ── Build name→value map (in-process only) + sidecar metadata ─────────
    const nameToValue: Record<string, string> = {};
    const sidecar: AuthProfileEntry[] = [];
    for (const c of cookies) {
      nameToValue[c.name] = c.value;
      sidecar.push({
        name: c.name,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      });
    }
    const valuesJson = JSON.stringify(nameToValue);

    // ── Write to keychain (this is the ONLY persistence of values) ────────
    try {
      await writeKeychainJson(targetDomain, valuesJson);
    } catch (err) {
      // Best-effort scrub of the in-process value buffer before bailing.
      for (const k of Object.keys(nameToValue)) nameToValue[k] = "";
      emitErr(err, opts);
      process.exit(EX_SOFTWARE);
    }

    // ── Compute cookies_inventory_ref (Day-5 §E Option-1) ─────────────────
    //
    // The inventory IS the witness: a sha256 hex over the canonical-JSON
    // serialization of (sessionId, domain, captured_at, sidecar). The hash
    // is what lands in the SESSION_STATE row's `cookiesInventoryRef` field;
    // cookie VALUES already live in OS Keychain (above). Under stateless
    // mode the inventory NEVER touches disk in cleartext — the hash is
    // the only artifact that crosses the firmament.
    const inventoryDoc = {
      sessionId,
      domain: targetDomain,
      captured_at: Date.now(),
      cookies: sidecar,
    };
    const canonicalInventory = JSON.stringify(inventoryDoc);
    const cookiesInventoryRef = createHash("sha256")
      .update(canonicalInventory)
      .digest("hex");

    // ── Persist the inventory_ref onto the session record ─────────────────
    rec = { ...rec, cookies_inventory_ref: cookiesInventoryRef };
    await writeSessionRecord(rec);

    // ── The hash above IS the canonical witness; the cleartext sidecar
    // never lands on disk. Per STATELESS_BOUNDARY §H invariant 7.

    // ── Scrub the in-process value buffer one more time ───────────────────
    for (const k of Object.keys(nameToValue)) nameToValue[k] = "";

    const pointer = `keychain://${KEYCHAIN_SERVICE}/${targetDomain}`;

    // W24.2 — finish-witness: keychain write succeeded, inventory hashed.
    // The pair (start, finish) lets a forensic query distinguish "auth
    // captured + sealed" from "auth started but timed out". Pointer-only:
    // selector carries domain hash; no cookie names/values cross.
    const finishAudit = await emitBreathActStateless({
      sessionId,
      actType: "auth-capture-finish",
      selector: targetDomain,
      currentUrl: loginUrl,
    });

    emit(
      {
        ok: true,
        subcommand: "breath auth-capture",
        op_kind: meta.op_kind,
        session_id: sessionId,
        domain: targetDomain,
        pointer,
        cookie_names: sidecar.map((c) => c.name),
        cookie_count: sidecar.length,
        cookies_inventory_ref: cookiesInventoryRef,
        audit: {
          start: {
            ok: startAudit.ok,
            receipt_id: startAudit.receiptId,
            cache_key: startAudit.cacheKey,
            binding_missing: startAudit.bindingMissing,
          },
          finish: {
            ok: finishAudit.ok,
            receipt_id: finishAudit.receiptId,
            cache_key: finishAudit.cacheKey,
            binding_missing: finishAudit.bindingMissing,
          },
          variant: "breath-act",
          act_type: "auth-capture",
        },
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  } finally {
    // Best-effort detach. We intentionally do NOT close the target/Chrome
    // — the session is now usable by downstream `breath` commands via the
    // recorded chromeWsUrl. The user/agent calls `breath close` when done.
    void target;
    void conn;
  }
}
