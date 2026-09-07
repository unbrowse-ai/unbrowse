import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: when the budget-race probe winner is an HTML document AND the
// caller supplied the exact content URL, resolve must return the page itself
// (direct-document) — NOT Exa "links about the topic" — even when Exa has rich
// hits. Before the HTML direct-document fast-path, the same intent+url was
// non-deterministic: direct-document on one call, exa candidates on the next,
// depending on who won the race. The caller's own URL is the ground truth.

const originalFetch = globalThis.fetch;
const originalSkillSnapshotDir = process.env.UNBROWSE_SKILL_SNAPSHOT_DIR;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSkillSnapshotDir === undefined) {
    delete process.env.UNBROWSE_SKILL_SNAPSHOT_DIR;
  } else {
    process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = originalSkillSnapshotDir;
  }
});

describe("probe-winner HTML content URL prefers direct-document over Exa", () => {
  test("returns the page (direct-document), not Exa candidates, even when Exa has hits", async () => {
    process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), "unbrowse-snapshots-"));
    const { resolveAndExecute } = await import("../src/orchestrator/index.js");
    const url = "https://example-news.test/top";
    const html = `<!doctype html><html><head><title>Top Stories</title></head><body><main><h1>Top Stories</h1>${"Story headline and summary text. ".repeat(400)}</main></body></html>`;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";
      // The caller's URL is a real HTML document on both the probe (HEAD) and
      // the direct-document GET.
      if (u === url) {
        return new Response(method === "HEAD" ? "" : html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      // Everything else (marketplace lookup etc.) is a miss — forces the probe
      // to be the only valid race winner.
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const out = await resolveAndExecute(
      "top stories",
      {},
      { url },
      { raw: true },
      {
        budget_ms: 50,
        client_scope: "probe-html-direct-doc",
        // Exa HAS rich, relevant hits — without the HTML fast-path this branch
        // would win and the resolve would return source "exa" with candidate
        // links instead of the page the caller asked for.
        exaSearchOverride: async () => ({
          exa_results: [
            {
              url: "https://other.test/roundup",
              title: "Top stories roundup",
              score: 0.9,
              highlights: ["Top stories about the topic. ".repeat(20)],
            },
          ],
        }),
      },
    );

    expect(out.source).toBe("direct-document");
    expect(out.trace.skill_id).toBe("direct-document");
    expect(out.result).toMatchObject({
      title: "Top Stories",
      extraction: { source: "direct-document", rejected: false },
    });
  });

  test("passes the one-hole intent into both direct-document composition branches", async () => {
    const source = await Bun.file(new URL("../src/orchestrator/index.ts", import.meta.url).pathname).text();
    const calls = source.match(/fetchDirectDocument\(raceContextUrl, queryIntent\)/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(source).not.toContain("fetchDirectDocument(raceContextUrl);");
  });

  test("terminal guard rejects synthetic no-proof DOM artifacts for JS-required intents", async () => {
    const { enforceEvaluatedJavascriptTruth } = await import("../src/orchestrator/index.js");
    const synthetic = {
      result: { proof_status: "no_proof", dom_extraction: { selector: "table" }, browser_avoided: false },
      trace: { trace_id: "t", skill_id: "capture", endpoint_id: "dom", started_at: "now", success: true },
      source: "live-capture",
      timing: {},
    } as any;
    const rejected = enforceEvaluatedJavascriptTruth("Report whether WebDriver is present", synthetic);
    expect(rejected.result).toMatchObject({ error: "javascript_evaluation_required", required_truth_mode: "javascript_evaluated" });
    expect(rejected.trace).toMatchObject({ success: false, error: "javascript_evaluation_required" });

    const evaluated = { ...synthetic, result: { truth: { truth_mode: "javascript_evaluated" }, webdriver: false } };
    expect(enforceEvaluatedJavascriptTruth("Report whether WebDriver is present", evaluated)).toBe(evaluated);
  });

  test("terminal intent guard applies exact result cardinality", async () => {
    const { enforceIntentResultTruth } = await import("../src/orchestrator/index.js");
    const output = {
      result: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, title: `Post ${index + 1}` })),
      trace: { trace_id: "t", skill_id: "direct-fetch", endpoint_id: "direct-fetch", started_at: "now", success: true },
      source: "direct-fetch",
      timing: {},
    } as any;
    const judged = enforceIntentResultTruth("return exactly 3 posts with id and title", output, {
      url: "https://jsonplaceholder.typicode.com/posts",
    });
    expect(judged.result).toHaveLength(3);
    expect(judged.trace.success).toBe(true);
  });

  test("terminal intent guard admits a query-bearing API collection and preserves its requested limit", async () => {
    const { enforceIntentResultTruth } = await import("../src/orchestrator/index.js");
    const output = {
      result: Array.from({ length: 28 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}` })),
      trace: { trace_id: "t", skill_id: "direct-fetch", endpoint_id: "direct-fetch", started_at: "now", success: true },
      source: "direct-fetch",
      timing: {},
    } as any;
    const judged = enforceIntentResultTruth("return exactly 10 open issues", output, {
      url: "https://api.github.com/repos/unbrowse-ai/unbrowse/issues?state=open&per_page=100",
    });
    expect(judged.result).toHaveLength(10);
    expect(judged.trace.success).toBe(true);
  });

  test("terminal intent guard still rejects an array for a query-bearing detail URL", async () => {
    const { enforceIntentResultTruth } = await import("../src/orchestrator/index.js");
    const output = {
      result: [{ number: 123 }, { number: 124 }],
      trace: { trace_id: "t", skill_id: "direct-fetch", endpoint_id: "direct-fetch", started_at: "now", success: true },
      source: "direct-fetch",
      timing: {},
    } as any;
    const judged = enforceIntentResultTruth("get issue details", output, {
      url: "https://api.example.test/issues/123?state=open",
    });
    expect(judged.result).toMatchObject({ error: "response_shape_mismatch", task_ok: false });
    expect(judged.trace.success).toBe(false);
  });

  test("terminal intent guard rejects a collection for a concrete detail URL", async () => {
    const { enforceIntentResultTruth } = await import("../src/orchestrator/index.js");
    const output = {
      result: [{ name: "serde" }, { name: "serde_json" }],
      trace: { trace_id: "t", skill_id: "cached", endpoint_id: "search", started_at: "now", success: true },
      source: "route-cache",
      timing: {},
    } as any;
    const judged = enforceIntentResultTruth("get crate serde details", output, {
      url: "https://crates.io/crates/serde",
    });
    expect(judged.result).toMatchObject({ error: "response_shape_mismatch", task_ok: false });
    expect(judged.trace).toMatchObject({ success: false, error: "response_shape_mismatch" });
  });

  test("terminal intent guard requires explicit auth evidence on protected targets", async () => {
    const { enforceIntentResultTruth } = await import("../src/orchestrator/index.js");
    const output = {
      result: [{ title: "Advertising on X" }],
      trace: { trace_id: "t", skill_id: "public-web", endpoint_id: "search", started_at: "now", success: true },
      source: "marketplace",
      timing: {},
    } as any;
    const judged = enforceIntentResultTruth("get my authenticated home timeline", output, { url: "https://x.com/home" });
    expect(judged.result).toMatchObject({ error: "authenticated_evidence_required", auth_ok: false, task_ok: false });
    expect(judged.trace.success).toBe(false);
  });
});
