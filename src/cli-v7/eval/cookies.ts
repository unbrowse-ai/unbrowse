/**
 * `unbrowse eval cookies [domain]` — cookie listing.
 *
 * 1:1 mapping (kind-map.ts row "eval cookies"):
 *   CLI subcommand  : eval cookies
 *   MCP tool        : unbrowse_cookies
 *   Op kind   : eval:cookies
 *   Verb            : eval
 *
 * SECRET-REDACTION INVARIANT (load-bearing — W3 spec, contract ee1f5409):
 * The CDP Network.getCookies surface returns full `value` strings. This
 * handler MUST strip them at the boundary and NEVER emit `value` on any
 * code path — stdout, stderr, --json, --debug, or error envelope. The
 * `redactCookies` helper below is the single point of egress and is
 * defensive even if a refactor breaks the layering above it.
 *
 * Read-only — no audit POST. The cookie metadata IS the pointer; values
 * remain only in the live browser process.
 */
import { createHash } from "node:crypto";

import { attach, attachToTarget, call } from "../../cdp/index.js";
import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless } from "../_stateless.js";

function urlHash32(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

interface RawCDPCookie {
  name?: unknown;
  value?: unknown; // NEVER propagate — see redactCookies
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
}

interface GetCookiesResult {
  cookies: RawCDPCookie[];
}

/**
 * Redaction filter — the single egress point for cookie data. Defensively
 * constructs a NEW object with only the allowed keys; never destructures the
 * CDP cookie (which would risk spreading `value` accidentally).
 *
 * Exported for tests and for any future audit-receipt path that must witness
 * "the cookie shape after redaction" without re-running CDP.
 */
export interface RedactedCookie {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
}

export function redactCookies(raw: ReadonlyArray<Record<string, unknown>>): RedactedCookie[] {
  return raw.map((c) => {
    const sameSiteRaw = c.sameSite;
    const sameSite: "Strict" | "Lax" | "None" | undefined =
      sameSiteRaw === "Strict" || sameSiteRaw === "Lax" || sameSiteRaw === "None"
        ? sameSiteRaw
        : undefined;
    // Explicit construction. Do NOT spread `c` — that would carry `value`.
    return {
      name: String(c.name ?? ""),
      domain: String(c.domain ?? ""),
      path: String(c.path ?? "/"),
      expires: typeof c.expires === "number" ? c.expires : -1,
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      ...(sameSite !== undefined ? { sameSite } : {}),
    };
  });
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "cookies")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval cookies",
      {
        summary: "Cookie listing for a domain — names + domains + expires ONLY (no values).",
        usage: "unbrowse eval cookies [domain] [--session <id>] [--no-json]",
        positional: [
          { name: "domain", description: "Restrict to this domain/URL (default: all on current page).", required: false },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--no-json", description: "Pretty-print `name@domain` lines instead of JSON." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const domainArg = parsed.positional[0];
  const noJson = parsed.flags["no-json"] === true;

  try {
    const rec = await resolveSession(sessionFlag);
    const conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);

    // Build the urls filter if a domain was supplied. CDP accepts http+https
    // URL prefixes; we synthesise both so the user can pass a bare domain.
    const urls: string[] | undefined = domainArg
      ? (/^https?:\/\//.test(domainArg)
          ? [domainArg]
          : [`https://${domainArg}/`, `http://${domainArg}/`])
      : undefined;

    const result = await call<{ urls?: string[] }, GetCookiesResult>(
      conn,
      "Network.getCookies",
      urls ? { urls } : {},
      target.sessionId,
    );

    // SECRET REDACTION at the boundary. The raw `result.cookies` array MUST
    // NOT escape this scope. `redactCookies` returns brand-new objects with
    // no `value` field.
    const redacted = redactCookies(
      (result.cookies ?? []) as unknown as ReadonlyArray<Record<string, unknown>>,
    );

    // Defense-in-depth (Day-6 worker 3) — re-assert the cookie-value
    // invariant AFTER redaction. Even though `redactCookies` constructs
    // brand-new objects with an explicit allowed-keys whitelist, the
    // boundary assertion catches a future refactor that re-introduces a
    // `value` leak via type-erasure. If ANY redacted entry carries a key
    // matching `value` (any case), the handler errors out BEFORE emit.
    // Stricter than W10-A's redactCookies-pure-function discipline.
    for (const c of redacted as readonly unknown[]) {
      const obj = c as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (k.toLowerCase() === "value" || k.toLowerCase() === "cookievalue") {
          throw new Error(
            "eval-cookies-redaction-violation: redacted cookie carried a forbidden value-shaped key",
          );
        }
      }
    }

    // A2 — sig-keyed audit row. The wire body carries ONLY metadata:
    // sessionId, urlHash, readKind="cookies", byteCount=N. It NEVER
    // carries cookie names, NEVER cookie domains, and absolutely
    // NEVER cookie values. The signed fragment whitelist is the gate
    // that makes a value leak structurally impossible.
    let currentUrl = "";
    try {
      const r = await call<{ expression: string; returnByValue: boolean }, { result?: { value?: unknown } }>(
        conn,
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        target.sessionId,
      );
      if (typeof r.result?.value === "string") currentUrl = r.result.value;
    } catch { /* best-effort URL capture */ }
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        sessionId: rec.sessionId,
        urlHash: urlHash32(currentUrl),
        readKind: "cookies" as const,
        byteCount: redacted.length,
      },
      signableFields: [
        "sessionId",
        "urlHash",
        "readKind",
        "byteCount",
        "selectorHash",
        "nonce",
      ],
    });
    const auditEmit = {
      ok: post.ok,
      cacheKey: post.cacheKey,
      receiptId: post.receiptId,
      httpStatus: post.httpStatus,
      bindingMissing: post.bindingMissing,
      errorHint: post.errorHint,
    };

    if (noJson) {
      // `name@domain` per line — no JSON serialisation surface.
      for (const c of redacted) {
        process.stdout.write(`${c.name}@${c.domain}\n`);
      }
    } else {
      emit(
        {
          ok: true,
          subcommand: "eval cookies",
          op_kind: meta.op_kind,
          session_id: rec.sessionId,
          target_id: rec.targetId,
          domain: domainArg ?? null,
          count: redacted.length,
          cookies: redacted,
          audit_emit: auditEmit,
        },
        opts,
      );
    }
    process.exit(0);
  } catch (err) {
    // Even on error: emit only the error message. CDP error payloads should
    // not contain cookie values, but be defensive — never `String(err)` over
    // an object that might serialise a raw cookie.
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
