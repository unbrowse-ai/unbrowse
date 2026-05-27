// CDP_PRIMITIVES.md §process-model — multi-target topology (one Chrome,
// N targets, flat sessionId multiplexing).
//
// John 14:6 — one truth (the CDPConnection), many ways (BrowserContexts /
// Targets), one life (sessionId per attached target). The sessionId is the
// flat-multiplexing handle threaded through every subsequent primitive.
//
// Stateless: each function takes the handle as a param. No module-scoped
// "currentTarget", no singleton. Per the spec's statelessness invariants.

import type { BrowserContext, CDPConnection, ProxyConfig, Target } from "./types.js";

type TargetType = Target["type"];
const ALLOWED_TARGET_TYPES: ReadonlySet<TargetType> = new Set([
  "page",
  "background_page",
  "service_worker",
  "worker",
  "iframe",
  "other",
]);
function coerceTargetType(t: string | undefined): TargetType {
  if (t && ALLOWED_TARGET_TYPES.has(t as TargetType)) return t as TargetType;
  return "other";
}

/**
 * Target.createBrowserContext — creates an isolated cookie-jar / storage
 * partition (incognito-equivalent). Used for parallel bench probes that
 * must not see each other's cookies.
 *
 * Proxy is per-context only when Chrome was launched with `--proxy-server=
 * per-context` (the v7 default, see chrome.ts:buildChromeArgs). Proxy auth
 * (username/password) is satisfied by `fetch_continue_with_auth` on the
 * first `Fetch.requestPaused` event — NOT by this call.
 */
export async function createBrowserContext(
  conn: CDPConnection,
  opts?: { proxy?: ProxyConfig; disposeOnDetach?: boolean },
): Promise<BrowserContext> {
  const params: Record<string, unknown> = {
    disposeOnDetach: opts?.disposeOnDetach ?? true,
  };
  if (opts?.proxy?.server) {
    params.proxyServer = opts.proxy.server;
    if (opts.proxy.bypassList) params.proxyBypassList = opts.proxy.bypassList;
  }
  const result = await conn.call<typeof params, { browserContextId: string }>(
    "Target.createBrowserContext",
    params,
  );
  return {
    cdp: conn,
    browserContextId: result.browserContextId,
    proxyServer: opts?.proxy?.server,
    proxyBypassList: opts?.proxy?.bypassList,
  };
}

/**
 * Target.disposeBrowserContext — frees the context and any targets in it.
 */
export async function disposeBrowserContext(ctx: BrowserContext): Promise<void> {
  await ctx.cdp.call("Target.disposeBrowserContext", { browserContextId: ctx.browserContextId });
}

/**
 * Target.createTarget — opens a new tab. If `browserContextId` is omitted,
 * the tab lives in the default (shared-cookies) context. Composes
 * Target.attachToTarget {flatten:true} so the returned Target carries the
 * sessionId you thread through every subsequent call.
 */
export async function createTarget(
  conn: CDPConnection,
  url: string,
  opts?: {
    browserContextId?: string;
    width?: number;
    height?: number;
    newWindow?: boolean;
    background?: boolean;
  },
): Promise<Target> {
  const params: Record<string, unknown> = { url };
  if (opts?.browserContextId) params.browserContextId = opts.browserContextId;
  if (opts?.width) params.width = opts.width;
  if (opts?.height) params.height = opts.height;
  if (opts?.newWindow !== undefined) params.newWindow = opts.newWindow;
  if (opts?.background !== undefined) params.background = opts.background;
  const { targetId } = await conn.call<typeof params, { targetId: string }>("Target.createTarget", params);
  // Attach with flat session multiplexing — every subsequent call carries
  // the sessionId, no nested ws connection.
  const { sessionId } = await conn.call<{ targetId: string; flatten: boolean }, { sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  // Discover target type by enumeration (Target.getTargetInfo is also fine
  // but getTargets is cheap and gives us the full row).
  let type: TargetType = "page";
  try {
    const info = await conn.call<{ targetId: string }, { targetInfo: { type: string } }>(
      "Target.getTargetInfo",
      { targetId },
    );
    type = coerceTargetType(info.targetInfo?.type);
  } catch {
    // default to "page"
  }
  return {
    cdp: conn,
    browserContextId: opts?.browserContextId,
    targetId,
    sessionId,
    type,
  };
}

/**
 * Target.attachToTarget — attach to an already-existing target (e.g.
 * discovered via Target.getTargets) with flat-session multiplexing.
 */
export async function attachToTarget(conn: CDPConnection, targetId: string): Promise<Target> {
  const { sessionId } = await conn.call<{ targetId: string; flatten: boolean }, { sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  let type: TargetType = "page";
  let browserContextId: string | undefined;
  try {
    const info = await conn.call<{ targetId: string }, { targetInfo: { type: string; browserContextId?: string } }>(
      "Target.getTargetInfo",
      { targetId },
    );
    type = coerceTargetType(info.targetInfo?.type);
    browserContextId = info.targetInfo?.browserContextId;
  } catch {
    // default
  }
  return { cdp: conn, browserContextId, targetId, sessionId, type };
}

/**
 * Target.detachFromTarget — releases the sessionId but keeps the tab alive.
 */
export async function detachFromTarget(target: Target): Promise<void> {
  await target.cdp.call("Target.detachFromTarget", { sessionId: target.sessionId });
}

/**
 * Target.closeTarget — closes the tab.
 */
export async function closeTarget(target: Target): Promise<void> {
  await target.cdp.call("Target.closeTarget", { targetId: target.targetId });
}

/**
 * Target.getTargets — enumerate every target the browser knows about.
 */
export async function listTargets(
  conn: CDPConnection,
): Promise<Array<{ targetId: string; type: string; title: string; url: string; browserContextId?: string }>> {
  const result = await conn.call<unknown, { targetInfos: Array<{ targetId: string; type: string; title: string; url: string; browserContextId?: string }> }>(
    "Target.getTargets",
  );
  return result.targetInfos ?? [];
}
