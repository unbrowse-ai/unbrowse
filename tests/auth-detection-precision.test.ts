// Auth-detection precision tests.
//
// The bug: pre-2026-05-15 auth-wall detector tripped on any page with a
// "Log In" link in the navbar (CSS `a[href*="login"]` + regex `/log\s*in/i`
// over body innerText). Public pages like openlibrary.org/search?q=dune
// got classified as auth-walled and triggered the visible-Chrome-popup
// fallback, abandoning the headless capture. North-star violation:
// browser-open is failure mode, not feature.
//
// Test surface:
//   1. classifyAuthSignals decision function with explicit probe inputs
//   2. The gate-text regex inside AUTH_PROBE_JS, run against representative
//      page text fixtures

import { describe, expect, it } from "bun:test";
import {
  AUTH_PROBE_JS,
  classifyAuthSignals,
  type AuthProbeResult,
} from "../src/api/auth-detection";

describe("classifyAuthSignals", () => {
  it("returns required:false for a public page with no auth signals", () => {
    const probe: AuthProbeResult = {
      hasPasswordInput: false,
      hasGateText: false,
      url: "https://openlibrary.org/search?q=dune",
    };
    const result = classifyAuthSignals(probe);
    expect(result.required).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("returns required:true with password_input_present when a login form is visible", () => {
    const probe: AuthProbeResult = {
      hasPasswordInput: true,
      hasGateText: false,
      url: "https://x.com/i/flow/login",
    };
    const result = classifyAuthSignals(probe);
    expect(result.required).toBe(true);
    expect(result.reason).toBe("password_input_present");
  });

  it("returns required:true with gate_text_detected when gating copy is present", () => {
    const probe: AuthProbeResult = {
      hasPasswordInput: false,
      hasGateText: true,
      url: "https://example.com/private",
    };
    const result = classifyAuthSignals(probe);
    expect(result.required).toBe(true);
    expect(result.reason).toBe("gate_text_detected");
  });

  it("password input takes precedence over gate text when both fire", () => {
    const probe: AuthProbeResult = {
      hasPasswordInput: true,
      hasGateText: true,
      url: "https://example.com/login",
    };
    const result = classifyAuthSignals(probe);
    expect(result.required).toBe(true);
    expect(result.reason).toBe("password_input_present");
  });
});

// Extract the gate-text regex from AUTH_PROBE_JS by evaluating the probe
// string against a fixture DOM. We provide a minimal stubbed document and
// location so the probe runs end-to-end (no jsdom required).
function evalProbeWithBodyText(bodyText: string, hasPasswordInput = false): AuthProbeResult {
  const stubDocument = {
    querySelector(selector: string) {
      if (selector === 'input[type="password"]') return hasPasswordInput ? {} : null;
      return null;
    },
    body: { innerText: bodyText },
  };
  const stubLocation = { href: "https://example.com/test" };
  // The probe is `JSON.stringify({ ... })`; build a function that returns it
  // with document + location injected.
  const fn = new Function("document", "location", `return ${AUTH_PROBE_JS};`);
  const raw = fn(stubDocument, stubLocation);
  return JSON.parse(raw) as AuthProbeResult;
}

describe("AUTH_PROBE_JS gate-text regex", () => {
  it("does NOT match a mere 'Log In' link or 'Sign up' button in navbar", () => {
    // Approximates openlibrary, amazon, ebay homepage navbar copy.
    const bodyText = "Browse Subjects Authors Lists Collections Log In Sign Up Donate";
    const probe = evalProbeWithBodyText(bodyText);
    expect(probe.hasGateText).toBe(false);
    expect(probe.hasPasswordInput).toBe(false);
    expect(classifyAuthSignals(probe).required).toBe(false);
  });

  it("does NOT match a footer with 'Sign in to your account' as marketing copy", () => {
    const bodyText = "Featured books. Search results for dune. Sign in to your account for personalized recommendations.";
    const probe = evalProbeWithBodyText(bodyText);
    expect(probe.hasGateText).toBe(false);
  });

  it("matches 'Please sign in to continue'", () => {
    const probe = evalProbeWithBodyText("Please sign in to continue.");
    expect(probe.hasGateText).toBe(true);
    expect(classifyAuthSignals(probe).reason).toBe("gate_text_detected");
  });

  it("matches 'You must be logged in to view this page'", () => {
    const probe = evalProbeWithBodyText("You must be logged in to view this page.");
    expect(probe.hasGateText).toBe(true);
  });

  it("matches '401 Unauthorized'", () => {
    const probe = evalProbeWithBodyText("401 Unauthorized\n\nAccess to this resource on the server is denied.");
    expect(probe.hasGateText).toBe(true);
  });

  it("matches '403 Forbidden'", () => {
    const probe = evalProbeWithBodyText("403 Forbidden");
    expect(probe.hasGateText).toBe(true);
  });

  it("matches 'access denied' phrase", () => {
    const probe = evalProbeWithBodyText("Access denied. You do not have permission.");
    expect(probe.hasGateText).toBe(true);
  });

  it("flags hasPasswordInput when a password input is present, independent of body text", () => {
    const probe = evalProbeWithBodyText("Search results for dune", true);
    expect(probe.hasPasswordInput).toBe(true);
    expect(probe.hasGateText).toBe(false);
    expect(classifyAuthSignals(probe).required).toBe(true);
    expect(classifyAuthSignals(probe).reason).toBe("password_input_present");
  });
});
