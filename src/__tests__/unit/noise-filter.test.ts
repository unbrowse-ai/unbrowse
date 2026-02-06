/**
 * Unit tests for noise-filter.ts
 *
 * Tests isNoiseEndpoint() with various signal combinations:
 * slam-dunk patterns, path-based scoring, request body scoring,
 * response scoring, real API pass-through, and edge cases.
 *
 * Scoring model reference:
 *   - If any single signal >= 0.9: finalScore = maxSignal
 *   - Otherwise: finalScore = pathScore*0.5 + requestScore*0.3 + responseScore*0.2
 *   - Noise threshold: 0.6
 *
 * This means:
 *   - Path keywords (tracking/analytics/ads/marketing/tag-manager) score 1.0 -> always noise
 *   - Config keywords score 0.7 path -> weighted 0.35 alone, need other signals
 *   - Health paths score 0.8 path -> weighted 0.40 alone, need other signals
 *   - Asset paths score 0.7 path -> weighted 0.35 alone, need other signals
 *   - Request signals alone (max 0.8) -> weighted 0.24, not enough
 *   - Multiple moderate signals can combine to exceed threshold
 */

import { describe, it, expect } from "bun:test";
import { isNoiseEndpoint, NoiseCheckInput } from "../../noise-filter.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a NoiseCheckInput with sensible defaults. */
function makeInput(overrides: Partial<NoiseCheckInput> = {}): NoiseCheckInput {
  return {
    url: "https://example.com/api/data",
    method: "GET",
    path: "/api/data",
    responseStatus: 200,
    ...overrides,
  };
}

// ── Slam-dunk patterns ──────────────────────────────────────────────────

describe("isNoiseEndpoint", () => {
  describe("slam-dunk patterns (immediate noise, bypass scoring)", () => {
    it("detects /tracking/ path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/v1/tracking/events" }))).toBe(true);
    });

    it("detects /sgtm/ path (server-side GTM)", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/sgtm/collect" }))).toBe(true);
    });

    it("detects /beacon path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/api/beacon" }))).toBe(true);
    });

    it("detects /pixel path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/pixel" }))).toBe(true);
    });

    it("detects /~partytown/ path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/~partytown/0.9.1/debug.js" }))).toBe(true);
    });

    it("detects /telemetry/ path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/telemetry/v2/send" }))).toBe(true);
    });

    it("detects /client_configs path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/client_configs" }))).toBe(true);
    });

    it("detects /client-configs path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/client-configs" }))).toBe(true);
    });

    it("detects /data-layer path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/data-layer" }))).toBe(true);
    });

    it("detects /datalayer path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/datalayer/push" }))).toBe(true);
    });

    it("detects /feature-flags path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/feature-flags" }))).toBe(true);
    });

    it("detects /feature_flags path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/feature_flags" }))).toBe(true);
    });

    it("is case-insensitive for slam-dunk patterns", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/TRACKING/Events" }))).toBe(true);
      expect(isNoiseEndpoint(makeInput({ path: "/Pixel" }))).toBe(true);
    });
  });

  // ── Bot detection ───────────────────────────────────────────────────────

  describe("bot detection (POST to /js/)", () => {
    it("detects POST to /js/ as noise", () => {
      expect(isNoiseEndpoint(makeInput({ method: "POST", path: "/js/" }))).toBe(true);
    });

    it("detects POST to /js (no trailing slash) as noise", () => {
      expect(isNoiseEndpoint(makeInput({ method: "POST", path: "/js" }))).toBe(true);
    });

    it("does not flag GET to /js/ as noise", () => {
      expect(isNoiseEndpoint(makeInput({ method: "GET", path: "/js/" }))).toBe(false);
    });
  });

  // ── High-confidence path keywords (score 1.0 -> always noise) ─────────

  describe("high-confidence path keywords (pathScore = 1.0)", () => {
    it("detects analytics paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/v1/analytics/pageview" }))).toBe(true);
    });

    it("detects _analytics paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/_analytics/events" }))).toBe(true);
    });

    it("detects event-tracking paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/event-tracking/submit" }))).toBe(true);
    });

    it("detects pageview paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/pageview" }))).toBe(true);
    });

    it("detects impression paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/impression/log" }))).toBe(true);
    });

    it("detects /collect path (tracking keyword)", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/collect" }))).toBe(true);
    });

    it("detects /metrics path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/metrics/send" }))).toBe(true);
    });

    it("detects /diagnostic path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/diagnostic/report" }))).toBe(true);
    });

    it("detects /logging path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/logging/events" }))).toBe(true);
    });

    it("detects gtm paths (tag manager keyword)", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/gtm/event" }))).toBe(true);
    });

    it("detects tag-manager paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/tag-manager/collect" }))).toBe(true);
    });

    it("detects marketing/attribution paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/attribution/track" }))).toBe(true);
    });

    it("detects conversion paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/conversion/log" }))).toBe(true);
    });

    it("detects campaign_event paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/campaign_event/submit" }))).toBe(true);
    });

    it("detects ad-related paths (pagead)", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/pagead/conversion" }))).toBe(true);
    });

    it("detects adserver paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/adserver/deliver" }))).toBe(true);
    });

    it("detects ad-event paths", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/ad-event/click" }))).toBe(true);
    });

    it("is case-insensitive for path keywords", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/ANALYTICS/data" }))).toBe(true);
      expect(isNoiseEndpoint(makeInput({ path: "/Metrics/push" }))).toBe(true);
    });
  });

  // ── Moderate-confidence path scores (need combined signals) ───────────

  describe("moderate-confidence path scores (alone not enough)", () => {
    describe("health/heartbeat paths (pathScore = 0.8)", () => {
      it("/health alone does NOT cross noise threshold (0.8*0.5 = 0.40)", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/health" }))).toBe(false);
      });

      it("/healthz alone does NOT cross noise threshold", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/healthz" }))).toBe(false);
      });

      it("/ping alone does NOT cross noise threshold", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/ping" }))).toBe(false);
      });

      it("/heartbeat alone does NOT cross noise threshold", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/heartbeat" }))).toBe(false);
      });

      it("/ready alone does NOT cross noise threshold", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/ready" }))).toBe(false);
      });

      it("/alive alone does NOT cross noise threshold", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/alive" }))).toBe(false);
      });

      it("/health/ (trailing slash) is recognized as health path", () => {
        // pathScore = 0.8 (exact match with trailing slash), still 0.40 weighted alone
        expect(isNoiseEndpoint(makeInput({ path: "/health/" }))).toBe(false);
      });

      it("/health-check does NOT match health paths (non-exact)", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/health-check" }))).toBe(false);
      });

      it("health path + POST with tiny response crosses threshold", () => {
        // pathScore=0.8, requestScore=0.8 (POST + responseSize < 50)
        // weighted: 0.8*0.5 + 0.8*0.3 + 0*0.2 = 0.40 + 0.24 = 0.64 >= 0.6
        expect(isNoiseEndpoint(makeInput({
          method: "POST",
          path: "/health",
          responseStatus: 200,
          responseSize: 5,
          responseBodyText: "ok",
        }))).toBe(true);
      });
    });

    describe("config/feature-flags paths (pathScore = 0.7)", () => {
      it("/experiments alone does NOT cross noise threshold (0.7*0.5 = 0.35)", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/experiments/active" }))).toBe(false);
      });

      it("/client-config alone does NOT cross noise threshold", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/client-config/v2" }))).toBe(false);
      });

      it("config path + config response keys crosses threshold", () => {
        // pathScore=0.7, responseScore=0.6 (config response keys)
        // weighted: 0.7*0.5 + 0*0.3 + 0.6*0.2 = 0.35 + 0.12 = 0.47 < 0.6
        // Still not enough! Need more signals.
        const configBody = JSON.stringify({ features: { dark_mode: true } });
        expect(isNoiseEndpoint(makeInput({
          path: "/experiments/active",
          responseStatus: 200,
          responseBodyText: configBody,
          responseSize: configBody.length,
        }))).toBe(false);
      });

      it("config path + POST with tiny response crosses threshold", () => {
        // pathScore=0.7, requestScore=0.8 (POST + responseSize<50)
        // weighted: 0.7*0.5 + 0.8*0.3 + 0*0.2 = 0.35 + 0.24 = 0.59 < 0.6
        // Still not enough by 0.01! Add trivial response for response signal.
        expect(isNoiseEndpoint(makeInput({
          method: "POST",
          path: "/experiments/active",
          responseStatus: 200,
          responseSize: 5,
          responseBodyText: '{"ok":true}',
        }))).toBe(true);  // 0.35 + 0.24 + 0.5*0.2 = 0.35 + 0.24 + 0.10 = 0.69
      });
    });

    describe("asset-related paths (pathScore = 0.7)", () => {
      it("PlatformAssets alone does NOT cross noise threshold", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/PlatformAssets/icons/logo.svg" }))).toBe(false);
      });

      it("static-assets alone does NOT cross noise threshold", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/static-assets/bundle.js" }))).toBe(false);
      });
    });

    describe("version-pinned library paths (pathScore = 0.6)", () => {
      it("versioned non-API path alone does NOT cross noise threshold (0.6*0.5 = 0.30)", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/libs/1.2.3/bundle.js" }))).toBe(false);
      });

      it("does not flag versioned paths under /api/", () => {
        expect(isNoiseEndpoint(makeInput({ path: "/api/v1/1.2.3/resource" }))).toBe(false);
      });

      it("versioned path + POST with tiny response crosses threshold", () => {
        // pathScore=0.6, requestScore=0.8 (POST + tiny response)
        // weighted: 0.6*0.5 + 0.8*0.3 + 0*0.2 = 0.30 + 0.24 = 0.54
        // Need response signal too.
        expect(isNoiseEndpoint(makeInput({
          method: "POST",
          path: "/libs/1.2.3/submit",
          responseStatus: 200,
          responseSize: 2,
          responseBodyText: '{}',
        }))).toBe(true);  // 0.30 + 0.24 + 0.5*0.2 = 0.30 + 0.24 + 0.10 = 0.64
      });
    });
  });

  // ── Real API path detection (should NOT be noise) ─────────────────────

  describe("real API paths (should pass through)", () => {
    it("passes /api/v1/users", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/api/v1/users" }))).toBe(false);
    });

    it("passes /graphql", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/graphql" }))).toBe(false);
    });

    it("passes /api/products/123", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/api/products/123" }))).toBe(false);
    });

    it("passes /v2/orders", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/v2/orders" }))).toBe(false);
    });

    it("passes standard REST endpoint GET /users", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/users" }))).toBe(false);
    });

    it("passes POST /api/login", () => {
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/api/login",
        responseStatus: 200,
      }))).toBe(false);
    });

    it("passes /api/search", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/api/search" }))).toBe(false);
    });

    it("passes POST /api/users with real data and large response", () => {
      const body = JSON.stringify({
        name: "John Doe",
        email: "john@example.com",
        role: "admin",
      });
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/api/v1/users",
        requestContentType: "application/json",
        requestBodyText: body,
        responseStatus: 201,
        responseSize: 500,
        responseBodyText: JSON.stringify({ id: 1, name: "John Doe", email: "john@example.com" }),
      }))).toBe(false);
    });
  });

  // ── Request body scoring ──────────────────────────────────────────────

  describe("request body scoring", () => {
    it("POST with tiny response on neutral path is NOT noise alone", () => {
      // pathScore=0, requestScore=0.8 (POST + responseSize<50)
      // weighted: 0*0.5 + 0.8*0.3 + 0*0.2 = 0.24 < 0.6
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/api/events",
        responseStatus: 200,
        responseSize: 10,
        responseBodyText: "ok",
      }))).toBe(false);
    });

    it("POST with text/plain on noise keyword path flags as noise", () => {
      // pathScore=1.0 (collect is tracking keyword) -> maxSignal 1.0 >= 0.9
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/collect/events",
        requestContentType: "text/plain",
        responseStatus: 204,
      }))).toBe(true);
    });

    it("analytics payload (3+ keys) on noise keyword path flags as noise", () => {
      const body = JSON.stringify({
        event: "page_view",
        event_name: "page_load",
        event_type: "pageview",
        timestamp: 1672531200,
        client_id: "abc-123",
        page_url: "https://example.com",
      });
      // pathScore=1.0 (collect is tracking keyword) -> immediate noise
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/collect/v2",
        requestBodyText: body,
        responseStatus: 200,
        responseSize: 5,
        responseBodyText: '{"ok":true}',
      }))).toBe(true);
    });

    it("analytics payload alone on neutral path is NOT noise", () => {
      const body = JSON.stringify({
        event: "page_view",
        event_name: "page_load",
        event_type: "pageview",
        timestamp: 1672531200,
        client_id: "abc-123",
        page_url: "https://example.com",
      });
      // pathScore=0, requestScore=0.8 (3+ analytics keys)
      // weighted: 0 + 0.8*0.3 + 0*0.2 = 0.24 < 0.6
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/api/v1/ingest",
        requestBodyText: body,
        responseStatus: 200,
        responseSize: 500,
        responseBodyText: JSON.stringify({ received: true }),
      }))).toBe(false);
    });

    it("array body on noise path flags as noise", () => {
      const body = JSON.stringify([
        { event: "click", ts: 12345 },
        { event: "scroll", ts: 12346 },
      ]);
      // pathScore=1.0 (metrics is tracking keyword)
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/metrics/batch",
        requestBodyText: body,
        responseStatus: 200,
        responseSize: 5,
        responseBodyText: '{"ok":true}',
      }))).toBe(true);
    });

    it("batch keys (events/batch/etc.) on noise path flags as noise", () => {
      const body = JSON.stringify({
        batch: [
          { event: "click" },
          { event: "scroll" },
        ],
      });
      // pathScore=1.0 (logging is tracking keyword)
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/logging/batch",
        requestBodyText: body,
        responseStatus: 200,
        responseSize: 5,
        responseBodyText: '{"ok":true}',
      }))).toBe(true);
    });

    it("handles non-JSON request body gracefully", () => {
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/api/upload",
        requestContentType: "multipart/form-data",
        requestBodyText: "not-json-content",
        responseStatus: 200,
        responseSize: 200,
        responseBodyText: JSON.stringify({ uploaded: true }),
      }))).toBe(false);
    });

    it("handles empty request body string gracefully", () => {
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/api/data",
        requestBodyText: "",
        responseStatus: 200,
        responseSize: 200,
        responseBodyText: JSON.stringify({ data: "real" }),
      }))).toBe(false);
    });
  });

  // ── Response scoring ──────────────────────────────────────────────────

  describe("response scoring", () => {
    it("trivial ack response combined with noise path flags as noise", () => {
      // pathScore=1.0 (logging is tracking keyword) -> immediate noise
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/v1/logging/send",
        responseStatus: 200,
        responseBodyText: '{"ok":true}',
      }))).toBe(true);
    });

    it("empty JSON response combined with noise path flags as noise", () => {
      // pathScore=1.0 (metrics is tracking keyword)
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/metrics/push",
        responseStatus: 200,
        responseBodyText: "{}",
      }))).toBe(true);
    });

    it("detects Lottie animation JSON as noise (responseScore = 1.0)", () => {
      const lottieBody = JSON.stringify({
        layers: [],
        assets: [],
        fr: 30,
        op: 120,
        ip: 0,
        v: "5.5.2",
        w: 500,
        h: 500,
      });
      // responseScore=1.0 (4+ Lottie keys) -> maxSignal 1.0 >= 0.9 -> noise
      expect(isNoiseEndpoint(makeInput({
        path: "/animations/loading.json",
        responseStatus: 200,
        responseBodyText: lottieBody,
        responseSize: lottieBody.length,
      }))).toBe(true);
    });

    it("config response keys alone on neutral path NOT enough", () => {
      // pathScore=0, responseScore=0.6 (config keys)
      // weighted: 0 + 0 + 0.6*0.2 = 0.12 < 0.6
      const configBody = JSON.stringify({
        features: { dark_mode: true, beta: false },
        flags: { new_ui: true },
      });
      expect(isNoiseEndpoint(makeInput({
        path: "/api/settings",
        responseStatus: 200,
        responseBodyText: configBody,
        responseSize: configBody.length,
      }))).toBe(false);
    });

    it("config response keys on config keyword path", () => {
      // pathScore=0.7 (experiments is config keyword), responseScore=0.6
      // weighted: 0.7*0.5 + 0*0.3 + 0.6*0.2 = 0.35 + 0.12 = 0.47 < 0.6
      const configBody = JSON.stringify({
        features: { dark_mode: true },
        flags: { new_ui: true },
      });
      expect(isNoiseEndpoint(makeInput({
        path: "/experiments/all",
        responseStatus: 200,
        responseBodyText: configBody,
        responseSize: configBody.length,
      }))).toBe(false);
    });

    it("large flat config blob (50+ keys) alone on neutral path NOT noise", () => {
      // pathScore=0, responseScore=0.5 (50+ keys)
      // weighted: 0 + 0 + 0.5*0.2 = 0.10 < 0.6
      const manyKeys: Record<string, boolean> = {};
      for (let i = 0; i < 55; i++) {
        manyKeys[`flag_${i}`] = true;
      }
      const body = JSON.stringify(manyKeys);
      expect(isNoiseEndpoint(makeInput({
        path: "/api/config",
        responseStatus: 200,
        responseBodyText: body,
        responseSize: body.length,
      }))).toBe(false);
    });

    it("trivial response alone on neutral path NOT noise (0.5*0.2 = 0.10)", () => {
      expect(isNoiseEndpoint(makeInput({
        path: "/api/data",
        responseStatus: 200,
        responseBodyText: '{"ok":true}',
        responseSize: 11,
      }))).toBe(false);
    });

    it("passes real JSON API responses through", () => {
      const apiBody = JSON.stringify({
        users: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
        total: 2,
        page: 1,
      });
      expect(isNoiseEndpoint(makeInput({
        path: "/api/v1/users",
        responseStatus: 200,
        responseBodyText: apiBody,
        responseSize: apiBody.length,
      }))).toBe(false);
    });

    it("handles non-JSON response body gracefully", () => {
      expect(isNoiseEndpoint(makeInput({
        path: "/api/data",
        responseStatus: 200,
        responseBodyText: "<html>Hello</html>",
        responseSize: 18,
      }))).toBe(false);
    });

    it("handles undefined responseBodyText without crashing", () => {
      expect(isNoiseEndpoint(makeInput({
        path: "/api/data",
        responseStatus: 200,
      }))).toBe(false);
    });
  });

  // ── Combined signals crossing threshold ───────────────────────────────

  describe("combined signals crossing threshold", () => {
    it("health path + POST with tiny response + trivial body = noise", () => {
      // pathScore=0.8, requestScore=0.8 (POST + responseSize<50), responseScore=0.5 (trivial)
      // weighted: 0.8*0.5 + 0.8*0.3 + 0.5*0.2 = 0.40 + 0.24 + 0.10 = 0.74
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/health",
        responseStatus: 200,
        responseSize: 5,
        responseBodyText: '{"ok":true}',
      }))).toBe(true);
    });

    it("config path + POST tiny + trivial response = noise", () => {
      // pathScore=0.7 (experiments), requestScore=0.8 (POST + tiny), responseScore=0.5 (trivial)
      // weighted: 0.7*0.5 + 0.8*0.3 + 0.5*0.2 = 0.35 + 0.24 + 0.10 = 0.69
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/experiments/set",
        responseStatus: 200,
        responseSize: 2,
        responseBodyText: '{}',
      }))).toBe(true);
    });

    it("asset path + POST tiny + trivial response = noise", () => {
      // pathScore=0.7 (static-assets), requestScore=0.8, responseScore=0.5
      // weighted: 0.35 + 0.24 + 0.10 = 0.69
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/static-assets/upload",
        responseStatus: 200,
        responseSize: 2,
        responseBodyText: '{}',
      }))).toBe(true);
    });

    it("versioned path + POST tiny + trivial response = noise", () => {
      // pathScore=0.6 (version-pinned), requestScore=0.8, responseScore=0.5
      // weighted: 0.30 + 0.24 + 0.10 = 0.64
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/libs/1.2.3/submit",
        responseStatus: 200,
        responseSize: 2,
        responseBodyText: '{}',
      }))).toBe(true);
    });
  });

  // ── Mixed signals ─────────────────────────────────────────────────────

  describe("mixed signals", () => {
    it("API-like path with strong analytics request body does NOT flag", () => {
      // pathScore=0, requestScore=0.8 (9 analytics keys)
      // weighted: 0 + 0.8*0.3 + 0*0.2 = 0.24 < 0.6
      const body = JSON.stringify({
        event: "purchase",
        event_name: "checkout_complete",
        event_type: "conversion",
        timestamp: 1672531200,
        client_id: "abc-123",
        session_id: "sess-456",
        page_url: "https://example.com/checkout",
        referrer: "https://google.com",
        user_agent: "Mozilla/5.0",
      });
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/api/v1/ingest",
        requestBodyText: body,
        responseStatus: 200,
        responseSize: 200,
        responseBodyText: JSON.stringify({ received: true }),
      }))).toBe(false);
    });

    it("tracking keyword path overrides large API-like response", () => {
      // pathScore=1.0 (collect is tracking keyword) -> maxSignal >= 0.9 -> 1.0
      const apiBody = JSON.stringify({
        users: [{ id: 1, name: "Alice" }],
        total: 1,
      });
      expect(isNoiseEndpoint(makeInput({
        path: "/collect/v2",
        responseStatus: 200,
        responseBodyText: apiBody,
        responseSize: apiBody.length,
      }))).toBe(true);
    });

    it("beacon POST pattern on neutral path is NOT noise alone", () => {
      // pathScore=0, requestScore=0.8 (POST + tiny + text/plain -> max(0.8, 0.6) = 0.8)
      // responseScore=0.5 (trivial empty string)
      // weighted: 0 + 0.8*0.3 + 0.5*0.2 = 0.24 + 0.10 = 0.34 < 0.6
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/v1/send",
        requestContentType: "text/plain",
        responseStatus: 204,
        responseSize: 0,
        responseBodyText: "",
      }))).toBe(false);
    });

    it("beacon POST on moderate path becomes noise with combined signals", () => {
      // pathScore=0.8 (health path), requestScore=0.8 (POST + tiny + text/plain)
      // responseScore=0.5 (trivial empty)
      // weighted: 0.8*0.5 + 0.8*0.3 + 0.5*0.2 = 0.40 + 0.24 + 0.10 = 0.74
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/ping",
        requestContentType: "text/plain",
        responseStatus: 204,
        responseSize: 0,
        responseBodyText: "",
      }))).toBe(true);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty path", () => {
      expect(isNoiseEndpoint(makeInput({ path: "" }))).toBe(false);
    });

    it("handles root path /", () => {
      expect(isNoiseEndpoint(makeInput({ path: "/" }))).toBe(false);
    });

    it("handles minimal input (only required fields)", () => {
      expect(isNoiseEndpoint({
        url: "https://example.com/",
        method: "GET",
        path: "/",
        responseStatus: 200,
      })).toBe(false);
    });

    it("handles very long paths without crashing", () => {
      const longPath = "/api" + "/segment".repeat(100);
      expect(() => isNoiseEndpoint(makeInput({ path: longPath }))).not.toThrow();
    });

    it("handles null-ish response body text (string 'null')", () => {
      // "null" is in TRIVIAL_RESPONSES -> responseScore=0.5
      // But alone on neutral path: 0*0.5 + 0*0.3 + 0.5*0.2 = 0.10 < 0.6
      expect(isNoiseEndpoint(makeInput({
        path: "/api/data",
        responseStatus: 200,
        responseBodyText: "null",
      }))).toBe(false);
    });

    it("all TRIVIAL_RESPONSES are recognized on noise path", () => {
      const trivials = [
        "", "null", "{}", "true", "false", "1", "0",
        '"ok"', '{"ok":true}', '{"ok":1}',
        '{"success":true}', '{"status":"ok"}',
        '{"status":"success"}',
      ];
      for (const body of trivials) {
        // pathScore=1.0 (metrics is tracking keyword) -> maxSignal >= 0.9 -> noise
        const result = isNoiseEndpoint(makeInput({
          method: "POST",
          path: "/metrics/report",
          responseStatus: 200,
          responseBodyText: body,
          responseSize: body.length,
        }));
        expect(result).toBe(true);
      }
    });

    it("all batch keys are recognized as request body signals", () => {
      const batchKeys = ["events", "batch", "messages", "logs", "entries"];
      for (const key of batchKeys) {
        const body = JSON.stringify({ [key]: [{ id: 1 }] });
        // pathScore=1.0 (metrics is tracking keyword) -> maxSignal >= 0.9 -> noise
        const result = isNoiseEndpoint(makeInput({
          method: "POST",
          path: "/metrics/send",
          requestBodyText: body,
          responseStatus: 200,
          responseSize: 5,
          responseBodyText: "ok",
        }));
        expect(result).toBe(true);
      }
    });
  });

  // ── Weighted scoring behavior ─────────────────────────────────────────

  describe("weighted scoring behavior", () => {
    it("single strong signal (>= 0.9) dominates: pathScore=1.0 alone is noise", () => {
      // pathScore=1.0 (analytics keyword) -> maxSignal 1.0 >= 0.9 -> finalScore=1.0
      expect(isNoiseEndpoint(makeInput({
        method: "GET",
        path: "/analytics/data",
        responseStatus: 200,
        responseSize: 5000,
        responseBodyText: JSON.stringify({ users: [{ id: 1 }] }),
      }))).toBe(true);
    });

    it("weak response signal alone does not flag noise", () => {
      // pathScore=0, requestScore=0, responseScore=0.6 (config keys)
      // weighted: 0 + 0 + 0.6*0.2 = 0.12 < 0.6
      const configBody = JSON.stringify({ features: { a: true } });
      expect(isNoiseEndpoint(makeInput({
        path: "/api/settings",
        responseStatus: 200,
        responseBodyText: configBody,
        responseSize: configBody.length,
      }))).toBe(false);
    });

    it("moderate path + moderate request + moderate response can cross threshold", () => {
      // pathScore=0.8 (health), requestScore=0.8 (POST+tiny), responseScore=0.5 (trivial)
      // weighted: 0.40 + 0.24 + 0.10 = 0.74 >= 0.6
      expect(isNoiseEndpoint(makeInput({
        method: "POST",
        path: "/heartbeat",
        responseStatus: 200,
        responseSize: 2,
        responseBodyText: '{}',
      }))).toBe(true);
    });

    it("two moderate signals without third may not cross threshold", () => {
      // pathScore=0.6 (versioned), requestScore=0 (GET), responseScore=0.5 (trivial)
      // weighted: 0.6*0.5 + 0 + 0.5*0.2 = 0.30 + 0.10 = 0.40 < 0.6
      expect(isNoiseEndpoint(makeInput({
        method: "GET",
        path: "/libs/1.2.3/data",
        responseStatus: 200,
        responseSize: 2,
        responseBodyText: '{}',
      }))).toBe(false);
    });
  });
});
