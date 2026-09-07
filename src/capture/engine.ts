/**
 * engine — the firmament between the two capture engines.
 *
 * Two engines produce routes: obscura (Chrome-free sidecar) and the legacy
 * CDP path (`capture/index.ts`, ~3,000 lines). Before this file, only ONE caller
 * knew that — `execution/index.ts` held a private `if (obscuraBackendSelected())`
 * while five other `captureSession` callers took Chrome unconditionally, so
 * `UNBROWSE_BROWSER_BACKEND=obscura` meant different things depending on which
 * door you came through.
 *
 * The separation is deliberate and load-bearing:
 *
 *   - Selection lives HERE, above both engines. Branching obscura *inside*
 *     capture/index.ts would make every future change to 3,000 lines of CDP pay
 *     for both engines at once — new wine, old bottle. A signal in
 *     tests/obscura-capture-signals.test.ts asserts that file stays obscura-free.
 *   - Neither engine imports the other. They already share the only thing they
 *     need to: `RawRequest`.
 *   - CAPTURE ONLY. `captureAndIndexViaObscura` can also index and share; this
 *     seam deliberately does not, so indexing stays where callers already do it
 *     (`passiveIndexFromRequests`) and no side effect hides inside a dispatch.
 *
 * The two results are not the same shape, and this returns their INTERSECTION
 * plus the engine's name. A caller needing Chrome-only extras (cookies,
 * ws_messages, html) must ask for the CDP engine explicitly — a visible choice
 * rather than an accident.
 */
import type { RawRequest } from "./index.js";
import { obscuraBackendSelected } from "../execution/obscura-backend.js";

export type CaptureEngine = "obscura" | "cdp";

export interface CapturedRoutes {
  /** The routes discovered, in the currency both engines already speak. */
  routes: RawRequest[];
  /** Which engine produced them — recorded so callers never have to guess. */
  engine: CaptureEngine;
  domain: string;
  finalUrl: string;
  /**
   * Canonical failure token, or absent. `origin_down` when nothing was received
   * at all — the distinction between "this host is gone" and "this page has no
   * XHR", which both otherwise present as `routes: []`.
   */
  error?: string;
  /**
   * Routes a bot wall answered instead of the origin: `{url, vendor}`.
   *
   * A THIRD outcome, distinct from both of the above. Without it, "Cloudflare
   * refused this endpoint" and "this endpoint does not exist" arrive at the
   * caller identically — as an absence — and an absence invites the wrong
   * repair. Measured: obscura asked defillama for
   * `/api/public/protocol-rankings` and got 403 + "Just a moment...", where
   * Chrome got 200 and 301,918 bytes of JSON. Nothing was missing; something
   * was refused.
   */
  blocked?: Array<{ url: string; vendor: string }>;
}

export interface CaptureRoutesOptions {
  /** Force an engine, ignoring the environment. Tests and explicit callers. */
  engine?: CaptureEngine;
  /** obscura only: follow N discovered same-origin links. 0 = passive only. */
  maxFollow?: number;
}

/**
 * Capture a URL's routes with whichever engine is selected.
 *
 * Never throws for an unreachable origin — that is reported as `error`, because
 * a dead host is a RESULT, not an exception, and callers branch on it.
 */
export async function captureRoutes(
  url: string,
  intent: string | undefined,
  opts: CaptureRoutesOptions = {},
): Promise<CapturedRoutes> {
  const engine: CaptureEngine = opts.engine ?? (obscuraBackendSelected() ? "obscura" : "cdp");

  if (engine === "obscura") {
    const { captureAndIndexViaObscura } = await import("./obscura-index.js");
    const r = await captureAndIndexViaObscura(url, intent, {
      shareToIndex: false, // the seam captures; callers decide indexing/sharing
      maxFollow: opts.maxFollow ?? 0,
    });
    const capture = r.capture as { final_url?: string; domain?: string; error?: string };
    const blocked = (r.blocked ?? []).map((b) => ({ url: b.request.url, vendor: b.vendor }));
    return {
      routes: r.routes ?? [],
      engine,
      domain: capture?.domain ?? "",
      finalUrl: capture?.final_url ?? url,
      ...(capture?.error ? { error: capture.error } : {}),
      ...(blocked.length > 0 ? { blocked } : {}),
    };
  }

  const { captureSession } = await import("./index.js");
  const cap = await captureSession(url, undefined, undefined, intent);
  return {
    routes: cap?.requests ?? [],
    engine,
    domain: cap?.domain ?? "",
    finalUrl: cap?.final_url ?? url,
  };
}

/**
 * Announce, once per process, that a path is taking the CDP engine even though
 * obscura was explicitly selected.
 *
 * My own recorded defect: "a backend explicitly selected as obscura should fail
 * loudly, not quietly become Chrome." Some paths genuinely need what only the
 * CDP engine returns — obscura's sidecar reports `htmlLen` but not the HTML
 * text, and has no cookies/ws_messages/js_bundles equivalent — so silence was
 * the bug, not the choice. A caller who set the env now learns which capability
 * pulled Chrome back in, and can act on it.
 *
 * Not an error and never a throw: the capture still happens and still works.
 * Once per process because these sites sit in retry loops, and a notice that
 * repeats is a notice that gets filtered out.
 */
const cdpNoticesGiven = new Set<string>();
export function noteCdpRequired(needs: string): void {
  if (!obscuraBackendSelected()) return;
  if (cdpNoticesGiven.has(needs)) return;
  cdpNoticesGiven.add(needs);
  process.stderr.write(
    `[unbrowse] backend=obscura selected, but this path uses the CDP engine: it needs ${needs}, `
      + `which the obscura capture sidecar does not return.\n`,
  );
}

/** Test seam: forget which notices were given. */
export function __resetCdpNotices(): void {
  cdpNoticesGiven.clear();
}
