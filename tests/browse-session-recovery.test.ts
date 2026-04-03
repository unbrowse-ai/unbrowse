import { describe, expect, it } from "bun:test";
import {
  BrowseSessionError,
  createRegisteredBrowseSession,
  extractBrowseFailureMessage,
  getOrCreateBrowseSession,
  isBrowseSessionLive,
  isRecoverableBrowseFailure,
  rebindBrowseSessionToMatchingTab,
  resetBrowseSession,
  resolveRequestedBrowseSession,
  type BrowseSession,
  type BrowseSessionClient,
  withSerializedRecoveredBrowseSession,
  withSerializedStrictBrowseSession,
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
    const session: BrowseSession = { sessionId: "sess-1", tabId: "tab-1", url: "https://example.com", harActive: true, domain: "example.com" };
    const live = await isBrowseSessionLive(session, makeClient({
      discoverTabs: async () => [{ id: "tab-1", url: "https://example.com" }],
      getCurrentUrl: async () => "https://example.com",
    }));
    expect(live).toBe(true);
  });

  it("keeps a session live across transient post-navigation URL read failures", async () => {
    const session: BrowseSession = { sessionId: "sess-1", tabId: "tab-1", url: "https://example.com/review", harActive: true, domain: "example.com" };
    let reads = 0;

    const live = await isBrowseSessionLive(session, makeClient({
      discoverTabs: async () => [{ id: "tab-1", url: "https://example.com/review" }],
      getCurrentUrl: async () => {
        reads += 1;
        if (reads === 1) throw { error: "Execution context was destroyed" };
        return "https://example.com/review";
      },
    }));

    expect(live).toBe(true);
  });

  it("rebinds liveness onto a same-path replacement tab when the tab id changes", async () => {
    const session: BrowseSession = {
      sessionId: "sess-1",
      tabId: "dead-tab",
      url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=old",
      harActive: true,
      domain: "mandai.com",
    };

    const live = await isBrowseSessionLive(session, makeClient({
      discoverTabs: async () => [
        { id: "replacement-tab", url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=new" },
      ],
      getCurrentUrl: async () => "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=new",
      getPort: () => 7834,
    }));

    expect(live).toBe(true);
    expect(session.tabId).toBe("replacement-tab");
    expect(session.domain).toBe("mandai.com");
    expect(session.brokerPort).toBe(7834);
  });

  it("waits through transient empty tab discovery before rebinding onto the replacement tab", async () => {
    const session: BrowseSession = {
      sessionId: "sess-1",
      tabId: "dead-tab",
      url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=old",
      harActive: true,
      domain: "mandai.com",
    };
    let discovers = 0;

    const live = await isBrowseSessionLive(session, makeClient({
      discoverTabs: async () => {
        discovers += 1;
        if (discovers === 1) return [];
        return [
          { id: "replacement-tab", url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=new" },
        ];
      },
      getCurrentUrl: async () => "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=new",
      getPort: () => 7834,
    }));

    expect(live).toBe(true);
    expect(discovers).toBeGreaterThan(1);
    expect(session.tabId).toBe("replacement-tab");
  });

  it("restarts the broker before strict session liveness checks", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", { sessionId: "sess-1", tabId: "tab-1", url: "https://example.com/review", harActive: true, domain: "example.com" }],
    ]);
    let started = 0;
    let brokerReady = false;

    const outcome = await withSerializedStrictBrowseSession(
      sessions,
      makeClient({
        start: async () => {
          started += 1;
          brokerReady = true;
        },
        discoverTabs: async () => {
          if (!brokerReady) throw { error: "CDP command failed" };
          return [{ id: "tab-1", url: "https://example.com/review" }];
        },
        getCurrentUrl: async () => "https://example.com/review",
      }),
      "sess-1",
      async () => ({ ok: true }),
    );

    expect(started).toBeGreaterThan(0);
    expect(outcome.result).toEqual({ ok: true });
    expect(sessions.has("sess-1")).toBe(true);
  });

  it("prefers the freshly selected broker client over a stale cached session client", async () => {
    const staleClient = makeClient({
      start: async () => {
        throw new Error("stale client should not be used");
      },
      getPort: () => 7817,
    });
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", {
        sessionId: "sess-1",
        tabId: "tab-1",
        url: "https://example.com/review",
        harActive: true,
        domain: "example.com",
        brokerPort: 7817,
        client: staleClient,
      }],
    ]);
    let started = 0;

    const outcome = await withSerializedStrictBrowseSession(
      sessions,
      makeClient({
        start: async () => { started += 1; },
        discoverTabs: async () => [{ id: "tab-1", url: "https://example.com/review" }],
        getCurrentUrl: async () => "https://example.com/review",
        getPort: () => 7817,
      }),
      "sess-1",
      async () => ({ ok: true }),
    );

    expect(started).toBeGreaterThan(0);
    expect(outcome.result).toEqual({ ok: true });
  });

  it("drops dead stored tabs before creating a fresh browse session", async () => {
    const sessions = new Map<string, BrowseSession>();
    sessions.set("sess-1", { sessionId: "sess-1", tabId: "dead-tab", url: "https://example.com", harActive: true, domain: "example.com" });

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
    expect(sessions.get(session.sessionId)?.tabId).toBe("fresh-tab");
  });

  it("adopts an existing same-path tab before falling back to a fresh tab", async () => {
    const sessions = new Map<string, BrowseSession>();
    sessions.set("sess-1", {
      sessionId: "sess-1",
      tabId: "dead-tab",
      url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=old",
      harActive: true,
      domain: "mandai.com",
    });

    const injected: string[] = [];
    const session = await getOrCreateBrowseSession(
      sessions,
      makeClient({
        closeTab: async () => {},
        discoverTabs: async () => [
          { id: "other-tab", url: "https://example.com" },
          { id: "mandai-live", url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=live" },
        ],
        getCurrentUrl: async (tabId) => tabId === "mandai-live" ? "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=live" : "",
        newTab: async () => "fresh-tab",
      }),
      async (tabId) => { injected.push(tabId); },
    );

    expect(session.tabId).toBe("mandai-live");
    expect(session.domain).toBe("mandai.com");
    expect(injected).toEqual([]);
  });

  it("creates a fresh tab instead of adopting blank or unrelated tabs during recovery", async () => {
    const sessions = new Map<string, BrowseSession>();
    sessions.set("default", { tabId: "dead-tab", url: "https://www.mandai.com/old", harActive: true, domain: "mandai.com" });

    const injected: string[] = [];
    const session = await getOrCreateBrowseSession(
      sessions,
      makeClient({
        closeTab: async () => {},
        discoverTabs: async () => [
          { id: "other-tab", url: "https://example.com" },
          { id: "mandai-parks", url: "https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html" },
          { id: "idle-tab", url: "chrome://newtab/" },
          { id: "blank-tab", url: "about:blank" },
        ],
        getCurrentUrl: async (tabId) => tabId === "fresh-tab" ? "about:blank" : "",
        newTab: async () => "fresh-tab",
      }),
      async (tabId) => { injected.push(tabId); },
    );

    expect(session.tabId).toBe("fresh-tab");
    expect(injected).toEqual(["fresh-tab"]);
  });

  it("does not recover an explicit session onto an unrelated same-domain tab", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", {
        sessionId: "sess-1",
        tabId: "dead-tab",
        url: "https://www.mandai.com/en/ticketing/admission-and-rides/add-ons-selection.html",
        harActive: true,
        domain: "mandai.com",
      }],
    ]);

    const injected: string[] = [];
    const session = await resetBrowseSession(
      sessions,
      makeClient({
        closeTab: async () => {},
        discoverTabs: async () => [
          { id: "parks-tab", url: "https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html" },
        ],
        getCurrentUrl: async (tabId) => tabId === "fresh-tab" ? "about:blank" : "",
        newTab: async () => "fresh-tab",
      }),
      async (tabId) => { injected.push(tabId); },
      "sess-1",
    );

    expect(session.sessionId).toBe("sess-1");
    expect(session.tabId).toBe("fresh-tab");
    expect(injected).toEqual(["fresh-tab"]);
  });

  it("rebinds a surviving session onto a replacement tab with the same pathname", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", {
        sessionId: "sess-1",
        tabId: "dead-tab",
        url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=old",
        harActive: true,
        domain: "mandai.com",
      }],
    ]);

    const injected: string[] = [];
    const rebound = await rebindBrowseSessionToMatchingTab(
      sessions,
      makeClient({
        discoverTabs: async () => [
          { id: "parks-tab", url: "https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html" },
          { id: "replacement-tab", url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=new" },
        ],
        getCurrentUrl: async (tabId) => tabId === "replacement-tab"
          ? "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=new"
          : "",
        harStart: async () => {},
      }),
      async (tabId) => { injected.push(tabId); },
      "sess-1",
      "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=after-submit",
    );

    expect(rebound?.sessionId).toBe("sess-1");
    expect(rebound?.tabId).toBe("replacement-tab");
    expect(sessions.get("sess-1")?.tabId).toBe("replacement-tab");
    expect(injected).toEqual(["replacement-tab"]);
  });

  it("starts the broker before trying to rebind onto a replacement tab", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", {
        sessionId: "sess-1",
        tabId: "dead-tab",
        url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html",
        harActive: true,
        domain: "mandai.com",
      }],
    ]);
    let started = 0;
    let brokerReady = false;

    const rebound = await rebindBrowseSessionToMatchingTab(
      sessions,
      makeClient({
        start: async () => {
          started += 1;
          brokerReady = true;
        },
        discoverTabs: async () => {
          if (!brokerReady) throw { error: "CDP command failed" };
          return [
            { id: "replacement-tab", url: "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=new" },
          ];
        },
        getCurrentUrl: async () => "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=new",
      }),
      async () => {},
      "sess-1",
      "https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html?step=after-submit",
    );

    expect(started).toBeGreaterThan(0);
    expect(rebound?.tabId).toBe("replacement-tab");
  });

  it("surfaces broker start failures instead of swallowing them", async () => {
    const sessions = new Map<string, BrowseSession>();
    const error = new Error("Kuri failed to start");

    await expect(getOrCreateBrowseSession(
      sessions,
      makeClient({
        start: async () => { throw error; },
      }),
      async () => {},
    )).rejects.toThrow("Kuri failed to start");
  });

  it("retries once after a recoverable CDP failure result", async () => {
    const sessions = new Map<string, BrowseSession>();
    const created: string[] = [];
    const closed = new Set<string>();
    const runs: string[] = [];

    const result = await withRecoveredBrowseSession(
      sessions,
      makeClient({
        newTab: async () => {
          const next = `tab-${created.length + 1}`;
          created.push(next);
          return next;
        },
        closeTab: async (tabId) => { closed.add(tabId); },
        discoverTabs: async () => created.filter((id) => !closed.has(id)).map((id) => ({ id, url: "about:blank" })),
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
    expect(Array.from(closed)).toEqual(["tab-1"]);
    expect(result.result).toEqual({ ok: true });
  });

  it("creates distinct registered sessions and keeps both addressable", () => {
    const sessions = new Map<string, BrowseSession>();
    const first = createRegisteredBrowseSession(sessions, {
      tabId: "tab-1",
      url: "https://example.com/a",
      domain: "example.com",
      harActive: true,
    });
    const second = createRegisteredBrowseSession(sessions, {
      tabId: "tab-2",
      url: "https://example.com/b",
      domain: "example.com",
      harActive: true,
    });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(sessions.get(first.sessionId)?.tabId).toBe("tab-1");
    expect(sessions.get(second.sessionId)?.tabId).toBe("tab-2");
  });

  it("records broker affinity on created browse sessions", async () => {
    const sessions = new Map<string, BrowseSession>();
    const client = makeClient({
      getPort: () => 7815,
      newTab: async () => "broker-tab",
      discoverTabs: async () => [{ id: "broker-tab", url: "about:blank" }],
      getCurrentUrl: async () => "about:blank",
    });

    const session = await getOrCreateBrowseSession(
      sessions,
      client,
      async () => {},
    );

    expect(session.brokerPort).toBe(7815);
    expect(session.client).toBe(client);
  });

  it("requires session_id when more than one live session exists", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", { sessionId: "sess-1", tabId: "tab-1", url: "https://example.com/a", harActive: true, domain: "example.com" }],
      ["sess-2", { sessionId: "sess-2", tabId: "tab-2", url: "https://example.com/b", harActive: true, domain: "example.com" }],
    ]);

    await expect(resolveRequestedBrowseSession(
      sessions,
      makeClient({
        discoverTabs: async () => [
          { id: "tab-1", url: "https://example.com/a" },
          { id: "tab-2", url: "https://example.com/b" },
        ],
        getCurrentUrl: async (tabId) => tabId === "tab-1" ? "https://example.com/a" : "https://example.com/b",
      }),
    )).rejects.toMatchObject({ code: "session_id_required" satisfies BrowseSessionError["code"] });
  });

  it("serializes operations for the same session", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", { sessionId: "sess-1", tabId: "tab-1", url: "https://example.com", harActive: true, domain: "example.com" }],
    ]);
    const order: string[] = [];

    await Promise.all([
      withSerializedStrictBrowseSession(
        sessions,
        makeClient({
          discoverTabs: async () => [{ id: "tab-1", url: "https://example.com" }],
          getCurrentUrl: async () => "https://example.com",
        }),
        "sess-1",
        async () => {
          order.push("first:start");
          await new Promise((resolve) => setTimeout(resolve, 25));
          order.push("first:end");
          return "first";
        },
      ),
      withSerializedStrictBrowseSession(
        sessions,
        makeClient({
          discoverTabs: async () => [{ id: "tab-1", url: "https://example.com" }],
          getCurrentUrl: async () => "https://example.com",
        }),
        "sess-1",
        async () => {
          order.push("second:start");
          order.push("second:end");
          return "second";
        },
      ),
    ]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("expires strict session operations instead of recovering onto another tab", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", { sessionId: "sess-1", tabId: "tab-1", url: "https://example.com", harActive: true, domain: "example.com" }],
    ]);

    await expect(withSerializedStrictBrowseSession(
      sessions,
      makeClient({
        discoverTabs: async () => [],
        getCurrentUrl: async () => "",
      }),
      "sess-1",
      async () => true,
    )).rejects.toMatchObject({ code: "session_expired" satisfies BrowseSessionError["code"] });
  });

  it("does not expire a strict session when a recoverable result arrives but the tab is still live", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", { sessionId: "sess-1", tabId: "tab-1", url: "https://example.com/review", harActive: true, domain: "example.com" }],
    ]);
    let currentUrlReads = 0;

    const outcome = await withSerializedStrictBrowseSession(
      sessions,
      makeClient({
        discoverTabs: async () => [{ id: "tab-1", url: "https://example.com/review" }],
        getCurrentUrl: async () => {
          currentUrlReads += 1;
          if (currentUrlReads === 2) throw { error: "Execution context was destroyed" };
          return "https://example.com/review";
        },
      }),
      "sess-1",
      async () => ({ error: "Execution context was destroyed" }),
      (result) => isRecoverableBrowseFailure(result),
    );

    expect(outcome.result).toEqual({ error: "Execution context was destroyed" });
    expect(sessions.has("sess-1")).toBe(true);
  });

  it("does not drop a strict session on a recoverable throw if the tab is still live", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", { sessionId: "sess-1", tabId: "tab-1", url: "https://example.com/review", harActive: true, domain: "example.com" }],
    ]);
    let currentUrlReads = 0;

    await expect(withSerializedStrictBrowseSession(
      sessions,
      makeClient({
        discoverTabs: async () => [{ id: "tab-1", url: "https://example.com/review" }],
        getCurrentUrl: async () => {
          currentUrlReads += 1;
          if (currentUrlReads === 2) throw { error: "Execution context was destroyed" };
          return "https://example.com/review";
        },
      }),
      "sess-1",
      async () => {
        throw { error: "Execution context was destroyed" };
      },
    )).rejects.toEqual({ error: "Execution context was destroyed" });

    expect(sessions.has("sess-1")).toBe(true);
  });

  it("can recover a read-only session without changing its session id", async () => {
    const sessions = new Map<string, BrowseSession>([
      ["sess-1", { sessionId: "sess-1", tabId: "dead-tab", url: "https://example.com", harActive: true, domain: "example.com" }],
    ]);

    const { session, result, recovered } = await withSerializedRecoveredBrowseSession(
      sessions,
      makeClient({
        newTab: async () => "fresh-tab",
        closeTab: async () => {},
        discoverTabs: async () => [{ id: "fresh-tab", url: "https://example.com/fresh" }],
        getCurrentUrl: async () => "https://example.com/fresh",
      }),
      async () => {},
      "sess-1",
      async (activeSession) => activeSession.tabId === "dead-tab" ? { error: "CDP command failed" } : { ok: true },
      (value) => isRecoverableBrowseFailure(value),
    );

    expect(recovered).toBe(true);
    expect(session.sessionId).toBe("sess-1");
    expect(result).toEqual({ ok: true });
    expect(sessions.get("sess-1")?.tabId).toBe("fresh-tab");
  });
});
