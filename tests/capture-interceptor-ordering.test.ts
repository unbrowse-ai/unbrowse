/**
 * Regression test for GitHub issue #403: LinkedIn capture yields only 1 endpoint.
 *
 * Root cause: HAR recording, JS interceptor injection, and CDP network capture were
 * all set up AFTER the first `navigate:origin` call. LinkedIn fires Voyager GraphQL
 * API calls during the challenge/redirect page load — before recording was active —
 * so all of those requests were missed.
 *
 * Fix: capturePreflightSetup() must be called BEFORE any navigation occurs.
 * This function is pure and testable: it returns an ordered list of setup phases
 * that must all precede any "navigate" phase.
 */
import { describe, expect, it } from "bun:test";
import { getCaptureSetupOrder } from "../src/capture/index.js";

describe("captureSession interceptor ordering (issue #403)", () => {
  it("scriptInject phase must come before navigate:origin when cookies are present", () => {
    const phases = getCaptureSetupOrder({ hasCookies: true });
    const scriptInjectIdx = phases.indexOf("scriptInject");
    const harStartIdx = phases.indexOf("harStart");
    const cdpEnableIdx = phases.indexOf("cdpEnable");
    const navigateOriginIdx = phases.indexOf("navigate:origin");

    // All three setup phases must exist
    expect(scriptInjectIdx).toBeGreaterThanOrEqual(0);
    expect(harStartIdx).toBeGreaterThanOrEqual(0);
    expect(cdpEnableIdx).toBeGreaterThanOrEqual(0);
    expect(navigateOriginIdx).toBeGreaterThanOrEqual(0);

    // All setup phases must precede the first navigation
    expect(scriptInjectIdx).toBeLessThan(navigateOriginIdx);
    expect(harStartIdx).toBeLessThan(navigateOriginIdx);
    expect(cdpEnableIdx).toBeLessThan(navigateOriginIdx);
  });

  it("scriptInject phase must come before navigate even without cookies", () => {
    const phases = getCaptureSetupOrder({ hasCookies: false });
    const scriptInjectIdx = phases.indexOf("scriptInject");
    const harStartIdx = phases.indexOf("harStart");
    const cdpEnableIdx = phases.indexOf("cdpEnable");
    const navigateIdx = phases.indexOf("navigate");

    expect(scriptInjectIdx).toBeGreaterThanOrEqual(0);
    expect(harStartIdx).toBeGreaterThanOrEqual(0);
    expect(cdpEnableIdx).toBeGreaterThanOrEqual(0);
    expect(navigateIdx).toBeGreaterThanOrEqual(0);

    expect(scriptInjectIdx).toBeLessThan(navigateIdx);
    expect(harStartIdx).toBeLessThan(navigateIdx);
    expect(cdpEnableIdx).toBeLessThan(navigateIdx);
  });

  it("addInitScript phase must come before navigate:origin to survive LinkedIn redirect chain", () => {
    // addInitScript uses Page.addScriptToEvaluateOnNewDocument — runs before page JS
    // on EVERY navigation, surviving LinkedIn's challenge redirect chain.
    const phases = getCaptureSetupOrder({ hasCookies: true });
    const addInitIdx = phases.indexOf("addInitScript");
    const navigateOriginIdx = phases.indexOf("navigate:origin");

    expect(addInitIdx).toBeGreaterThanOrEqual(0);
    expect(addInitIdx).toBeLessThan(navigateOriginIdx);
  });
});
