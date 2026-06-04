/**
 * Tests for first-pass browser action (issue #229).
 *
 * Pure-function tests run unconditionally. The integration test that exercises
 * tryFirstPassBrowserAction against a real URL is guarded behind a kuri health
 * check — it skips when kuri/Chrome are unavailable (CI, headless boxes, etc.).
 */
import { describe, expect, it } from "bun:test";
import {
  classifyIntent,
  classifyAction,
  synthesizeSkillFromIntercepted,
  tryFirstPassBrowserAction,
} from "../src/orchestrator/first-pass-action.js";
import type { KuriHarEntry } from "../src/kuri/client.js";

// ---------------------------------------------------------------------------
// classifyIntent — pure function tests
// ---------------------------------------------------------------------------
describe("classifyIntent", () => {
  it("classifies search intents", () => {
    expect(classifyIntent("search for keyboards")).toBe("search");
    expect(classifyIntent("Find cheap monitors")).toBe("search");
    expect(classifyIntent("browse gaming laptops")).toBe("search");
    expect(classifyIntent("discover new recipes")).toBe("search");
    expect(classifyIntent("look for flights")).toBe("search");
  });

  it("classifies navigate intents", () => {
    expect(classifyIntent("go to the homepage")).toBe("navigate");
    expect(classifyIntent("open settings page")).toBe("navigate");
    expect(classifyIntent("visit the about page")).toBe("navigate");
    expect(classifyIntent("navigate to pricing")).toBe("navigate");
  });

  it("classifies click intents", () => {
    expect(classifyIntent("click the login button")).toBe("click");
    expect(classifyIntent("tap on the menu")).toBe("click");
    expect(classifyIntent("press the submit button")).toBe("click");
  });

  it("classifies submit intents", () => {
    expect(classifyIntent("submit the form")).toBe("submit");
    expect(classifyIntent("register an account")).toBe("submit");
    expect(classifyIntent("sign up for newsletter")).toBe("submit");
    expect(classifyIntent("book a flight")).toBe("submit");
    expect(classifyIntent("apply for the job")).toBe("submit");
  });

  it("classifies read intents", () => {
    expect(classifyIntent("read the article")).toBe("read");
    expect(classifyIntent("get the price")).toBe("read");
    expect(classifyIntent("fetch user profile")).toBe("read");
    expect(classifyIntent("show me the list")).toBe("read");
    expect(classifyIntent("list all products")).toBe("read");
    expect(classifyIntent("view my orders")).toBe("read");
  });

  it("returns unknown for unclassifiable intents", () => {
    expect(classifyIntent("do something")).toBe("unknown");
    expect(classifyIntent("hello world")).toBe("unknown");
    expect(classifyIntent("")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// classifyAction — pure function tests
// ---------------------------------------------------------------------------
describe("classifyAction", () => {
  it("returns search action with input selector for search intents", () => {
    const result = classifyAction("search", "https://example.com");
    expect(result.type).toBe("search");
    expect(result.selector).toContain("input[type=search]");
    expect(result.selector).toContain("input[name=q]");
  });

  it("returns click action with submit selector for submit intents", () => {
    const result = classifyAction("submit", "https://example.com");
    expect(result.type).toBe("click");
    expect(result.selector).toContain("button[type=submit]");
  });

  it("returns click action for click intents", () => {
    const result = classifyAction("click", "https://example.com");
    expect(result.type).toBe("click");
  });

  it("returns navigate for navigate/read/unknown intents", () => {
    expect(classifyAction("navigate", "https://example.com").type).toBe("navigate");
    expect(classifyAction("read", "https://example.com").type).toBe("navigate");
    expect(classifyAction("unknown", "https://example.com").type).toBe("navigate");
  });
});

// ---------------------------------------------------------------------------
// synthesizeSkillFromIntercepted — pure function tests
// ---------------------------------------------------------------------------
describe("synthesizeSkillFromIntercepted", () => {
  const makeEntry = (url: string, status = 200, contentType = "application/json"): KuriHarEntry => ({
    startedDateTime: new Date().toISOString(),
    request: {
      method: "GET",
      url,
      headers: [],
    },
    response: {
      status,
      headers: [{ name: "content-type", value: contentType }],
      content: { text: JSON.stringify({ ok: true }), mimeType: contentType },
    },
  });

  it("returns undefined for empty entries", () => {
    expect(synthesizeSkillFromIntercepted([], "example.com", "test")).toBeUndefined();
  });

  it("synthesizes a skill manifest from intercepted entries", () => {
    const entries = [
      makeEntry("https://api.example.com/v1/search?q=test"),
      makeEntry("https://api.example.com/v1/suggest?q=test"),
    ];
    const skill = synthesizeSkillFromIntercepted(entries, "example.com", "search for test");

    expect(skill).toBeDefined();
    expect(skill!.skill_id).toMatch(/^first-pass-example\.com-/);
    expect(skill!.domain).toBe("example.com");
    expect(skill!.intent_signature).toBe("search for test");
    expect(skill!.endpoints).toHaveLength(2);
    expect(skill!.endpoints[0].method).toBe("GET");
    expect(skill!.endpoints[0].url_template).toBe("https://api.example.com/v1/search");
    expect(skill!.endpoints[0].verification_status).toBe("unverified");
    expect(skill!.endpoints[1].url_template).toBe("https://api.example.com/v1/suggest");
    expect(skill!.execution_type).toBe("http");
    expect(skill!.owner_type).toBe("agent");
  });

  it("strips query parameters from url_template", () => {
    const entries = [makeEntry("https://api.example.com/data?foo=bar&baz=qux")];
    const skill = synthesizeSkillFromIntercepted(entries, "example.com", "read data");
    expect(skill!.endpoints[0].url_template).toBe("https://api.example.com/data");
  });

  it("uppercases the HTTP method", () => {
    const entry = makeEntry("https://api.example.com/data");
    entry.request.method = "post";
    const skill = synthesizeSkillFromIntercepted([entry], "example.com", "submit");
    expect(skill!.endpoints[0].method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// tryFirstPassBrowserAction — integration test (requires kuri)
// ---------------------------------------------------------------------------
describe("tryFirstPassBrowserAction", () => {
  it("never throws, returns hit:false on error", async () => {
    // This tests the safety contract: even if kuri is down,
    // the function returns a miss result instead of throwing.
    const controller = new AbortController();
    // Abort immediately to force a fast exit
    controller.abort();
    const result = await tryFirstPassBrowserAction(
      "read data",
      {},
      "https://httpbin.org/get",
      { signal: controller.signal },
    );
    expect(result.hit).toBe(false);
    expect(result.interceptedEntries).toEqual([]);
    expect(result.timeMs).toBeGreaterThanOrEqual(0);
    expect(result.intentClass).toBe("read");
    expect(typeof result.actionTaken).toBe("string");
  });

  it("returns correct intentClass for a search intent", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await tryFirstPassBrowserAction(
      "search for keyboards",
      { query: "mechanical keyboards" },
      "https://www.example.com",
      { signal: controller.signal },
    );
    expect(result.intentClass).toBe("search");
    expect(result.hit).toBe(false); // aborted, so no hit
  });

  it("handles invalid URLs gracefully", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await tryFirstPassBrowserAction(
      "read something",
      {},
      "not-a-valid-url",
      { signal: controller.signal },
    );
    expect(result.hit).toBe(false);
    // Should not throw
  });

  it("respects external abort signal", async () => {
    const controller = new AbortController();
    // Abort after 50ms
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    const result = await tryFirstPassBrowserAction(
      "navigate to page",
      {},
      "https://httpbin.org/delay/10",
      { signal: controller.signal },
    );
    const elapsed = Date.now() - t0;
    expect(result.hit).toBe(false);
    // Should exit well under the 8s hard timeout
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);
});
