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

function getVisitorId(): string {
  const cookieVisitorId = getCookieValue(VISITOR_ID_COOKIE);
  if (cookieVisitorId) {
    window.localStorage.setItem(VISITOR_KEY, cookieVisitorId);
    return cookieVisitorId;
  }

  const visitorId = getOrCreateStorageId(window.localStorage, VISITOR_KEY);
  persistVisitorCookie(visitorId);
  return visitorId;
}

export function trackWebEvent(name: string, properties?: Record<string, unknown>): void {
  if (!canTrack()) return;

  try {
    const visitorId = getVisitorId();
    const sessionId = getOrCreateStorageId(window.sessionStorage, SESSION_KEY);
    const payload = JSON.stringify({
      visitor_id: visitorId,
      session_id: sessionId,
      name,
      path: `${window.location.pathname}${window.location.search}`,
      referrer: document.referrer || null,
      created_at: new Date().toISOString(),
      properties: {
        ...getAcquisitionContext(),
        ...getLandingContext(),
        ...properties,
      },
    });
    const url = `${resolveApiUrl()}/v1/telemetry/web`;

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
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
