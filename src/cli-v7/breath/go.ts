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
  attachToTarget,
  createTarget,
  spawnChrome,
} from "../../cdp/index.js";
import type { ParsedV7Args } from "../args.js";
import {
  reapStaleSessions,
  resolveSession,
  writeSessionRecord,
  type BrowseSessionRecord,
} from "../_session.js";
import {
  isObscuraSession,
  obscuraBackendSelected,
  openObscuraPage,
  navigateObscuraSession,
} from "../../obscura/live-page.js";
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
import { guardAct, parseActTimeoutMs } from "./_act-deadline.js";
import { classifyAuthenticatedPage } from "../../auth/index.js";

/**
 * ISSUE-2 — a cookie the tab already holds WINS over a browser-extracted one of
 * the same name.
 *
 * On the re-use path the tab's jar holds whatever the SERVER set during an
 * interactive login (`act fill` + `act submit`). A cookie of the same name
 * extracted from a daily-driver browser profile is, by construction, the older
 * copy — it predates the login that just happened in this tab. Writing it back
 * over the live one is how an in-session login gets discarded while the
 * envelope still says `ok:true`: you get a valid-looking logged-out 404, not an
 * error. So injection ADDS names the jar does not have and never overwrites one
 * it does.
 *
 * Name-only match is the right key here because the live list comes from
 * `Network.getCookies {urls:[url]}`, which already returns only the cookies
 * that would be sent to THIS url — a name present in that list is a live
 * cookie for this site, whatever its domain/path spelling.
 */
export function withoutClobberingLiveCookies<C extends { name: string }>(
  live: ReadonlyArray<{ name: string }>,
  candidates: readonly C[],
): C[] {
  const held = new Set(live.map((c) => c.name));
  return candidates.filter((c) => !held.has(c.name));
}

/**
 * The boundaries `handler` crosses, as one injectable record.
 *
 * Production passes nothing and gets `REAL_GO_DEPS`. It exists because bun's
 * `mock.module` is PROCESS-WIDE: two test files mocking `src/cdp/index.js` with
 * different fakes silently overwrite each other, and the one that loads last
 * wins for everybody — so a gate can go red for a reason that has nothing to do
 * with the code it guards. A parameter cannot do that to another file.
 */
export interface GoDeps {
  readonly attach: typeof attach;
  readonly attachToTarget: typeof attachToTarget;
  readonly createTarget: typeof createTarget;
  readonly spawnChrome: typeof spawnChrome;
  readonly resolveSession: typeof resolveSession;
  readonly reapStaleSessions: typeof reapStaleSessions;
  readonly writeSessionRecord: typeof writeSessionRecord;
  readonly emitBreathAct: typeof emitBreathActStateless;
  readonly loadBrowserCookies: () => Promise<{
    findBestBrowserSession: (host: string) => {
      cookies: BrowserCookieLike[];
      browser?: string;
      source?: string | null;
      sessionCookies?: number;
      quality?: number;
    } | null;
    extractBrowserCookies: (host: string) => { cookies: BrowserCookieLike[]; source?: string | null };
  }>;
}

export function adjudicateNavigationOutcome(input: {
  targetUrl: string;
  finalUrl?: string | null;
  pageText?: string | null;
}): {
  operationalOk: boolean;
  taskOk: boolean;
  error?: "navigation_not_committed" | "challenge_page";
  blocker?: "challenge";
} {
  const finalUrl = (input.finalUrl ?? "").trim();
  if (!finalUrl || finalUrl === "about:blank") {
    return { operationalOk: false, taskOk: false, error: "navigation_not_committed" };
  }
  const evidence = `${finalUrl} ${input.pageText ?? ""}`;
  if (/\b(access denied|press\s*&\s*hold|human verification challenge|please wait for verification|js_challenge|verify you are human|captcha|just a moment)\b/i.test(evidence)) {
    return { operationalOk: false, taskOk: false, error: "challenge_page", blocker: "challenge" };
  }
  return { operationalOk: true, taskOk: true };
}

/**
 * A pure projection of CDP runtime values into the evidence used to judge a
 * navigation. Keeping this free of a connection/session makes it independently
 * falsifiable and prevents browser state from becoming part of the verdict.
 */
export function navigationObservation(input: {
  readyState?: unknown;
  bodyText?: unknown;
  locationHref?: unknown;
}): { readyState: string | null; pageText: string | null; finalUrl: string | null } {
  const readyState = typeof input.readyState === "string" ? input.readyState : null;
  const pageText = typeof input.bodyText === "string" && input.bodyText.length > 0
    ? input.bodyText.slice(0, 200000)
    : null;
  const finalUrl = typeof input.locationHref === "string" && input.locationHref.trim().length > 0
    ? input.locationHref.trim()
    : null;
  return { readyState, pageText, finalUrl };
}

export function targetRequiresAuthenticatedEvidence(targetUrl: string): boolean {
  try {
    const { hostname, pathname } = new URL(targetUrl);
    return (hostname === "github.com" && pathname.startsWith("/settings"))
      || ((hostname === "x.com" || hostname === "twitter.com") && pathname.startsWith("/home"))
      || (hostname.endsWith("linkedin.com") && pathname.startsWith("/feed"));
  } catch {
    return false;
  }
}

/** The shape `go` needs off a browser-extracted cookie. */
interface BrowserCookieLike {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}

export const REAL_GO_DEPS: GoDeps = {
  attach,
  attachToTarget,
  createTarget,
  spawnChrome,
  resolveSession,
  reapStaleSessions,
  writeSessionRecord,
  emitBreathAct: emitBreathActStateless,
  loadBrowserCookies: () => import("../../auth/browser-cookies.js"),
};

export async function handler(
  parsed: ParsedV7Args,
  opts: OutputOptions,
  deps: GoDeps = REAL_GO_DEPS,
): Promise<void> {
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
          {
            name: "--session",
            description:
              "Navigate THIS browse session's existing tab, keeping its cookie jar (an in-session login survives). Omit to open a new session.",
            value_expected: true,
          },
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

  // ISSUE-2 / ISSUE-4 — two things `go` used to advertise and not do.
  //
  //   --session : every other breath verb resolves it; `go` alone ignored it and
  //               unconditionally spawned a browser with a FRESH temp profile
  //               (chrome.ts: `mkdtempSync(...unbrowse-cdp-)` per spawn), so a
  //               login performed inside a session could not survive the next
  //               `go` in that same session.
  //   --timeout : documented at 30000 and never read. The only real bound was a
  //               hardcoded 6s readyState poll, so `--timeout 120000` bought 6
  //               seconds. It now feeds the SHARED bound in _act-deadline.ts —
  //               the same one click/select/run-js use, not a second mechanism.
  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const timeoutMs = parseActTimeoutMs(parsed.flags);
  const startedAtMs = Date.now();
  /** Wall clock left in this act's budget. Every later bound is carved from it. */
  const remainingMs = (): number => Math.max(0, timeoutMs - (Date.now() - startedAtMs));

  try {
    // `--session <id>` = navigate the tab that session already owns. Resolve it
    // BEFORE anything is spawned, and let a dead session throw: silently opening
    // a fresh browser under the id the caller named is precisely the "reports
    // work it did not do" failure this whole change is about — the caller would
    // get ok:true, a new logged-out context, and no way to see the swap.
    const existing: BrowseSessionRecord | undefined = sessionFlag
      ? await deps.resolveSession(sessionFlag)
      : undefined;

    // Chrome-free backend. Two entry points, one branch:
    //   fresh   — UNBROWSE_BROWSER_BACKEND=obscura selects it for a NEW session;
    //   re-use  — the resolved session is already obscura-backed, so it stays so
    //             regardless of the env (the record, not the environment, decides).
    // The session record shape is unchanged (chromePid = the broker pid), so
    // resolveSession / reapStaleSessions / close keep working untouched.
    const reuseObscura = Boolean(existing && isObscuraSession(existing));
    if (reuseObscura || (!existing && obscuraBackendSelected())) {
      const { record, url: settledUrl } = reuseObscura
        ? await navigateObscuraSession(existing!, url)
        : await openObscuraPage(url, { readyTimeoutMs: Math.max(5000, remainingMs()) });
      await deps.writeSessionRecord(record);
      emit(
        {
          ok: true,
          operational_ok: true,
          task_ok: true,
          subcommand: "breath go",
          op_kind: meta.op_kind,
          session_id: record.sessionId,
          target_id: record.targetId,
          context_id: record.contextId,
          chrome_ws_url: record.chromeWsUrl,
          backend: "obscura",
          url,
          final_url: settledUrl,
          session_reused: reuseObscura,
        },
        opts,
      );
      process.exit(0);
    }

    if (!existing) {
      // Bound the persisted-Chrome footprint before spawning a new one: prune
      // dead-Chrome records and cap live browse sessions so `go` without a
      // matching `close` cannot leak browsers indefinitely. Best-effort. Not run
      // on the re-use path — that path spawns nothing, and the cap could reap
      // the very session the caller asked to navigate.
      await deps.reapStaleSessions().catch(() => undefined);
    }

    // Everything past this line crosses to Chrome, and a stale lease/target
    // accepts the frame and never answers (ISSUE-4). One shared bound, and it
    // reports `target_lost` rather than a navigation that did not happen.
    const nav = await guardAct(
      {
        subcommand: "breath go",
        opKind: meta.op_kind,
        waitingOn: existing
          ? `Page.navigate to ${url} on target ${existing.targetId}`
          : `browser spawn + navigate to ${url}`,
        timeoutMs,
        opts,
        ...(existing ? { sessionId: existing.sessionId } : {}),
      },
      async () => {
        // W5 surface: attach to a user-supplied ws endpoint or spawn a fresh
        // browser. The CDPConnection carries chromeBin/pid/endpoint as pointer
        // fields we persist below.
        const wsEndpoint = typeof parsed.flags.ws === "string" ? parsed.flags.ws : undefined;
        const conn = existing
          // Re-use: the session record's ws endpoint IS the browser that holds the
          // jar built by the interactive login.
          ? await deps.attach(existing.chromeWsUrl)
          : wsEndpoint
          ? await deps.attach(wsEndpoint)
          // Default browser context (persist mode) cannot carry a per-context proxy
          // — `--proxy-server=per-context` with no context-level proxy set makes
          // Chrome fail every request with ERR_PROXY_CONNECTION_FAILED. Go direct;
          // anti-bot/clean-IP egress is a separate global-proxy lever.
          : await deps.spawnChrome({ headless: true, perContextProxy: false, persist: true });

        // Persistent browse session uses Chrome's DEFAULT browser context. An
        // incognito context (createBrowserContext) is auto-disposed by Chrome the
        // moment this CLI process disconnects, which orphans the tab and breaks
        // re-attach from a separate `eval snap` / `act click` / `act close` call.
        //
        // Re-use path: attach to the tab that already exists and drive Page.navigate
        // on it. createTarget would open a NEW tab — a new tab in the same profile
        // shares the persisted jar, but session-scoped cookies (the ones a login
        // form sets, and the ones this bug is about) and in-memory page state do not
        // reliably survive the hop, and the session record would then point at a
        // different target than the one the caller has been acting on.
        // Create an inert target and navigate only after attaching. Passing the
        // destination to Target.createTarget starts navigation before the flat CDP
        // session exists; fast pages can finish (or replace the execution context)
        // before Runtime is observed, leaving this process reading about:blank.
        // One explicit Page.navigate after Page.enable gives both fresh and reused
        // targets the same stateless transition.
        const target = existing
          ? await deps.attachToTarget(conn, existing.targetId)
          : await deps.createTarget(conn, "about:blank", {});
        await conn.call("Page.enable", {}, target.sessionId);
        const navigateResult = await conn.call<
          { url: string },
          { errorText?: string }
        >("Page.navigate", { url }, target.sessionId);
        if (navigateResult?.errorText) {
          throw new Error(`navigation_failed: ${navigateResult.errorText}`);
        }

        // Auth: createTarget opens a FRESH cookie jar, so an auth-walled SPA
        // (x.com/i/bookmarks, etc.) renders the logged-out wall. The server route
        // /v1/browse/go injects cookies via importBrowserCookiesIntoTab, but that
        // helper targets the kuri broker; the local CLI drives its OWN spawned
        // Chrome over a raw CDP conn, so we inject here over raw CDP (Network.
        // setCookies on the tab's flat sessionId) and re-navigate so the
        // authenticated page renders. Best-effort + fail-visible, never blocks nav.
        let cookiesInjected = 0;
        let cookiesPreserved = 0;
        /** Metadata only — never cookie values. Which local jar (if any) we used. */
        let cookiesSource: string | null = null;
        let cookiesBrowser: string | null = null;
        let cookiesImportDisabled = false;
        // The cookie set that AUTHENTICATES this url: whatever the tab's jar already
        // holds (an in-session login) plus whatever we inject below. The post-navigate
        // direct-fetch supplement re-uses it for an API-shaped URL whose navigated
        // body comes back empty / anti-bot-walled — and on the re-use path it must
        // carry the live login, or the supplement would overwrite page.text with a
        // logged-out JSON body fetched under stale cookies.
        let authCookies: Array<{ name: string; value: string }> = [];
        try {
          const { shouldImportBrowserCookies } = await import("../../auth/index.js");
          if (!shouldImportBrowserCookies()) {
            cookiesImportDisabled = true;
            process.stderr.write(
              `[auth] breath go: browser cookie import disabled (UNBROWSE_IMPORT_BROWSER_COOKIES / UNBROWSE_COOKIE_IMPORT=0)\n`,
            );
          } else {
            const host = new URL(url).hostname;
            const { findBestBrowserSession, extractBrowserCookies } = await deps.loadBrowserCookies();
            const explicitChromiumSource = Boolean(
              process.env.UNBROWSE_CHROME_USER_DATA_DIR?.trim()
              || process.env.UNBROWSE_COOKIE_DB_PATH?.trim()
              || process.env.UNBROWSE_CHROME_PROFILE?.trim(),
            );
            const best = explicitChromiumSource ? null : findBestBrowserSession(host);
            const extracted = best?.cookies ?? extractBrowserCookies(host).cookies;
            cookiesBrowser = best?.browser ?? null;
            cookiesSource = best?.source ?? null;
            if (!cookiesSource && extracted.length > 0) {
              cookiesSource = "browser-auto";
            }

            // Re-use path only: read the jar this tab ALREADY has before writing to
            // it. `Network.getCookies {urls:[url]}` returns exactly the cookies that
            // would be sent to this url.
            //
            // Fail CLOSED, not open: if the jar cannot be enumerated we skip
            // injection entirely rather than write blind, because writing blind is
            // the bug — it would overwrite a live login with the older extracted
            // copy and hand back a logged-out page under ok:true.
            let live: Array<{ name: string; value: string }> | null = null;
            if (existing) {
              try {
                await conn.call("Network.enable", {}, target.sessionId);
                const got = await conn.call<
                  { urls: string[] },
                  { cookies?: Array<{ name: string; value: string }> }
                >("Network.getCookies", { urls: [url] }, target.sessionId);
                live = (got?.cookies ?? []).map((c) => ({ name: c.name, value: c.value }));
              } catch (jarErr) {
                live = null;
                process.stderr.write(
                  `[auth] breath go: session jar unreadable (${jarErr instanceof Error ? jarErr.message : String(jarErr)}); injection skipped to avoid clobbering an in-session login\n`,
                );
              }
            }

            const cookies = existing
              ? live === null
                ? []
                : withoutClobberingLiveCookies(live, extracted)
              : extracted;
            cookiesPreserved = live?.length ?? 0;
            authCookies = [
              ...(live ?? []),
              ...cookies.map((c) => ({ name: c.name, value: c.value })),
            ];
            if (existing && live !== null && cookies.length < extracted.length) {
              process.stderr.write(
                `[auth] breath go: kept ${extracted.length - cookies.length} in-session cookie(s) for ${host}; browser-extracted copies not written over them\n`,
              );
            }
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
              const srcLabel = cookiesSource ?? cookiesBrowser ?? "unknown";
              process.stderr.write(
                `[auth] breath go: injected ${cdpCookies.length} browser cookie(s) for ${host} from ${srcLabel}; authentication remains unverified until target evidence is read\n`,
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
        let finalUrl: string | null = null;
        try {
          await conn.call("Runtime.enable", {}, target.sessionId);
          // Was a hardcoded 6s, which is what made `--timeout 120000` mean six
          // seconds. It is now carved from the flag's remaining budget — but only
          // HALF of it, and it stays best-effort. A page that never reaches
          // readyState:complete (long-poll, streaming, a hung XHR) must still come
          // back as a session with `page.text:null`, exactly as before; letting the
          // poll eat the whole budget would convert that into a `target_lost` at the
          // outer bound and fail a navigation that actually worked. The floor is
          // itself capped by what is left, so a small `--timeout` cannot make the
          // floor overshoot the outer bound and manufacture that same false failure.
          const pollBudgetMs = Math.min(remainingMs(), Math.max(500, Math.floor(remainingMs() / 2)));
          const deadline = Date.now() + pollBudgetMs;
          let observedReadyState: unknown = null;
          let observedLocation: unknown = null;
          while (Date.now() < deadline) {
            const rs = await conn.call<{ expression: string; returnByValue: boolean }, { result?: { value?: unknown } }>(
              "Runtime.evaluate",
              { expression: "document.readyState", returnByValue: true },
              target.sessionId,
            );
            const location = await conn.call<{ expression: string; returnByValue: boolean }, { result?: { value?: unknown } }>(
              "Runtime.evaluate",
              { expression: "location.href", returnByValue: true },
              target.sessionId,
            );
            observedReadyState = rs?.result?.value;
            observedLocation = location?.result?.value;
            // about:blank is already `complete`; treating readiness alone as a
            // commit is the race that produced the false failure.
            if (observedReadyState === "complete" && observedLocation !== "about:blank") break;
            await new Promise((res) => setTimeout(res, 200));
          }
          const body = await conn.call<{ expression: string; returnByValue: boolean }, { result?: { value?: unknown } }>(
            "Runtime.evaluate",
            { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
            target.sessionId,
          );
          const location = await conn.call<{ expression: string; returnByValue: boolean }, { result?: { value?: unknown } }>(
            "Runtime.evaluate",
            { expression: "location.href", returnByValue: true },
            target.sessionId,
          );
          const observed = navigationObservation({
            readyState: observedReadyState,
            bodyText: body?.result?.value,
            locationHref: location?.result?.value ?? observedLocation,
          });
          pageText = observed.pageText;
          finalUrl = observed.finalUrl;
        } catch (readErr) {
          process.stderr.write(
            `[page] breath go: body read skipped: ${readErr instanceof Error ? readErr.message : String(readErr)}\n`,
          );
        }

        // Credential-presented direct-fetch supplement (shape-recognized, not allowlisted).
        // When `act go` navigates an API-shaped URL, CDP renders the API's JSON
        // (or an anti-bot wall block page) into document.body.innerText — and the
        // wall page yields a body that does NOT decode to a structured JSON record.
        // The page of an API URL IS its JSON, so when the navigated body is not a
        // structured response AND we have the browser's auth cookies, fetch the same
        // URL directly with those cookies (Chrome's own session) and, IF that body
        // decodes to a JSON object/collection, use it as page.text — the authenticated
        // content the caller navigated to. Fail-visible; never replaces a real
        // HTML-page navigate (an HTML page's innerText already decodes to no JSON, so
        // the direct fetch's HTML body also won't — leaving pageText untouched).
        const decodesToJsonRecord = (s: string | null): boolean => {
          if (!s) return false;
          const t = s.trim();
          if (!(t.startsWith("{") || t.startsWith("["))) return false;
          try {
            const v = JSON.parse(t);
            return v !== null && typeof v === "object"; // object or array = a record/collection
          } catch {
            return false;
          }
        };
        if (!decodesToJsonRecord(pageText) && authCookies.length > 0) {
          try {
            const cookieHeader = authCookies
              .map((c) => {
                const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
                return `${c.name}=${v}`;
              })
              .join("; ");
            const ua =
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
            const res = await fetch(url, {
              headers: { Cookie: cookieHeader, "User-Agent": ua, Accept: "application/json" },
              // Inside the act's wall clock, not beside it: a fixed 10s here could
              // outlive a `--timeout 5000` and let the outer bound fire mid-fetch.
              signal: AbortSignal.timeout(Math.max(1_000, Math.min(10_000, remainingMs()))),
            });
            const directBody = await res.text();
            if (decodesToJsonRecord(directBody)) {
              pageText = directBody.slice(0, 200000);
              process.stderr.write(
                `[auth] breath go: navigated body unstructured/walled; supplemented page.text from credential-presented direct fetch (status ${res.status}, ${directBody.length} bytes)\n`,
              );
            } else {
              process.stderr.write(
                `[auth] breath go: direct-fetch supplement skipped — body not a JSON record (status ${res.status})\n`,
              );
            }
          } catch (directErr) {
            process.stderr.write(
              `[auth] breath go: direct-fetch supplement failed: ${directErr instanceof Error ? directErr.message : String(directErr)}\n`,
            );
          }
        }

        // Captcha solve as default fallback when a widget is present. Metered via
        // backend /v1/solve (server holds Capzy key); clearCaptchaInRender no-ops
        // when there is no sitekey widget, and degrades when no agent key / 402.
        // Opt out: UNBROWSE_AUTO_SOLVE=0 or --no-solve.
        let captcha: import("../../cdp/captcha-render.js").CaptchaRenderResult | undefined;
        const autoSolveRaw = (process.env.UNBROWSE_AUTO_SOLVE ?? "1").trim().toLowerCase();
        const autoSolveOff = autoSolveRaw === "0" || autoSolveRaw === "false" || autoSolveRaw === "no" || autoSolveRaw === "off"
          || parsed.flags["no-solve"] === true;
        if (!autoSolveOff || parsed.flags.solve === true) {
          const { clearCaptchaInRender } = await import("../../cdp/captcha-render.js");
          captcha = await clearCaptchaInRender(conn, target, url).catch(
            () => ({ cleared: false, reason: "error" }) as import("../../cdp/captcha-render.js").CaptchaRenderResult,
          );
        }

        return {
          conn,
          target,
          cookiesInjected,
          cookiesPreserved,
          cookiesSource,
          cookiesBrowser,
          cookiesImportDisabled,
          pageText,
          finalUrl,
          captcha,
        };
      },
    );
    const {
      conn,
      target,
      cookiesInjected,
      cookiesPreserved,
      cookiesSource,
      cookiesBrowser,
      cookiesImportDisabled,
      pageText,
      finalUrl,
      captcha,
    } = nav;
    const hadPresentedCredentials = cookiesInjected > 0 || cookiesPreserved > 0;
    const authOutcome = classifyAuthenticatedPage({
      pageText: pageText ?? undefined,
      hadPresentedCredentials,
      currentUrl: finalUrl ?? url,
      targetUrl: url,
    });
    const navigation = adjudicateNavigationOutcome({ targetUrl: url, finalUrl, pageText });
    const protectedTarget = targetRequiresAuthenticatedEvidence(url);
    const authRequired = authOutcome === "auth_required"
      || (protectedTarget && authOutcome !== "authenticated");

    // Re-use keeps the caller's session id, target and Chrome — the record is
    // rewritten only to refresh `createdAt`, so an actively-driven session is
    // not the one `reapStaleSessions` picks off as "oldest". `cookies_inventory_ref`
    // and every other pointer field survive by spread.
    const sessionId = existing ? existing.sessionId : randomUUID();
    const rec: BrowseSessionRecord = existing
      ? { ...existing, createdAt: Date.now() }
      : {
          sessionId,
          contextId: "",
          targetId: target.targetId,
          chromeWsUrl: conn.endpoint,
          chromePid: conn.pid,
          createdAt: Date.now(),
        };
    await deps.writeSessionRecord(rec);

    // W24.2 — emit a sig-keyed `navigate` breath-act receipt. Selector
    // is undefined (navigation has no DOM target); the URL flows through
    // urlHash inside the helper. Best-effort: binding-missing surfaces
    // in the envelope, never blocks the navigation.
    const navAudit = await deps.emitBreathAct({
      sessionId,
      actType: "navigate",
      selector: null,
      currentUrl: url,
    });

    emit(
      {
        ok: navigation.operationalOk,
        operational_ok: navigation.operationalOk,
        task_ok: navigation.taskOk && (!protectedTarget || authOutcome === "authenticated"),
        ...(navigation.error ? { error: navigation.error, terminal: true, retryable: false } : {}),
        ...(navigation.blocker ? { blocker: navigation.blocker } : {}),
        subcommand: "breath go",
        op_kind: meta.op_kind,
        session_id: sessionId,
        target_id: target.targetId,
        context_id: "",
        chrome_ws_url: conn.endpoint,
        url,
        final_url: finalUrl ?? url,
        cookies_injected: cookiesInjected,
        // Never cookie values — only which local browser/profile jar was chosen.
        ...(cookiesSource ? { cookies_source: cookiesSource } : {}),
        ...(cookiesBrowser ? { cookies_browser: cookiesBrowser } : {}),
        ...(cookiesImportDisabled ? { cookies_import_disabled: true } : {}),
        auth_outcome: authOutcome,
        auth_ok: authOutcome === "authenticated" ? true
          : authOutcome === "auth_required" || authOutcome === "session_expired" ? false
          : null,
        auth_required: authRequired,
        session_expired: authOutcome === "session_expired",
        ...(navigation.operationalOk && protectedTarget && authOutcome === "unknown" ? {
          auth_evidence: "missing_authenticated_only_marker",
          next_action: {
            command: "snap",
            command_args: { session: sessionId, filter: "interactive" },
            reason: "Inspect the committed page for authenticated-only, login, or challenge evidence before continuing.",
          },
        } : {}),
        // Say which of the two things happened. `cookies_injected: 0` on a
        // re-used session used to be indistinguishable from a fresh logged-out
        // context; `session_reused` + `cookies_preserved` make the envelope
        // report the jar it actually navigated with.
        session_reused: Boolean(existing),
        ...(existing ? { cookies_preserved: cookiesPreserved } : {}),
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
    process.exit(navigation.operationalOk ? 0 : EX_GENERIC);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
