// Umami custom-event helper. The script tag in layout.tsx loads
// cloud.umami.is/script.js and exposes window.umami.track(name, data?).
// Wrap it so callers don't need to repeat the optional-chain dance and so
// non-browser / pre-load contexts no-op cleanly.

declare global {
  interface Window {
    umami?: {
      track: (eventName: string, eventData?: Record<string, unknown>) => void;
    };
  }
}

export function track(eventName: string, eventData?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    window.umami?.track(eventName, eventData);
  } catch {
    // Umami script may not have loaded yet (defer) or may be blocked by
    // user privacy tools. Silent fail — telemetry is best-effort.
  }
}
