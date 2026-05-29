/**
 * W22 — v7 CLI tests for `eval spec`.
 *
 * Always-wrap rule (Pro 25:2 — *"It is the glory of God to conceal a
 * thing, but the glory of kings is to search out a matter"*): this
 * harness IS the search-out that proves the spec-discovery primitive
 * actually probes the right paths, fast-fails on slow ones, and refuses
 * cross-domain redirect swaps.
 *
 * NO MOCKS. Real `Bun.serve` test servers on random ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  runSpecDiscovery,
  normalizeOrigin,
} from "../src/cli-v7/eval/spec.js";
import { SITEMAP_LOC_CAP } from "../src/cli-v7/eval/spec-sources/sitemap.js";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

// ─── Test server scaffolding ───────────────────────────────────────────────

interface TestServerHandlers {
  [path: string]:
    | { status: number; body: string; contentType?: string; headers?: Record<string, string> }
    | { delayMs: number; status: number; body: string; contentType?: string };
}

function buildServer(handlers: TestServerHandlers) {
  return Bun.serve({
    port: 0, // random
    fetch: async (req) => {
      const url = new URL(req.url);
      const handler = handlers[url.pathname];
      if (!handler) {
        return new Response("not found", { status: 404 });
      }
      if ("delayMs" in handler) {
        await new Promise((r) => setTimeout(r, handler.delayMs));
        return new Response(handler.body, {
          status: handler.status,
          headers: { "content-type": handler.contentType ?? "application/json" },
        });
      }
      const headers: Record<string, string> = {
        "content-type": handler.contentType ?? "application/json",
        ...(handler.headers ?? {}),
      };
      return new Response(handler.body, { status: handler.status, headers });
    },
  });
}

// ─── 1. OpenAPI 3 hit ──────────────────────────────────────────────────────

describe("v7-cli eval spec — openapi.json hit", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    server = buildServer({
      "/openapi.json": {
        status: 200,
        body: JSON.stringify({
          openapi: "3.0.3",
          info: { title: "TestAPI", version: "1.0.0" },
          paths: {
            "/v1/users": {
              get: {
                summary: "List users",
                parameters: [
                  { name: "limit", in: "query", required: false, schema: { type: "integer" } },
                ],
                responses: { 200: { content: { "application/json": { schema: { properties: { id: {}, name: {} } } } } } },
              },
            },
            "/v1/users/{id}": {
              get: {
                summary: "Get user",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: { 200: {} },
              },
            },
          },
        }),
      },
    });
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("discovers openapi.json and parses endpoints", async () => {
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 3000,
      includeGraphql: false,
    });
    const openapiHit = result.hits.find((h) => h.source === "openapi");
    expect(openapiHit).toBeDefined();
    expect((openapiHit as { endpoint_count: number }).endpoint_count).toBe(2);
    const endpoints = (openapiHit as { endpoints: Array<{ path: string; method: string }> }).endpoints;
    expect(endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      "GET /v1/users",
      "GET /v1/users/{id}",
    ]);
    // misses MUST include swagger, html-link, sitemap, robots (not graphql since opt-in OFF)
    expect(result.misses).toContain("swagger");
    expect(result.misses).toContain("sitemap");
    expect(result.misses).not.toContain("graphql");
  });
});

// ─── 2. All probes miss ────────────────────────────────────────────────────

describe("v7-cli eval spec — all 404", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    server = buildServer({}); // empty handler map → everything 404
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("returns no hits and all probe families in misses", async () => {
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 3000,
      includeGraphql: true,
    });
    expect(result.hits).toEqual([]);
    expect(result.misses.sort()).toEqual(
      ["graphql", "html-link", "openapi", "robots", "sitemap", "swagger"].sort(),
    );
  });
});

// ─── 3. Sitemap hit with 5 locs ────────────────────────────────────────────

describe("v7-cli eval spec — sitemap.xml hit", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://localhost:PORT/blog/post-1</loc></url>
  <url><loc>http://localhost:PORT/blog/post-2</loc></url>
  <url><loc>http://localhost:PORT/blog/post-3</loc></url>
  <url><loc>http://localhost:PORT/docs/intro</loc></url>
  <url><loc>http://localhost:PORT/products/widget</loc></url>
</urlset>`;
    server = buildServer({
      "/sitemap.xml": { status: 200, body: sitemapXml.replace(/PORT/g, "PLACEHOLDER"), contentType: "application/xml" },
    });
    origin = `http://localhost:${server.port}`;
    // Patch the placeholder body now that we know the port.
    server.stop(true);
    server = buildServer({
      "/sitemap.xml": {
        status: 200,
        body: sitemapXml.replace(/PORT/g, String(server.port)),
        contentType: "application/xml",
      },
    });
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("parses 5 loc entries and groups by first path segment", async () => {
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 3000,
      includeGraphql: false,
    });
    const sitemapHit = result.hits.find((h) => h.source === "sitemap");
    expect(sitemapHit).toBeDefined();
    expect((sitemapHit as { loc_count: number }).loc_count).toBe(5);
    expect((sitemapHit as { loc_count_truncated: boolean }).loc_count_truncated).toBe(false);
    const tree = (sitemapHit as { path_tree: Record<string, number> }).path_tree;
    expect(tree["/blog/..."]).toBe(3);
    expect(tree["/docs/..."]).toBe(1);
    expect(tree["/products/..."]).toBe(1);
  });
});

// ─── 4. robots.txt → Sitemap: follow ───────────────────────────────────────

describe("v7-cli eval spec — robots.txt → sitemap follow", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    // We'll serve robots.txt pointing to /sitemap-foo.xml.
    // Build once with a placeholder port, then rebuild after we know the port.
    const stub = buildServer({});
    const port = stub.port;
    stub.stop(true);

    const robotsBody = `User-agent: *\nDisallow:\nSitemap: http://localhost:${port}/sitemap-foo.xml\n`;
    const sitemapBody = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://localhost:${port}/api/items</loc></url>
  <url><loc>http://localhost:${port}/api/users</loc></url>
</urlset>`;
    server = Bun.serve({
      port,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/robots.txt") {
          return new Response(robotsBody, { status: 200, headers: { "content-type": "text/plain" } });
        }
        if (url.pathname === "/sitemap-foo.xml") {
          return new Response(sitemapBody, { status: 200, headers: { "content-type": "application/xml" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("follows the Sitemap: directive in robots.txt", async () => {
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 3000,
      includeGraphql: false,
    });
    const sitemapHits = result.hits.filter((h) => h.source === "sitemap");
    expect(sitemapHits.length).toBeGreaterThanOrEqual(1);
    const fooHit = sitemapHits.find((h) => (h as { url: string }).url.includes("sitemap-foo.xml"));
    expect(fooHit).toBeDefined();
    expect((fooHit as { loc_count: number }).loc_count).toBe(2);
    // robots family should NOT be in misses (we got at least one hit from it).
    expect(result.misses).not.toContain("robots");
  });
});

// ─── 5. Slow probe respects 3s budget; other probes still complete ─────────

describe("v7-cli eval spec — slow probe times out, others succeed", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    // /openapi.json fast; /swagger.json slow (5s response, well past budget)
    const openapiBody = JSON.stringify({
      openapi: "3.0.0",
      paths: { "/v1/x": { get: { summary: "x", responses: {} } } },
    });
    const stub = buildServer({});
    const port = stub.port;
    stub.stop(true);

    server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/openapi.json") {
          return new Response(openapiBody, { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/swagger.json") {
          await new Promise((r) => setTimeout(r, 5000));
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("budget cuts the slow probe, fast probes return their hits", async () => {
    const t0 = Date.now();
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 1000, // tight to make the test fast
      includeGraphql: false,
    });
    const elapsedMs = Date.now() - t0;
    // The slow swagger probe should NOT block past ~1.5s total (parallel + tight budget).
    expect(elapsedMs).toBeLessThan(3000);
    expect(result.hits.find((h) => h.source === "openapi")).toBeDefined();
    expect(result.misses).toContain("swagger");
  });
});

// ─── 6. Cross-domain redirect refused ──────────────────────────────────────

describe("v7-cli eval spec — cross-domain redirect refused", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    server = buildServer({
      "/openapi.json": {
        status: 301,
        body: "",
        headers: { location: "https://evil.example.com/openapi.json" },
      },
    });
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("does not follow cross-host redirect and records openapi as miss", async () => {
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 3000,
      includeGraphql: false,
    });
    expect(result.hits.find((h) => h.source === "openapi")).toBeUndefined();
    expect(result.misses).toContain("openapi");
  });
});

// ─── 7. Large sitemap → cap at 10K + loc_count_truncated ───────────────────

describe("v7-cli eval spec — sitemap truncation at 10K", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    const locs: string[] = [];
    for (let i = 0; i < 15_000; i++) {
      locs.push(`  <url><loc>http://localhost:PORT/page/${i}</loc></url>`);
    }
    const stub = buildServer({});
    const port = stub.port;
    stub.stop(true);

    const sitemapBody =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${locs.join("\n").replace(/PORT/g, String(port))}\n</urlset>`;
    server = Bun.serve({
      port,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/sitemap.xml") {
          return new Response(sitemapBody, { status: 200, headers: { "content-type": "application/xml" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("caps at SITEMAP_LOC_CAP and flags loc_count_truncated", async () => {
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 5000,
      includeGraphql: false,
    });
    const sitemapHit = result.hits.find((h) => h.source === "sitemap");
    expect(sitemapHit).toBeDefined();
    expect((sitemapHit as { loc_count: number }).loc_count).toBe(SITEMAP_LOC_CAP);
    expect((sitemapHit as { loc_count_truncated: boolean }).loc_count_truncated).toBe(true);
  });
});

// ─── 8. GraphQL introspection opt-in semantics ─────────────────────────────

describe("v7-cli eval spec — graphql opt-in", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    const stub = buildServer({});
    const port = stub.port;
    stub.stop(true);

    const introspectionBody = JSON.stringify({
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: { name: "Mutation" },
          types: [
            { name: "Query", kind: "OBJECT" },
            { name: "User", kind: "OBJECT" },
            { name: "Post", kind: "OBJECT" },
            { name: "__Schema", kind: "OBJECT" }, // should be filtered
          ],
        },
      },
    });
    server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/graphql" && req.method === "POST") {
          return new Response(introspectionBody, { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("WITHOUT --graphql: not in hits and not in misses (silently skipped)", async () => {
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 3000,
      includeGraphql: false,
    });
    expect(result.hits.find((h) => h.source === "graphql")).toBeUndefined();
    expect(result.misses).not.toContain("graphql");
  });

  it("WITH --graphql: hits include type list with __-prefixed types filtered", async () => {
    const result = await runSpecDiscovery({
      origin,
      host: `localhost:${server.port}`,
      budgetMs: 3000,
      includeGraphql: true,
    });
    const gh = result.hits.find((h) => h.source === "graphql");
    expect(gh).toBeDefined();
    expect((gh as { query_type: string }).query_type).toBe("Query");
    expect((gh as { mutation_type: string }).mutation_type).toBe("Mutation");
    const types = (gh as { types: string[] }).types;
    expect(types).toContain("Query");
    expect(types).toContain("User");
    expect(types).toContain("Post");
    expect(types).not.toContain("__Schema");
  });
});

// ─── 9. CLI smoke — full subprocess end-to-end ─────────────────────────────

describe("v7-cli eval spec — CLI smoke", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    server = buildServer({
      "/openapi.json": {
        status: 200,
        body: JSON.stringify({
          openapi: "3.0.0",
          paths: { "/v1/things": { get: { summary: "list", responses: {} } } },
        }),
      },
    });
    origin = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("CLI invocation returns ok:true with the spec discovery row", async () => {
    const res = await runCli(["eval", "spec", origin, "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.subcommand).toBe("eval spec");
    expect(parsed.op_kind).toBe("eval:spec_discover");
    expect(parsed.domain).toBe(`localhost:${server.port}`);
    expect(parsed.hits.find((h: { source: string }) => h.source === "openapi")).toBeDefined();
  });

  it("--help prints the help envelope and exits 64", async () => {
    const res = await runCli(["eval", "spec", "--help", "--json"]);
    expect(res.code).toBe(64);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.help).toBe(true);
    expect(parsed.subcommand).toBe("eval spec");
    expect(parsed.op_kind).toBe("eval:spec_discover");
  });
});

// ─── 10. normalizeOrigin pure-function checks ──────────────────────────────

describe("v7-cli eval spec — normalizeOrigin", () => {
  it("accepts bare domain", () => {
    expect(normalizeOrigin("example.com")).toEqual({
      origin: "https://example.com",
      host: "example.com",
    });
  });
  it("accepts URL with path; strips path", () => {
    expect(normalizeOrigin("https://example.com/foo/bar?x=1")).toEqual({
      origin: "https://example.com",
      host: "example.com",
    });
  });
  it("rejects empty input", () => {
    expect(normalizeOrigin("")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(normalizeOrigin("not a url at all !!!!")).toBeNull();
  });
});
