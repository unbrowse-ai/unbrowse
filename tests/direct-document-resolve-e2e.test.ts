import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("Bloomberg direct-document resolver path", () => {
  test("returns a direct-document result through resolveAndExecute", async () => {
    process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), "unbrowse-snapshots-"));
    const { resolveAndExecute } = await import("../src/orchestrator/index.js");
    const html = `<!doctype html><html><head><title>Markets - Bloomberg</title></head><body><main><h1>Markets</h1>${"Bloomberg market data ".repeat(400)}</main></body></html>`;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";
      if (url === "https://www.bloomberg.com/markets" && method === "HEAD") {
        return new Response(JSON.stringify({ error: "edge probe denied" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://www.bloomberg.com/markets") {
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const out = await resolveAndExecute(
      "get bloomberg markets page",
      {},
      { url: "https://www.bloomberg.com/markets" },
      { raw: true },
      { budget_ms: 50, client_scope: "direct-document-e2e" },
    );

    expect(out.source).toBe("direct-document");
    expect(out.trace.success).toBe(true);
    expect(out.trace.skill_id).toBe("direct-document");
    expect(out.result).toMatchObject({
      title: "Markets - Bloomberg",
      extraction: { source: "direct-document", rejected: false },
    });
  });
});
