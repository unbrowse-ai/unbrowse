"use client";

import {
  FIRST_TOUCH_COOKIE,
  parseAcquisitionContext,
  readNamedCookieValue,
  VISITOR_ID_COOKIE,
} from "@/lib/acquisition/context";
import { resolveApiUrl } from "@/lib/runtime-api-url";

const VISITOR_KEY = "unbrowse:web:visitor-id";
const SESSION_KEY = "unbrowse:web:session-id";
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateStorageId(storage: Storage, key: string): string {
  const existing = storage.getItem(key);
  if (existing) return existing;
  const created = createId();
  storage.setItem(key, created);
  return created;
}

function canTrack(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function getCookieValue(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return readNamedCookieValue(document.cookie, name);
}

function persistVisitorCookie(visitorId: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${VISITOR_ID_COOKIE}=${visitorId}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE}; SameSite=Lax`;
}

function getDeviceContext(): Record<string, unknown> {
  if (!canTrack()) return {};
  const w = window.screen?.width;
  const h = window.screen?.height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const ua = navigator.userAgent;

  let device_type: "mobile" | "tablet" | "desktop" = "desktop";
  if (/Mobile|Android.*Mobile|iPhone|iPod/.test(ua)) device_type = "mobile";
  else if (/iPad|Android(?!.*Mobile)|Tablet/.test(ua) || (touch && vw >= 600 && vw <= 1024)) device_type = "tablet";
  else if (touch && vw < 600) device_type = "mobile";

  let browser = "unknown";
  if (/Edg\//.test(ua)) browser = "edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "opera";
  else if (/Chrome\//.test(ua)) browser = "chrome";
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = "safari";
  else if (/Firefox\//.test(ua)) browser = "firefox";

  const nav = navigator as unknown as Record<string, unknown>;
  const conn = nav.connection as Record<string, unknown> | undefined;

  return {
    device_type,
    screen_width: w,
    screen_height: h,
    viewport_width: vw,
    viewport_height: vh,
    touch_support: touch,
    browser,
    user_agent: ua.slice(0, 200),
    language: navigator.language,
    ...(conn?.effectiveType ? { connection_type: conn.effectiveType } : {}),
  };
}

function getUtmProperties(): Record<string, string> {
  if (!canTrack()) return {};
  const search = new URLSearchParams(window.location.search);
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
  const entries = keys
    .map((key) => [key, search.get(key)] as const)
    .filter((entry): entry is readonly [typeof keys[number], string] => !!entry[1]);
  return Object.fromEntries(entries);
}

export function getOrCreateWebVisitorId(): string | null {
  if (!canTrack()) return null;
  try {
    const cookieVisitor = getCookieValue(VISITOR_ID_COOKIE);
    if (cookieVisitor) {
      window.localStorage.setItem(VISITOR_KEY, cookieVisitor);
      return cookieVisitor;
    }
    const created = getOrCreateStorageId(window.localStorage, VISITOR_KEY);
    persistVisitorCookie(created);
    return created;
  } catch {
    return null;
  }
}

export function getOrCreateWebSessionId(): string | null {
  if (!canTrack()) return null;
  try {
    return getOrCreateStorageId(window.sessionStorage, SESSION_KEY);
  } catch {
    return null;
  }
}

function injectLandingToken(baseCommand: string, token: string): string {
  const prefix = `UNBROWSE_LANDING_TOKEN='${token}' `;
  if (baseCommand.includes("| bash")) {
    return baseCommand.replace("| bash", `| env ${prefix}bash`);
  }
  if (baseCommand.includes("./setup")) {
    return baseCommand.replace("./setup", `${prefix}./setup`);
  }
  if (baseCommand.includes("unbrowse setup")) {
    return baseCommand.replace("unbrowse setup", `${prefix}unbrowse setup`);
  }
  return `${prefix}${baseCommand}`;
}

function getLandingContext(): Record<string, unknown> | undefined {
  if (typeof document === "undefined") return undefined;
  const root = document.getElementById("landing-page-root");
  if (!root) return undefined;
  const variantId = root.getAttribute("data-landing-variant-id");
  const icp = root.getAttribute("data-landing-icp");
  const experimentId = root.getAttribute("data-landing-experiment-id");
  const context: Record<string, unknown> = {};
  if (variantId) context.variant_id = variantId;
  if (icp) context.icp = icp;
  if (experimentId) context.experiment_id = experimentId;
  return Object.keys(context).length > 0 ? context : undefined;
}

function getAcquisitionContext(): Record<string, unknown> | undefined {
  const cookieValue = getCookieValue(FIRST_TOUCH_COOKIE);
  const parsed = parseAcquisitionContext(cookieValue);
  return parsed && Object.keys(parsed).length > 0 ? { ...parsed } : undefined;
}

export async function getTokenizedInstallCommand(
  baseCommand: string,
  experimentId?: string,
  variantId?: string,
): Promise<{ command: string; tokenized: boolean }> {
  if (!canTrack() || !experimentId || !variantId) {
    return { command: baseCommand, tokenized: false };
  }

  const visitorId = getOrCreateWebVisitorId();
  const sessionId = getOrCreateWebSessionId();
  if (!visitorId || !sessionId) {
    return { command: baseCommand, tokenized: false };
  }

  try {
    const response = await fetch(`${resolveApiUrl()}/v1/landing/homepage/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        experiment_id: experimentId,
        variant_id: variantId,
        visitor_id: visitorId,
        session_id: sessionId,
      }),
    });
    if (!response.ok) return { command: baseCommand, tokenized: false };
    const payload = await response.json() as { token?: string };
    if (!payload.token) return { command: baseCommand, tokenized: false };
    return {
      command: injectLandingToken(baseCommand, payload.token),
      tokenized: true,
    };
  } catch {
    return { command: baseCommand, tokenized: false };
  }
}

export function trackWebEvent(
  name: string,
  properties?: Record<string, unknown>,
  context?: { experimentId?: string; variantId?: string },
): void {
  if (!canTrack()) return;

  try {
    const visitorId = getOrCreateWebVisitorId();
    const sessionId = getOrCreateWebSessionId();
    if (!visitorId || !sessionId) return;

    const landingContext = getLandingContext();
    const mergedContext = {
      ...(getAcquisitionContext() ?? {}),
      ...(landingContext ?? {}),
      ...(context?.experimentId ? { experiment_id: context.experimentId } : {}),
      ...(context?.variantId ? { variant_id: context.variantId } : {}),
    };
    const experimentId =
      context?.experimentId ??
      (typeof landingContext?.experiment_id === "string" ? landingContext.experiment_id : undefined);
    const variantId =
      context?.variantId ??
      (typeof landingContext?.variant_id === "string" ? landingContext.variant_id : undefined);

    const payload = JSON.stringify({
      visitor_id: visitorId,
      session_id: sessionId,
      name,
      experiment_id: experimentId,
      variant_id: variantId,
      path: `${window.location.pathname}${window.location.search}`,
      referrer: document.referrer || null,
      created_at: new Date().toISOString(),
      properties: {
        ...getDeviceContext(),
        ...getUtmProperties(),
        ...mergedContext,
        ...(properties ?? {}),
      },
    });
    const url = `${resolveApiUrl()}/v1/telemetry/web`;
    const sameOrigin = new URL(url, window.location.origin).origin === window.location.origin;

    if (sameOrigin && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }

    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
      mode: "cors",
    }).catch(() => {});
  } catch {
    // Telemetry should never break the UI.
  }
}
