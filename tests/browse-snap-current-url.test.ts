import { describe, expect, it } from "bun:test";
import type { BrowseSession } from "../src/api/browse-session.js";
import { buildSnapResponse } from "../src/api/browse-session.js";

// Regression: unbrowse_snap response did not include the actual URL of the
// snapped tab. Agents reading the snapshot had no way to detect that the
// tab had landed on a different page than the one they opened (e.g. an
// e-commerce landing redirected to a captcha, or an unrelated tab was
// adopted under the same sessionId). The pure helper now surfaces the
// observed url + domain so the calling agent can judge.

const baseSession: BrowseSession = {
  sessionId: "sess-snap-1",
  tabId: "tab-snap-1",
  url: "https://www.amazon.com/s?k=usb-c+cable",
  harActive: true,
  domain: "amazon.com",
};

describe("buildSnapResponse", () => {
  it("returns snapshot + session_id + tab_id + observed current_url", () => {
    const response = buildSnapResponse({
      snapshot: "[e0] heading 'usb-c cable results'",
      session: baseSession,
      currentUrl: "https://www.amazon.com/s?k=usb-c+cable",
    });

    expect(response.snapshot).toBe("[e0] heading 'usb-c cable results'");
    expect(response.session_id).toBe("sess-snap-1");
    expect(response.tab_id).toBe("tab-snap-1");
    expect(response.current_url).toBe("https://www.amazon.com/s?k=usb-c+cable");
    expect(response.current_domain).toBe("amazon.com");
  });

  it("falls back to session.url when broker.getCurrentUrl returns null", () => {
    const response = buildSnapResponse({
      snapshot: "<empty>",
      session: baseSession,
      currentUrl: null,
    });

    expect(response.current_url).toBe("https://www.amazon.com/s?k=usb-c+cable");
    expect(response.current_domain).toBe("amazon.com");
  });

  it("surfaces a landed_domain_mismatch signal when tab has drifted to a different host", () => {
    // The bug: opening amazon.com/s, but the tab is actually on openlibrary.org
    // (observed in worktree probe 2026-05-15). The agent gets the openlibrary
    // snapshot with no signal that this is not amazon.
    const response = buildSnapResponse({
      snapshot: "[e0] link 'Open Library logo'",
      session: { ...baseSession, url: "https://www.amazon.com/s?k=usb-c+cable", domain: "amazon.com" },
      currentUrl: "https://openlibrary.org/search?q=dune",
    });

    expect(response.current_url).toBe("https://openlibrary.org/search?q=dune");
    expect(response.current_domain).toBe("openlibrary.org");
    expect(response.landed_domain_mismatch).toBe(true);
    expect(response.expected_domain).toBe("amazon.com");
  });

  it("omits landed_domain_mismatch when domains agree (including www prefix differences)", () => {
    const response = buildSnapResponse({
      snapshot: "x",
      session: { ...baseSession, url: "https://amazon.com/s", domain: "amazon.com" },
      currentUrl: "https://www.amazon.com/s?k=usb-c+cable",
    });

    expect(response.landed_domain_mismatch).toBeUndefined();
  });

  it("omits landed_domain_mismatch when currentUrl is missing or non-http", () => {
    const nullCase = buildSnapResponse({
      snapshot: "x",
      session: baseSession,
      currentUrl: null,
    });
    expect(nullCase.landed_domain_mismatch).toBeUndefined();

    const blankCase = buildSnapResponse({
      snapshot: "x",
      session: baseSession,
      currentUrl: "about:blank",
    });
    expect(blankCase.landed_domain_mismatch).toBeUndefined();
  });
});
