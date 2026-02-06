/**
 * Generalized noise endpoint filter — detects tracking, analytics,
 * telemetry, asset manifests, and other non-API traffic using
 * multi-signal scoring instead of hardcoded paths.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface NoiseCheckInput {
  url: string;
  method: string;
  path: string;
  requestContentType?: string;
  requestBodyText?: string;
  responseStatus: number;
  responseContentType?: string;
  responseSize?: number;
  responseBodyText?: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const NOISE_THRESHOLD = 0.6;

/** Universally-noise path patterns — skip immediately without scoring. */
const SLAM_DUNK_PATTERNS = [
  "/tracking/", "/sgtm/", "/beacon", "/pixel",
  "/~partytown/", "/telemetry/",
  "/client_configs", "/client-configs",
  "/data-layer", "/datalayer",
  "/feature-flags", "/feature_flags",
];

/** Path segment keywords that indicate tracking/analytics/noise. */
const TRACKING_KEYWORDS = [
  "tracking", "telemetry", "beacon", "pixel", "collect",
  "logging", "metrics", "diagnostic",
];

const ANALYTICS_KEYWORDS = [
  "analytics", "_analytics", "event-tracking", "event_tracking",
  "pageview", "impression",
];

const TAG_MANAGER_KEYWORDS = [
  "sgtm", "gtm", "data-layer", "datalayer",
  "tag-manager", "tagmanager",
];

const MARKETING_KEYWORDS = [
  "marketing", "campaign_event", "attribution",
  "conversion", "realtimeconversion",
];

const AD_KEYWORDS = [
  "pagead", "adserver", "ad-event",
];

const CONFIG_KEYWORDS = [
  "client_configs", "client-config", "client-configs",
  "feature-flags", "feature_flags", "experiments",
];

const HEALTH_PATHS = [
  "/health", "/healthz", "/ping", "/heartbeat", "/ready", "/alive",
];

/** Request body keys that fingerprint analytics payloads. */
const ANALYTICS_BODY_KEYS = [
  "event", "event_name", "event_type", "action", "category",
  "label", "timestamp", "ts", "client_id", "session_id",
  "page_url", "referrer", "user_agent",
];

/** Keys that indicate an event-batch payload. */
const BATCH_KEYS = ["events", "batch", "messages", "logs", "entries"];

/** Keys that identify Lottie animation JSON. */
const LOTTIE_KEYS = ["layers", "assets", "fr", "op", "ip", "v"];

/** Keys that identify config/feature-flag dumps. */
const CONFIG_RESPONSE_KEYS = ["features", "flags", "experiments", "settings", "rollouts"];

/** Trivial response bodies that indicate fire-and-forget acks. */
const TRIVIAL_RESPONSES = [
  "", "null", "{}", "true", "false", "1", "0",
  '"ok"', '{"ok":true}', '{"ok":1}',
  '{"success":true}', '{"status":"ok"}',
  '{"status":"success"}',
];

// ── Scoring Functions ────────────────────────────────────────────────────

function computePathScore(path: string, method: string): number {
  const lp = path.toLowerCase();

  // Check tracking keywords in path segments
  if (TRACKING_KEYWORDS.some((k) => lp.includes(k))) return 1.0;
  if (ANALYTICS_KEYWORDS.some((k) => lp.includes(k))) return 1.0;
  if (TAG_MANAGER_KEYWORDS.some((k) => lp.includes(k))) return 1.0;
  if (MARKETING_KEYWORDS.some((k) => lp.includes(k))) return 1.0;
  if (AD_KEYWORDS.some((k) => lp.includes(k))) return 1.0;

  // Config/feature flags — slightly lower confidence
  if (CONFIG_KEYWORDS.some((k) => lp.includes(k))) return 0.7;

  // Health/heartbeat endpoints — exact path match
  if (HEALTH_PATHS.some((p) => lp === p || lp === p + "/")) return 0.8;

  // Bot detection: POST to /js/ path
  if (method === "POST" && (lp === "/js/" || lp === "/js")) return 0.9;

  // Version-pinned library paths (e.g., /~partytown/0.9.1/, /v3.2.1/)
  if (/\/\d+\.\d+\.\d+\//.test(lp) && !lp.includes("/api/")) return 0.6;

  // Asset-related paths with "PlatformAssets", "static-assets" etc.
  if (/platform.?assets|static.?assets/i.test(lp)) return 0.7;

  return 0;
}

function computeRequestScore(input: NoiseCheckInput): number {
  const { method, requestContentType, requestBodyText, responseSize } = input;

  let maxScore = 0;

  // Fire-and-forget beacon: POST with tiny response
  if (method === "POST" && responseSize !== undefined && responseSize < 50) {
    maxScore = Math.max(maxScore, 0.8);
  }

  // sendBeacon uses text/plain POST
  if (method === "POST" && requestContentType?.includes("text/plain")) {
    maxScore = Math.max(maxScore, 0.6);
  }

  if (requestBodyText) {
    try {
      const body = JSON.parse(requestBodyText);

      // Event batch payload (array body or batch keys)
      if (Array.isArray(body)) {
        maxScore = Math.max(maxScore, 0.7);
      } else if (typeof body === "object" && body !== null) {
        const keys = Object.keys(body);

        // Batch container keys
        if (BATCH_KEYS.some((k) => keys.includes(k))) {
          maxScore = Math.max(maxScore, 0.7);
        }

        // Analytics payload fingerprint: 3+ matching keys
        const analyticsMatches = keys.filter((k) =>
          ANALYTICS_BODY_KEYS.includes(k.toLowerCase())
        ).length;
        if (analyticsMatches >= 3) {
          maxScore = Math.max(maxScore, 0.8);
        }
      }
    } catch {
      // Not JSON — ignore
    }
  }

  return Math.min(maxScore, 1.0);
}

function computeResponseScore(input: NoiseCheckInput): number {
  const { responseBodyText, responseSize } = input;

  if (!responseBodyText) return 0;

  let maxScore = 0;

  // Trivial ack response
  const trimmed = responseBodyText.trim();
  if (TRIVIAL_RESPONSES.includes(trimmed)) {
    maxScore = Math.max(maxScore, 0.5);
  }

  // Very small response (under 20 bytes) that isn't empty
  if (responseSize !== undefined && responseSize > 0 && responseSize < 20) {
    maxScore = Math.max(maxScore, 0.4);
  }

  try {
    const body = JSON.parse(trimmed);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const keys = Object.keys(body);

      // Lottie animation detection
      const lottieMatches = LOTTIE_KEYS.filter((k) => keys.includes(k)).length;
      if (lottieMatches >= 4) {
        maxScore = Math.max(maxScore, 1.0);
      }

      // Config dump detection: has config-specific top-level keys
      if (CONFIG_RESPONSE_KEYS.some((k) => keys.includes(k))) {
        maxScore = Math.max(maxScore, 0.6);
      }

      // Flat config blob: 50+ top-level keys (unlikely to be API response)
      if (keys.length >= 50) {
        maxScore = Math.max(maxScore, 0.5);
      }
    }
  } catch {
    // Not JSON — ignore
  }

  return Math.min(maxScore, 1.0);
}

// ── Main Export ──────────────────────────────────────────────────────────

/**
 * Determine if a HAR entry is noise (tracking, analytics, telemetry,
 * asset manifest, config dump) rather than a useful API endpoint.
 *
 * Uses multi-signal scoring across path patterns, request shape,
 * and response shape. Returns true if the entry should be filtered out.
 */
export function isNoiseEndpoint(input: NoiseCheckInput): boolean {
  const lp = input.path.toLowerCase();

  // Slam-dunk patterns: universally noise, skip immediately
  if (SLAM_DUNK_PATTERNS.some((p) => lp.includes(p))) return true;

  // Bot detection: POST to bare /js/ path
  if (input.method === "POST" && (lp === "/js/" || lp === "/js")) return true;

  // Multi-signal scoring
  const pathScore = computePathScore(input.path, input.method);
  const requestScore = computeRequestScore(input);
  const responseScore = computeResponseScore(input);

  // If any single signal is very confident (≥ 0.9), allow it to dominate
  const maxSignal = Math.max(pathScore, requestScore, responseScore);

  const finalScore =
    maxSignal >= 0.9
      ? maxSignal  // Very high confidence from any signal is enough
      : pathScore * 0.5 +
        requestScore * 0.3 +
        responseScore * 0.2;

  return finalScore >= NOISE_THRESHOLD;
}
