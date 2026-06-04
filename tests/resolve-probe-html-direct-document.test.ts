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
});
