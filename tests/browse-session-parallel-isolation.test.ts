// Parallel-agent tab isolation: resolveRequestedBrowseSession must NOT silently
// pick the most-recently-created session when multiple are live. Wave-1 of
// /unbrowse-self-build (2026-05-15) surfaced this as `cross-session-tab-
// contamination`: an amazon `unbrowse_go` session ended up snap'd on
// beatsaver because both sub-agents called snap without session_id and the
// platform returned `live[live.length - 1]`.
//
// Contract:
//   - When zero live sessions, throw "no_active_session".
//   - When one live session, auto-resolve to it (sequential CLI flow preserved).
//   - When more than one live session, throw "session_id_required" so the
//     caller (or its prompt template) is forced to be explicit.
//
// Real code paths only — no mocks of resolveRequestedBrowseSession itself.

import { describe, expect, it } from "bun:test";
import {
  BrowseSessionError,
  createRegisteredBrowseSession,
  resolveRequestedBrowseSession,
  type BrowseSession,
  type BrowseSessionClient,
} from "../src/api/browse-session.js";

function makeClient(tabIds: string[]): BrowseSessionClient {
  return {
    start: async () => {},
    newTab: async () => tabIds.shift() ?? "fallback-tab",
    harStart: async () => {},
    closeTab: async () => {},
    // discoverTabs reports all tabIds as live with their navigated url so
    // isBrowseSessionLive returns true for every registered session.
    discoverTabs: async () =>
      registeredForTest.map((s) => ({ id: s.tabId, url: s.url })),
    getCurrentUrl: async (tabId: string) => {
      const session = registeredForTest.find((s) => s.tabId === tabId);
      return session?.url ?? "about:blank";
    },
  };
}

// Module-level so makeClient's closures can see what got registered.
let registeredForTest: BrowseSession[] = [];

describe("parallel browse session isolation", () => {
  it("auto-resolves when exactly one live session exists (sequential flow preserved)", async () => {
    const sessions = new Map<string, BrowseSession>();
    registeredForTest = [];
    const client = makeClient([]);

    const s1 = createRegisteredBrowseSession(sessions, {
      sessionId: "sess-amazon",
      tabId: "tab-amazon",
      url: "https://www.amazon.com/s?k=usb-c",
      domain: "amazon.com",
      harActive: true,
    });
    registeredForTest.push(s1);

    const resolved = await resolveRequestedBrowseSession(sessions, client, undefined);
    expect(resolved.sessionId).toBe("sess-amazon");
  });

  it("throws session_id_required when more than one live session exists and no session_id given", async () => {
    const sessions = new Map<string, BrowseSession>();
    registeredForTest = [];
    const client = makeClient([]);

    const s1 = createRegisteredBrowseSession(sessions, {
      sessionId: "sess-amazon",
      tabId: "tab-amazon",
      url: "https://www.amazon.com/s?k=usb-c",
      domain: "amazon.com",
      harActive: true,
    });
    const s2 = createRegisteredBrowseSession(sessions, {
      sessionId: "sess-beatsaver",
      tabId: "tab-beatsaver",
      url: "https://beatsaver.com/?q=camellia",
      domain: "beatsaver.com",
      harActive: true,
    });
    registeredForTest.push(s1, s2);

    let caught: unknown = null;
    try {
      await resolveRequestedBrowseSession(sessions, client, undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrowseSessionError);
    expect((caught as BrowseSessionError).code).toBe("session_id_required");
  });

  it("returns the requested session when session_id is provided and live, regardless of how many others exist", async () => {
    const sessions = new Map<string, BrowseSession>();
    registeredForTest = [];
    const client = makeClient([]);

    for (let i = 0; i < 5; i++) {
      const s = createRegisteredBrowseSession(sessions, {
        sessionId: `sess-${i}`,
        tabId: `tab-${i}`,
        url: `https://example-${i}.com/page`,
        domain: `example-${i}.com`,
        harActive: true,
      });
      registeredForTest.push(s);
    }

    const target = await resolveRequestedBrowseSession(sessions, client, "sess-2");
    expect(target.sessionId).toBe("sess-2");
    expect(target.tabId).toBe("tab-2");
  });

  it("throws no_active_session when no sessions exist", async () => {
    const sessions = new Map<string, BrowseSession>();
    registeredForTest = [];
    const client = makeClient([]);

    let caught: unknown = null;
    try {
      await resolveRequestedBrowseSession(sessions, client, undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrowseSessionError);
    expect((caught as BrowseSessionError).code).toBe("no_active_session");
  });

  it("does NOT silently pick the most-recently-created session — wave-1 regression sentinel", async () => {
    // Reproduces wave-1-20260515 cross-session-tab-contamination: agent
    // creates amazon session FIRST, then beatsaver session, then calls
    // snap without session_id. platform must NOT return beatsaver. It
    // must throw so the caller knows to be explicit.
    const sessions = new Map<string, BrowseSession>();
    registeredForTest = [];
    const client = makeClient([]);

    const amazon = createRegisteredBrowseSession(sessions, {
      sessionId: "amazon-first",
      tabId: "tab-amazon",
      url: "https://www.amazon.com/s?k=usb-c+cable",
      domain: "amazon.com",
      harActive: true,
    });
    const beatsaver = createRegisteredBrowseSession(sessions, {
      sessionId: "beatsaver-last",
      tabId: "tab-beatsaver",
      url: "https://beatsaver.com/?q=camellia",
      domain: "beatsaver.com",
      harActive: true,
    });
    registeredForTest.push(amazon, beatsaver);

    let caught: BrowseSessionError | null = null;
    try {
      await resolveRequestedBrowseSession(sessions, client, undefined);
    } catch (err) {
      caught = err as BrowseSessionError;
    }
    // Pre-fix: this would have returned `beatsaver` silently. Post-fix:
    // it throws session_id_required and never returns either.
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("session_id_required");
  });
});
