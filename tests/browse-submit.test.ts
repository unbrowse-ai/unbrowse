import { describe, expect, it } from "bun:test";
import type { BrowseSession, BrowseSessionClient } from "../src/api/browse-session.js";
import { withRecoveredBrowseSession } from "../src/api/browse-session.js";
import { hasMeaningfulPageChange, resolveSubmitWaitHint, submitBrowseForm, type BrowseSubmitClient } from "../src/api/browse-submit.js";

function makeSubmitClient(overrides: Partial<BrowseSubmitClient> = {}): BrowseSubmitClient {
  return {
    evaluate: async () => JSON.stringify({ ok: true, submit_kind: "requestSubmit" }),
    getCurrentUrl: async () => "https://example.com/step-1",
    getPageHtml: async () => "<html><body>step-1</body></html>",
    waitForSelector: async () => ({ status: "timeout" }),
    ...overrides,
  };
}

function makeRecoveryClient(overrides: Partial<BrowseSessionClient> = {}): BrowseSessionClient {
  return {
    start: async () => {},
    newTab: async () => "tab-1",
    harStart: async () => {},
    closeTab: async () => {},
    discoverTabs: async () => [{ id: "tab-1", url: "https://example.com/step-1" }],
    getCurrentUrl: async () => "https://example.com/step-1",
    ...overrides,
  };
}

describe("browse submit", () => {
  it("detects meaningful body changes", () => {
    expect(hasMeaningfulPageChange("<html><body>old</body></html>", "<html><body>new</body></html>")).toBe(true);
    expect(hasMeaningfulPageChange("<html><body>same</body></html>", "<html><body>same</body></html>")).toBe(false);
  });

  it("resolves filename wait hints relative to the current workflow directory", () => {
    expect(resolveSubmitWaitHint(
      "https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html",
      "/tickets-selection.html",
    )).toBe("https://www.mandai.com/en/ticketing/admission-and-rides/tickets-selection.html");
    expect(resolveSubmitWaitHint(
      "https://www.mandai.com/en/ticketing/admission-and-rides/date-selection.html",
      "/add-ons-selection.html",
    )).toBe("https://www.mandai.com/en/ticketing/admission-and-rides/add-ons-selection.html");
  });

  it("keeps multi-segment wait hints root-relative", () => {
    expect(resolveSubmitWaitHint(
      "https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html",
      "/en/account/login.html",
    )).toBe("https://www.mandai.com/en/account/login.html");
  });

  it("falls back to same-origin html rehydrate when DOM submit stalls", async () => {
    const session: BrowseSession = {
      sessionId: "sess-1",
      tabId: "tab-1",
      url: "https://example.com/step-1",
      harActive: true,
      domain: "example.com",
    };
    let evalCount = 0;

    const result = await submitBrowseForm(
      {
        client: makeSubmitClient({
          evaluate: async () => {
            evalCount += 1;
            if (evalCount === 1) return JSON.stringify({ ok: true, submit_kind: "requestSubmit" });
            return JSON.stringify({
              ok: true,
              status: 200,
              url: "https://example.com/review",
              same_origin_html_rehydrated: true,
              rehydrate: { attempted: false, loaded: false, nooped: true, reason: "missing_wrs_require", modules: ["ticketing.js"] },
            });
          },
          getCurrentUrl: async () => "https://example.com/step-1",
          getPageHtml: async () => "<html><body>step-1</body></html>",
        }),
        session,
        flushCapture: async () => ({
          indexed: true,
          mode: "http",
          skill_id: "skill-1",
          endpoint_count: 2,
          request_count: 1,
          background_publish_queued: true,
        }),
        restartCapture: async () => {},
        rehydratePlugins: async () => ({ attempted: false, loaded: false, nooped: true, reason: "missing_wrs_require", modules: [] }),
      },
      { timeoutMs: 20 },
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("same_origin_fetch");
    expect(result.fallback_used).toBe(true);
    expect(result.same_origin_html_rehydrated).toBe(true);
    expect(result.url).toBe("https://example.com/review");
    expect(result.capture_sync).toBeNull();
    expect(session.url).toBe("https://example.com/review");
  });

  it("keeps the active capture session running across successful DOM submits", async () => {
    const session: BrowseSession = {
      sessionId: "sess-1",
      tabId: "tab-1",
      url: "https://example.com/step-1",
      harActive: true,
      domain: "example.com",
    };
    let urlReads = 0;
    let htmlReads = 0;

    const result = await submitBrowseForm(
      {
        client: makeSubmitClient({
          getCurrentUrl: async () => {
            urlReads += 1;
            return urlReads === 1 ? "https://example.com/step-1" : "https://example.com/review";
          },
          getPageHtml: async () => {
            htmlReads += 1;
            return htmlReads === 1 ? "<html><body>step-1</body></html>" : "<html><body>review</body></html>";
          },
        }),
        session,
        flushCapture: async () => ({
          indexed: true,
          mode: "dom",
          skill_id: "skill-2",
          endpoint_count: 1,
          request_count: 0,
          background_publish_queued: true,
        }),
        restartCapture: async () => {},
        rehydratePlugins: async () => null,
      },
      { timeoutMs: 20 },
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("dom");
    expect(result.capture_sync).toBeNull();
    expect(session.harActive).toBe(true);
  });

  it("does not treat same-page html churn as success when a URL wait hint is provided", async () => {
    const session: BrowseSession = {
      sessionId: "sess-1",
      tabId: "tab-1",
      url: "https://example.com/step-1",
      harActive: true,
      domain: "example.com",
    };
    let evalCount = 0;
    let htmlReads = 0;

    const result = await submitBrowseForm(
      {
        client: makeSubmitClient({
          evaluate: async () => {
            evalCount += 1;
            if (evalCount === 1) return JSON.stringify({ ok: true, submit_kind: "requestSubmit" });
            return JSON.stringify({
              ok: true,
              status: 200,
              url: "https://example.com/tickets-selection.html",
              same_origin_html_rehydrated: true,
              rehydrate: { attempted: false, loaded: false, nooped: true, reason: "missing_wrs_require", modules: [] },
            });
          },
          getCurrentUrl: async () => "https://example.com/step-1",
          getPageHtml: async () => {
            htmlReads += 1;
            return htmlReads === 1
              ? "<html><body>step-1</body></html>"
              : "<html><body>filters updated but still step-1</body></html>";
          },
        }),
        session,
        restartCapture: async () => {},
        rehydratePlugins: async () => null,
      },
      { timeoutMs: 20, waitFor: "/tickets-selection.html" },
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("same_origin_fetch");
    expect(result.fallback_used).toBe(true);
    expect(result.url).toBe("https://example.com/tickets-selection.html");
    expect(session.url).toBe("https://example.com/tickets-selection.html");
  });

  it("retries once on recoverable submit failure and preserves updated session url", async () => {
    const sessions = new Map<string, BrowseSession>();
    const created: string[] = [];
    const closed = new Set<string>();

    const client = makeRecoveryClient({
      newTab: async () => {
        const tabId = `tab-${created.length + 1}`;
        created.push(tabId);
        return tabId;
      },
      closeTab: async (tabId) => { closed.add(tabId); },
      discoverTabs: async () => created.filter((id) => !closed.has(id)).map((id) => ({ id, url: "https://example.com/step-1" })),
      getCurrentUrl: async () => "https://example.com/step-1",
    });

    const evalCounts = new Map<string, number>();
    const browseClient = makeSubmitClient({
      evaluate: async (tabId) => {
        const seen = (evalCounts.get(tabId) ?? 0) + 1;
        evalCounts.set(tabId, seen);
        if (tabId === "tab-1") throw { error: "CDP command failed" };
        return JSON.stringify({ ok: true, submit_kind: "requestSubmit" });
      },
      getCurrentUrl: async (tabId) => tabId === "tab-2" ? "https://example.com/review" : "https://example.com/step-1",
      getPageHtml: async (tabId) => tabId === "tab-2" ? "<html><body>review</body></html>" : "<html><body>step-1</body></html>",
    });

    const { session, result, recovered } = await withRecoveredBrowseSession(
      sessions,
      client,
      async () => {},
      async (session) => submitBrowseForm(
        {
          client: browseClient,
          session,
          restartCapture: async () => {},
          rehydratePlugins: async () => ({ attempted: false, loaded: false, nooped: true, reason: "missing_wrs_require", modules: [] }),
        },
        { timeoutMs: 20 },
      ),
      (result) => !result.ok && result.recoverable === true,
    );

    expect(recovered).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("same_origin_fetch");
    expect(session.url).toBe("https://example.com/review");
  });

  it("keeps the settled destination after redirect chains", async () => {
    const session: BrowseSession = {
      tabId: "tab-1",
      url: "https://example.com/step-1",
      harActive: true,
      domain: "example.com",
    };

    let urlReads = 0;
    const result = await submitBrowseForm(
      {
        client: makeSubmitClient({
          evaluate: async () => JSON.stringify({ ok: true, submit_kind: "requestSubmit" }),
          getCurrentUrl: async () => {
            urlReads += 1;
            if (urlReads === 1) return "https://example.com/step-1";
            if (urlReads === 2) return "https://example.com/review";
            return "https://auth.example.com/login";
          },
          getPageHtml: async () => "<html><body>redirected</body></html>",
        }),
        session,
        restartCapture: async () => {},
        rehydratePlugins: async () => ({ attempted: false, loaded: false, nooped: true, reason: "missing_wrs_require", modules: [] }),
      },
      { timeoutMs: 40 },
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("dom");
    expect(result.url).toBe("https://auth.example.com/login");
    expect(session.url).toBe("https://auth.example.com/login");
  });
});
