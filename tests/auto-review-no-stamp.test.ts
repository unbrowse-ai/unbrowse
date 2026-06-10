import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression: auto_review publishes must NOT forge a `reviewed_at` stamp.
 * `reviewed_at` is provenance — it records that an actual unbrowse_review
 * happened. The auto_review door of shouldPublishAfterIndex publishes
 * unstamped manifests; the marketplace sees honestly-unreviewed skills.
 *
 * Drives the REAL background job (processIndexJob) end-to-end against a
 * local mock marketplace and asserts the wire payload carries no stamp.
 *
 * The pipeline runs in a SUBPROCESS: src/client/index.ts freezes
 * UNBROWSE_BACKEND_URL / UNBROWSE_LOCAL_ONLY at module load, so importing
 * it here in network mode would poison every later test file in this bun
 * process (they expect LOCAL_ONLY). The mock server lives in this process;
 * only the child sees the network-mode env.
 */

const REPO = join(import.meta.dir, "..");

let dir: string;
let server: ReturnType<typeof Bun.serve>;
const published: Array<Record<string, unknown>> = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "auto-review-no-stamp-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/validate") {
        return Response.json({ valid: true, hardErrors: [], softWarnings: [] });
      }
      if (url.pathname === "/v1/skills" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        published.push(body);
        const now = new Date().toISOString();
        return Response.json({ ...body, skill_id: "srv-skill-1", version: "1.0.0", created_at: now, updated_at: now, warnings: [] });
      }
      return Response.json({ ok: true });
    },
  });

  // Fully opted in: share_pointers + auto_review (the defaults, made explicit).
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ contribution: { share_pointers: true, auto_review: true } }),
  );

  writeFileSync(join(dir, "driver.ts"), `
    const { _processIndexJobForCli } = await import(${JSON.stringify(join(REPO, "src/indexer/index.ts"))});
    const job = {
      skill: {
        skill_id: "no-stamp-skill",
        domain: "no-stamp-test.com",
        intent_signature: "list items",
        intents: ["list items"],
        endpoints: [
          {
            endpoint_id: "no-stamp-ep1",
            method: "GET",
            url_template: "https://no-stamp-test.com/api/v1/items",
            description: "List items in the catalog",
            idempotency: "safe",
            verification_status: "verified",
            reliability_score: 0.95,
            response_schema: { type: "object", fields: { items: "array" } },
            // Schema-grounded auto semantics: publishable without endpoint review.
            semantic: {
              description_out: "List items in the catalog",
              description_source: "auto",
              example_fields: ["id", "name"],
              response_summary: "id, name",
            },
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: "1.0.0",
      },
      domain: "no-stamp-test.com",
      intent: "list items",
      cacheKey: "no-stamp-key",
      publishAfterIndex: true,
    };
    await _processIndexJobForCli(job);
    console.log("RESULT:" + JSON.stringify({ reviewed_at: job.skill.reviewed_at ?? null }));
  `);
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("auto_review publish carries no reviewed_at stamp", () => {
  it("publishes through the auto_review door with reviewed_at unset on the wire and locally", async () => {
    const proc = Bun.spawn(["bun", "run", join(dir, "driver.ts")], {
      cwd: REPO,
      env: {
        ...process.env,
        UNBROWSE_CONFIG_DIR: dir,
        UNBROWSE_CONFIG_PATH: join(dir, "config.json"),
        UNBROWSE_SKILL_SNAPSHOT_DIR: join(dir, "snapshots"),
        UNBROWSE_BACKEND_URL: `http://127.0.0.1:${server.port}`,
        UNBROWSE_LOCAL_ONLY: undefined as unknown as string,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    // The auto_review door opened (no review happened) …
    expect(stderr).toContain("auto_review — publishing no-stamp-skill");
    // … it DID publish …
    expect(published.length).toBe(1);
    // … but the manifest that crossed the wire is honestly unreviewed.
    expect(published[0].reviewed_at).toBeUndefined();
    // And the in-memory job skill was not retro-stamped either.
    expect(stdout).toContain('RESULT:{"reviewed_at":null}');
  });
});
