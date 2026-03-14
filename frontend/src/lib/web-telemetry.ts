"use client";

import { resolveApiUrl } from "@/lib/runtime-api-url";
const VISITOR_KEY = "unbrowse:web:visitor-id";
const SESSION_KEY = "unbrowse:web:session-id";

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

export function trackWebEvent(name: string, properties?: Record<string, unknown>): void {
  if (!canTrack()) return;

  try {
    const visitorId = getOrCreateStorageId(window.localStorage, VISITOR_KEY);
    const sessionId = getOrCreateStorageId(window.sessionStorage, SESSION_KEY);
    const payload = JSON.stringify({
      visitor_id: visitorId,
      session_id: sessionId,
      name,
      path: `${window.location.pathname}${window.location.search}`,
      referrer: document.referrer || null,
      created_at: new Date().toISOString(),
      properties,
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
