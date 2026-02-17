/**
 * Telemetry Filter Tests
 *
 * Validates that the TrafficFilter correctly identifies and filters
 * analytics, tracking, ads, and telemetry endpoints across vendors.
 *
 * Tests real-world patterns observed from browser-use target sites:
 * eBay, Instacart, DoorDash, Indeed, Glassdoor, Expedia, Zillow, Yelp, Medium.
 */

import { describe, it, expect } from "bun:test";
import { TrafficFilter } from "../src/har-parser.js";

const tf = new TrafficFilter();

// ---------------------------------------------------------------------------
// Telemetry path detection
// ---------------------------------------------------------------------------

describe("isTelemetryPath", () => {
  describe("stem-based detection", () => {
    it("catches tracking stems", () => {
      expect(tf.isTelemetryPath("/marketingtracking/v1/sync")).toBe(true);
      expect(tf.isTelemetryPath("/trackobserve")).toBe(true);
      expect(tf.isTelemetryPath("/eventTracking")).toBe(true);
    });

    it("catches metric stems", () => {
      expect(tf.isTelemetryPath("/reportMetrics")).toBe(true);
      expect(tf.isTelemetryPath("/v1/metrics")).toBe(true);
    });

    it("catches beacon stems", () => {
      expect(tf.isTelemetryPath("/beacon/submit")).toBe(true);
    });

    it("catches collect stems", () => {
      expect(tf.isTelemetryPath("/sensorcollect")).toBe(true);
      expect(tf.isTelemetryPath("/collector/v1")).toBe(true);
    });

    it("catches analytics stems", () => {
      expect(tf.isTelemetryPath("/analytics/event")).toBe(true);
    });

    it("catches diagnostics stems", () => {
      expect(tf.isTelemetryPath("/diagnostics")).toBe(true);
    });

    it("catches pageview stems", () => {
      expect(tf.isTelemetryPath("/v1/pageview")).toBe(true);
      expect(tf.isTelemetryPath("/pageview/submit")).toBe(true);
    });

    it("catches ingest stems", () => {
      expect(tf.isTelemetryPath("/rise/ingest")).toBe(true);
      expect(tf.isTelemetryPath("/data/ingest")).toBe(true);
    });

    it("catches pixel stems", () => {
      expect(tf.isTelemetryPath("/blueberry/v1/ads/identity/pixelurls")).toBe(true);
      expect(tf.isTelemetryPath("/pixel.gif")).toBe(true);
    });

    it("catches csm stems", () => {
      expect(tf.isTelemetryPath("/gh/gadget_csm")).toBe(true);
      expect(tf.isTelemetryPath("/csm/report")).toBe(true);
    });

    it("catches impression stems", () => {
      expect(tf.isTelemetryPath("/impression/log")).toBe(true);
      expect(tf.isTelemetryPath("/impressionevents")).toBe(true);
    });
  });

  describe("exact segment detection", () => {
    it("catches exact telemetry segments", () => {
      expect(tf.isTelemetryPath("/rum")).toBe(true);
      expect(tf.isTelemetryPath("/beacon")).toBe(true);
      expect(tf.isTelemetryPath("/error")).toBe(true);
      expect(tf.isTelemetryPath("/generate_204")).toBe(true);
      expect(tf.isTelemetryPath("/log_event")).toBe(true);
      expect(tf.isTelemetryPath("/uedata")).toBe(true);
    });

    it("catches first-party analytics exact segments", () => {
      expect(tf.isTelemetryPath("/events")).toBe(true);
      expect(tf.isTelemetryPath("/visits")).toBe(true);
      expect(tf.isTelemetryPath("/ahoy")).toBe(true);
      expect(tf.isTelemetryPath("/jsdata")).toBe(true);
      expect(tf.isTelemetryPath("/sodar")).toBe(true);
      expect(tf.isTelemetryPath("/roverimp")).toBe(true);
    });

    it("catches exact segments nested in paths", () => {
      expect(tf.isTelemetryPath("/ahoy/visits")).toBe(true);
      expect(tf.isTelemetryPath("/v1/events/submit")).toBe(true);
    });
  });

  describe("structural pattern detection", () => {
    it("catches single-letter paths (tracking beacons)", () => {
      expect(tf.isTelemetryPath("/p")).toBe(true);
      expect(tf.isTelemetryPath("/b")).toBe(true);
    });

    it("catches batch tracking endpoints", () => {
      expect(tf.isTelemetryPath("/v2/b")).toBe(true);
      expect(tf.isTelemetryPath("/v1/b")).toBe(true);
    });

    it("catches ad-related paths", () => {
      expect(tf.isTelemetryPath("/ads/identity")).toBe(true);
      expect(tf.isTelemetryPath("/ad/click")).toBe(true);
    });

    it("catches Branch.io session endpoints", () => {
      expect(tf.isTelemetryPath("/v1/open")).toBe(true);
      expect(tf.isTelemetryPath("/v2/open")).toBe(true);
    });

    it("catches Amazon CSM patterns", () => {
      expect(tf.isTelemetryPath("/123/batch/456/OE/")).toBe(true);
      expect(tf.isTelemetryPath("/1/events/com.example.foo")).toBe(true);
    });
  });

  describe("real-world tracking endpoints (should be filtered)", () => {
    it("filters Instacart tracking", () => {
      expect(tf.isTelemetryPath("/v1/pageview")).toBe(true);
      expect(tf.isTelemetryPath("/ahoy/visits")).toBe(true);
      expect(tf.isTelemetryPath("/events")).toBe(true);
      expect(tf.isTelemetryPath("/p")).toBe(true);
      expect(tf.isTelemetryPath("/rise/ingest")).toBe(true);
      expect(tf.isTelemetryPath("/v1/open")).toBe(true);
      expect(tf.isTelemetryPath("/v2/b")).toBe(true);
    });

    it("filters eBay tracking", () => {
      expect(tf.isTelemetryPath("/jsdata")).toBe(true);
      expect(tf.isTelemetryPath("/blueberry/v1/ads/identity/pixelurls")).toBe(true);
      expect(tf.isTelemetryPath("/marketingtracking/v1/sync")).toBe(true);
      expect(tf.isTelemetryPath("/roverimp/123/456")).toBe(true);
      expect(tf.isTelemetryPath("/getconfig/sodar")).toBe(true);
      expect(tf.isTelemetryPath("/gh/gadget_csm")).toBe(true);
    });
  });

  describe("legitimate API paths (should NOT be filtered)", () => {
    it("passes GraphQL endpoints", () => {
      expect(tf.isTelemetryPath("/graphql")).toBe(false);
      expect(tf.isTelemetryPath("/graphql?operationName=Search")).toBe(false);
    });

    it("passes search endpoints", () => {
      expect(tf.isTelemetryPath("/api/v1/search")).toBe(false);
      expect(tf.isTelemetryPath("/sch/i.html")).toBe(false);
      expect(tf.isTelemetryPath("/sch/ajax/autocomplete")).toBe(false);
      expect(tf.isTelemetryPath("/store/search")).toBe(false);
    });

    it("passes RPC endpoints", () => {
      expect(tf.isTelemetryPath("/rpc/instacart.rise.config.v1.configservice/clientconfig")).toBe(false);
    });

    it("passes config endpoints", () => {
      expect(tf.isTelemetryPath("/config/com/123.json")).toBe(false);
    });

    it("passes user/resource endpoints", () => {
      expect(tf.isTelemetryPath("/user")).toBe(false);
      expect(tf.isTelemetryPath("/gh/useracquisition")).toBe(false);
      expect(tf.isTelemetryPath("/api/products/123")).toBe(false);
    });

    it("passes multi-segment API paths", () => {
      expect(tf.isTelemetryPath("/api/v2/listings")).toBe(false);
      expect(tf.isTelemetryPath("/v1/hotels/search")).toBe(false);
      expect(tf.isTelemetryPath("/marketplace/skills")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Domain-level filtering
// ---------------------------------------------------------------------------

describe("isSkippedDomain", () => {
  it("skips known analytics domains", () => {
    expect(tf.isSkippedDomain("www.google-analytics.com")).toBe(true);
    expect(tf.isSkippedDomain("api.amplitude.com")).toBe(true);
    expect(tf.isSkippedDomain("cdn.segment.com")).toBe(true);
    expect(tf.isSkippedDomain("api.mixpanel.com")).toBe(true);
  });

  it("skips telemetry subdomains (with trailing hyphen/dot)", () => {
    expect(tf.isSkippedDomain("metrics-prod.example.com")).toBe(true);
    expect(tf.isSkippedDomain("beacon-us.example.com")).toBe(true);
    expect(tf.isSkippedDomain("telemetry-prod.example.com")).toBe(true);
    expect(tf.isSkippedDomain("rum-na.example.com")).toBe(true);
    expect(tf.isSkippedDomain("fls-na.amazon.com")).toBe(true);
  });

  it("does not skip target domains", () => {
    expect(tf.isSkippedDomain("www.ebay.com")).toBe(false);
    expect(tf.isSkippedDomain("www.instacart.com")).toBe(false);
    expect(tf.isSkippedDomain("api.example.com")).toBe(false);
  });
});
