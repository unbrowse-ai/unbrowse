"use client";

import { resolveApiUrl } from "@/lib/runtime-api-url";
const VISITOR_KEY = "unbrowse:web:visitor-id";
const SESSION_KEY = "unbrowse:web:session-id";
const VISITOR_COOKIE = "unbrowse_lp_visitor";

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

function readCookie(name: string): string | null {
  if (!canTrack()) return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
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
    const cookieVisitor = readCookie(VISITOR_COOKIE);
    if (cookieVisitor) {
      window.localStorage.setItem(VISITOR_KEY, cookieVisitor);
      return cookieVisitor;
    }
    return getOrCreateStorageId(window.localStorage, VISITOR_KEY);
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
    const payload = JSON.stringify({
      visitor_id: visitorId,
      session_id: sessionId,
      name,
      experiment_id: context?.experimentId,
      variant_id: context?.variantId,
      path: `${window.location.pathname}${window.location.search}`,
      referrer: document.referrer || null,
      created_at: new Date().toISOString(),
      properties: {
        ...getUtmProperties(),
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
