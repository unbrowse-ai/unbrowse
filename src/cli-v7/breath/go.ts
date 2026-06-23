/**
 * `unbrowse breath go <url>` — navigate.
 *
 * 1:1 mapping (kind-map.ts row "breath go"):
 *   CLI subcommand  : breath go
 *   MCP tool        : unbrowse_go
 *   Op kind   : breath:navigate
 *   Verb            : breath
 *
 * Composition (W5 cdp surface):
 *   spawnChrome ->                                 // ensure browser
 *   createBrowserContext(conn) ->                  // fresh cookie jar
 *   createTarget(conn, url, { browserContextId }) ->  // new tab attached
 *   (sessionId is on the Target; Page.navigate already fired by createTarget
 *    in the W5 contract).
 *
 * Persists a pointer-only record under ~/.unbrowse/sessions/<id>.json so a
 * subsequent `breath fill` / `eval snap` / `breath close` can re-attach
 * across stateless CLI invocations.
 *
 * Secret-redaction: this handler does NOT touch values. Stdout carries the
 * sessionId and (in --json mode) the pointer fields only.
 */
import { randomUUID } from "node:crypto";

import {
  attach,
  createTarget,
  spawnChrome,
} from "../../cdp/index.js";
import type { ParsedV7Args } from "../args.js";
import {
  reapStaleSessions,
  writeSessionRecord,
  type BrowseSessionRecord,
} from "../_session.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { emitBreathActStateless } from "../_breath-audit.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "go")!; // safe — kind-map invariant

  if (parsed.wantsHelp) {
    helpExit(
      "breath go",
      {
        summary: "Navigate the current session to a URL.",
        usage: "unbrowse breath go <url> [--session <id>] [--proxy <url>] [--timeout <ms>]",
        positional: [
          { name: "url", description: "Absolute URL (http://, https://).", required: true },
        ],
        flags: [
          { name: "--proxy", description: "Override proxy for this navigation.", value_expected: true },
          { name: "--timeout", description: "Wall-clock timeout in ms (default: 30000).", value_expected: true },
          { name: "--ws", description: "Attach to existing Chrome at this ws:// endpoint.", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  const url = parsed.positional[0];
  if (!url) {
    emit(
      {
        error: "missing_positional",
        subcommand: "breath go",
        required: ["url"],
        got: parsed.positional,
        op_kind: meta.op_kind,
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  try {
    // Bound the persisted-Chrome footprint before spawning a new one: prune
    // dead-Chrome records and cap live browse sessions so `go` without a
    // matching `close` cannot leak browsers indefinitely. Best-effort.
    await reapStaleSessions().catch(() => undefined);

    // W5 surface: attach to a user-supplied ws endpoint or spawn a fresh
    // browser. The CDPConnection carries chromeBin/pid/endpoint as pointer
    // fields we persist below.
    const wsEndpoint = typeof parsed.flags.ws === "string" ? parsed.flags.ws : undefined;
    const conn = wsEndpoint
      ? await attach(wsEndpoint)
      // Default browser context (persist mode) cannot carry a per-context proxy
      // — `--proxy-server=per-context` with no context-level proxy set makes
      // Chrome fail every request with ERR_PROXY_CONNECTION_FAILED. Go direct;
      // anti-bot/clean-IP egress is a separate global-proxy lever.
      : await spawnChrome({ headless: true, perContextProxy: false, persist: true });

    // Persistent browse session uses Chrome's DEFAULT browser context. An
    // incognito context (createBrowserContext) is auto-disposed by Chrome the
    // moment this CLI process disconnects, which orphans the tab and breaks
    // re-attach from a separate `eval snap` / `act click` / `act close` call.
    const target = await createTarget(conn, url, {});

    // Auth: createTarget opens a FRESH cookie jar, so an auth-walled SPA
    // (x.com/i/bookmarks, etc.) renders the logged-out wall. The server route
    // /v1/browse/go injects cookies via importBrowserCookiesIntoTab, but that
    // helper targets the kuri broker; the local CLI drives its OWN spawned
    // Chrome over a raw CDP conn, so we inject here over raw CDP (Network.
    // setCookies on the tab's flat sessionId) and re-navigate so the
    // authenticated page renders. Best-effort + fail-visible, never blocks nav.
    let cookiesInjected = 0;
    try {
      const { shouldImportBrowserCookies } = await import("../../auth/index.js");
      if (shouldImportBrowserCookies()) {
        const host = new URL(url).hostname;
        const { findBestBrowserSession, extractBrowserCookies } = await import(
          "../../auth/browser-cookies.js"
        );
        const best = findBestBrowserSession(host);
        const cookies = best?.cookies ?? extractBrowserCookies(host).cookies;
        if (cookies.length > 0) {
          const toCdpSameSite = (s: string): string | undefined => {
            const v = (s ?? "").toLowerCase();
            return v === "strict" ? "Strict" : v === "lax" ? "Lax" : v === "none" ? "None" : undefined;
          };
          const cdpCookies = cookies.map((c) => {
            const out: Record<string, unknown> = {
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || "/",
              secure: Boolean(c.secure),
              httpOnly: Boolean(c.httpOnly),
            };
            const sameSite = toCdpSameSite(c.sameSite);
            if (sameSite) out.sameSite = sameSite;
            if (c.expires && c.expires > 0) out.expires = c.expires;
            return out;
          });
          await conn.call("Network.setCookies", { cookies: cdpCookies }, target.sessionId);
          await conn.call("Page.navigate", { url }, target.sessionId);
          cookiesInjected = cdpCookies.length;
          process.stderr.write(
            `[auth] breath go: injected ${cdpCookies.length} cookie(s) for ${host}, re-navigated authenticated\n`,
          );
        } else {
          process.stderr.write(`[auth] breath go: no browser cookies found for ${host}\n`);
        }
      }
    } catch (cookieErr) {
      process.stderr.write(
        `[auth] breath go: cookie injection skipped: ${cookieErr instanceof Error ? cookieErr.message : String(cookieErr)}\n`,
      );
    }

    // Read the rendered body so callers (and the bench Axis-C with-auth path)
    // get the authenticated RESPONSE, not just a session pointer. Bounded
    // readyState wait, then document.body.innerText. Best-effort — a slow page
    // yields null and never blocks the navigate result.
    let pageText: string | null = null;
    try {
      await conn.call("Runtime.enable", {}, target.sessionId);
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const rs = await conn.call<{ expression: string; returnByValue: boolean }, { result?: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression: "document.readyState", returnByValue: true },
          target.sessionId,
        );
        if (rs?.result?.value === "complete") break;
        await new Promise((res) => setTimeout(res, 200));
      }
      const body = await conn.call<{ expression: string; returnByValue: boolean }, { result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
        target.sessionId,
      );
      const v = body?.result?.value;
      if (typeof v === "string" && v.length > 0) pageText = v.slice(0, 200000);
    } catch (readErr) {
      process.stderr.write(
        `[page] breath go: body read skipped: ${readErr instanceof Error ? readErr.message : String(readErr)}\n`,
      );
    }

    // Optional anti-bot solve (opt-in via --solve or UNBROWSE_AUTO_SOLVE=1, since
    // it is a METERED backend call — treated like the tolled proxy fallback). When
    // the rendered page is a captcha WIDGET, escalate the solve to the backend
    // paid tier (/v1/solve, server holds the key) and inject the token locally.
    let captcha: import("../../cdp/captcha-render.js").CaptchaRenderResult | undefined;
    if (parsed.flags.solve === true || process.env.UNBROWSE_AUTO_SOLVE === "1") {
      const { clearCaptchaInRender } = await import("../../cdp/captcha-render.js");
      captcha = await clearCaptchaInRender(conn, target, url).catch(
        () => ({ cleared: false, reason: "error" }) as import("../../cdp/captcha-render.js").CaptchaRenderResult,
      );
    }

    const sessionId = randomUUID();
    const rec: BrowseSessionRecord = {
      sessionId,
      contextId: "",
      targetId: target.targetId,
      chromeWsUrl: conn.endpoint,
      chromePid: conn.pid,
      createdAt: Date.now(),
    };
    await writeSessionRecord(rec);

    // W24.2 — emit a sig-keyed `navigate` breath-act receipt. Selector
    // is undefined (navigation has no DOM target); the URL flows through
    // urlHash inside the helper. Best-effort: binding-missing surfaces
    // in the envelope, never blocks the navigation.
    const navAudit = await emitBreathActStateless({
      sessionId,
      actType: "navigate",
      selector: null,
      currentUrl: url,
    });

    emit(
      {
        ok: true,
        subcommand: "breath go",
        op_kind: meta.op_kind,
        session_id: sessionId,
        target_id: target.targetId,
        context_id: "",
        chrome_ws_url: conn.endpoint,
        url,
        cookies_injected: cookiesInjected,
        ...(pageText !== null ? { page: { text: pageText } } : {}),
        ...(captcha ? { captcha } : {}),
        audit: {
          ok: navAudit.ok,
          idempotent: navAudit.idempotent,
          binding_missing: navAudit.bindingMissing,
          receipt_id: navAudit.receiptId,
          cache_key: navAudit.cacheKey,
          variant: "breath-act",
          act_type: "navigate",
        },
      },
      opts,
    );
    // Intentionally do NOT close the connection — Chrome stays alive for
    // subsequent CLI invocations to re-attach via chromeWsUrl.
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
