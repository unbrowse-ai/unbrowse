import { describe, expect, it } from "bun:test";
import type { BrowseSession } from "../src/api/browse-session.js";
import { buildSnapResponse } from "../src/api/browse-session.js";

// Truth-telling regression (in-thread dogfood 2026-05-16): unbrowse_go to
// https://www.reddit.com/r/singularity/ left the tab parked on Chrome's
// incognito placeholder. unbrowse_eval confirmed the REAL location:
//   window.location.href === "chrome://newtab/" (protocol "chrome:",
//   document.title "New Incognito tab", readyState "complete").
// broker.getCurrentUrl therefore returned the concrete non-http string
// "chrome://newtab/". buildSnapResponse line 706-708 does
//   currentUrl.startsWith("http") ? currentUrl : session.url
// so a concrete-but-non-http observed location is MASKED by session.url
// (the requested reddit URL), and the landed_domain_mismatch detector
// (gated on the same startsWith("http")) is skipped. The agent is told
// current_url === reddit with no mismatch, while the tab is actually on
// chrome://newtab/. This defeats the very purpose of the d4922212
// current_url field (let the agent detect tab drift).
//
// The fix must distinguish "unknown / pre-navigation" (null, "",
// "about:blank") — the existing tested fallback, preserved — from a
// CONCRETE observed non-http location (chrome://, chrome-error://,
// view-source:, data:, file:, etc.) which is real evidence the tab is
// NOT on the requested page. For the concrete case the substrate must
// tell the truth: surface the observed location as current_url and fire
// landed_domain_mismatch. Generic structural rule (non-empty, not
// http(s), not about:blank) — NOT a string match on "newtab" / "New
// Incognito tab" (that would be the banned literal-phrase prescription).
//
// Pure-helper test over the exported buildSnapResponse (the actual code
// path the snap route uses), same pattern as browse-snap-current-url.

const redditSession: BrowseSession = {
  sessionId: "sess-ph-1",
  tabId: "tab-ph-1",
  url: "https://www.reddit.com/r/singularity/",
  harActive: true,
  domain: "reddit.com",
};

describe("buildSnapResponse placeholder-location honesty", () => {
  it("does NOT mask a concrete non-http location (chrome://newtab/) with the requested url", () => {
    const response = buildSnapResponse({
      snapshot: '[e0] RootWebArea "New Incognito tab"',
      session: redditSession,
      currentUrl: "chrome://newtab/",
    });

    // The bug: current_url came back as the requested reddit URL,
    // current_domain reddit.com, no mismatch. Post-fix the substrate
    // tells the truth about the observed location.
    expect(response.current_url).not.toBe("https://www.reddit.com/r/singularity/");
    expect(response.current_url).toBe("chrome://newtab/");
    // observed (chrome placeholder) != expected (reddit.com) — the agent
    // must get the drift signal it would get for an http off-host land.
    expect(response.landed_domain_mismatch).toBe(true);
    expect(response.expected_domain).toBe("reddit.com");
  });

  it("regression guard: currentUrl null still falls back to session.url, no mismatch (tested contract preserved)", () => {
    const response = buildSnapResponse({
      snapshot: "<empty>",
      session: redditSession,
      currentUrl: null,
    });
    expect(response.current_url).toBe("https://www.reddit.com/r/singularity/");
    expect(response.landed_domain_mismatch).toBeUndefined();
  });

  it("regression guard: currentUrl about:blank still falls back to session.url, no mismatch (pre-nav)", () => {
    const response = buildSnapResponse({
      snapshot: "x",
      session: redditSession,
      currentUrl: "about:blank",
    });
    expect(response.current_url).toBe("https://www.reddit.com/r/singularity/");
    expect(response.landed_domain_mismatch).toBeUndefined();
  });

  it("regression guard: empty-string currentUrl still falls back to session.url, no mismatch (unknown)", () => {
    const response = buildSnapResponse({
      snapshot: "x",
      session: redditSession,
      currentUrl: "",
    });
    expect(response.current_url).toBe("https://www.reddit.com/r/singularity/");
    expect(response.landed_domain_mismatch).toBeUndefined();
  });

  it("generic: any concrete non-http, non-about:blank location is surfaced + flagged (not a chrome-only rule)", () => {
    for (const loc of ["chrome-error://chromewebdata/", "view-source:https://www.reddit.com/r/singularity/", "data:text/html,hi"]) {
      const r = buildSnapResponse({ snapshot: "x", session: redditSession, currentUrl: loc });
      expect(r.current_url).toBe(loc);
      expect(r.landed_domain_mismatch).toBe(true);
      expect(r.expected_domain).toBe("reddit.com");
    }
  });

  it("regression guard: a real http off-host land still flags mismatch (existing d4922212 behavior intact)", () => {
    const r = buildSnapResponse({
      snapshot: "[e0] link 'Open Library'",
      session: redditSession,
      currentUrl: "https://openlibrary.org/search?q=dune",
    });
    expect(r.current_url).toBe("https://openlibrary.org/search?q=dune");
    expect(r.landed_domain_mismatch).toBe(true);
    expect(r.expected_domain).toBe("reddit.com");
  });

  it("regression guard: on-target http land has no mismatch (existing behavior intact)", () => {
    const r = buildSnapResponse({
      snapshot: "[e0] feed",
      session: redditSession,
      currentUrl: "https://www.reddit.com/r/singularity/",
    });
    expect(r.current_url).toBe("https://www.reddit.com/r/singularity/");
    expect(r.landed_domain_mismatch).toBeUndefined();
  });
});
