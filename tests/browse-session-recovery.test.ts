import { describe, expect, it } from "bun:test";
import {
  extractBrowseFailureMessage,
  getOrCreateBrowseSession,
  isBrowseSessionLive,
  isRecoverableBrowseFailure,
  type BrowseSession,
  type BrowseSessionClient,
  withRecoveredBrowseSession,
} from "../src/api/browse-session.js";

function makeClient(overrides: Partial<BrowseSessionClient> = {}): BrowseSessionClient {
  return {
    start: async () => {},
    newTab: async () => "fresh-tab",
    harStart: async () => {},
    closeTab: async () => {},
    discoverTabs: async () => [{ id: "fresh-tab", url: "about:blank" }],
    getCurrentUrl: async () => "about:blank",
    ...overrides,
  };
}

describe("browse session recovery", () => {
  it("extracts nested Kuri failure payloads", () => {
    expect(extractBrowseFailureMessage({ result: { error: "CDP command failed" } })).toBe("CDP command failed");
    expect(isRecoverableBrowseFailure({ error: "Transport closed by peer" })).toBe(true);
    expect(isRecoverableBrowseFailure({ result: { message: "No such target" } })).toBe(true);
    expect(isRecoverableBrowseFailure({ ok: true })).toBe(false);
  });

  it("treats registered tabs with real urls as live", async () => {
    const session: BrowseSession = { tabId: "tab-1", url: "https://example.com", harActive: true, domain: "example.com" };
    const live = await isBrowseSessionLive(session, makeClient({
      discoverTabs: async () => [{ id: "tab-1", url: "https://example.com" }],
      getCurrentUrl: async () => "https://example.com",
    }));
    expect(live).toBe(true);
  });

  it("drops dead stored tabs before creating a fresh browse session", async () => {
    const sessions = new Map<string, BrowseSession>();
    sessions.set("default", { tabId: "dead-tab", url: "https://example.com", harActive: true, domain: "example.com" });

    const closed: string[] = [];
    const injected: string[] = [];
    const session = await getOrCreateBrowseSession(
      sessions,
      makeClient({
        newTab: async () => "fresh-tab",
        closeTab: async (tabId) => { closed.push(tabId); },
        discoverTabs: async () => [{ id: "fresh-tab", url: "about:blank" }],
        getCurrentUrl: async (tabId) => tabId === "fresh-tab" ? "about:blank" : "",
      }),
      async (tabId) => { injected.push(tabId); },
    );

    expect(closed).toEqual(["dead-tab"]);
    expect(injected).toEqual(["fresh-tab"]);
    expect(session.tabId).toBe("fresh-tab");
    expect(sessions.get("default")?.tabId).toBe("fresh-tab");
  });

  it("adopts an existing same-domain tab before falling back to about:blank", async () => {
    const sessions = new Map<string, BrowseSession>();
    sessions.set("default", { tabId: "dead-tab", url: "https://www.mandai.com/old", harActive: true, domain: "mandai.com" });

    const injected: string[] = [];
    const session = await getOrCreateBrowseSession(
      sessions,
      makeClient({
        closeTab: async () => {},
        discoverTabs: async () => [
          { id: "other-tab", url: "https://example.com" },
          { id: "mandai-live", url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html" },
        ],
        getCurrentUrl: async (tabId) => tabId === "mandai-live" ? "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html" : "",
        newTab: async () => "fresh-tab",
      }),
      async (tabId) => { injected.push(tabId); },
    );

    expect(session.tabId).toBe("mandai-live");
    expect(session.domain).toBe("mandai.com");
    expect(injected).toEqual(["mandai-live"]);
  });

  it("retries once after a recoverable CDP failure result", async () => {
    const sessions = new Map<string, BrowseSession>();
    const created: string[] = [];
    const closed: string[] = [];
    const runs: string[] = [];

    const result = await withRecoveredBrowseSession(
      sessions,
      makeClient({
        newTab: async () => {
          const next = `tab-${created.length + 1}`;
          created.push(next);
          return next;
        },
        closeTab: async (tabId) => { closed.push(tabId); },
        discoverTabs: async () => created.map((id) => ({ id, url: "about:blank" })),
        getCurrentUrl: async (tabId) => `https://example.com/${tabId}`,
      }),
      async () => {},
      async (session) => {
        runs.push(session.tabId);
        return runs.length === 1 ? { error: "CDP command failed" } : { ok: true };
      },
      (value) => isRecoverableBrowseFailure(value),
    );

    expect(result.recovered).toBe(true);
    expect(runs).toEqual(["tab-1", "tab-2"]);
    expect(closed).toEqual(["tab-1"]);
    expect(result.result).toEqual({ ok: true });
  });
});
