/**
 * Hono router e2e for /v1/contract/* — proves the routes the Worker
 * actually serves respond with the documented wire shapes. Goes one
 * step beyond the thin-client foundation test (which exercised the
 * typed handlers directly); here we hit the mounted Hono router via
 * app.fetch(), the exact path a real HTTP client would take.
 *
 * Persistence is ephemeral (per-request in-memory ledger) by design at
 * this stage — a durable KV/D1 binding is the next layer (organ
 * ddff0c96 stage D). The wire IS real; the persistence is a TODO.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { contractRoutes } from "../src/routes/contract";

function mountApp() {
  const app = new Hono();
  app.route("/v1", contractRoutes);
  return app;
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

async function getJson(app: Hono, path: string) {
  const res = await app.fetch(new Request(`http://test.local${path}`));
  return { status: res.status, json: await res.json() };
}

describe("/v1/contract/* — wired Hono router", () => {
  test("GET /v1/contract/tools advertises the route surface", async () => {
    const app = mountApp();
    const { status, json } = await getJson(app, "/v1/contract/tools");
    expect(status).toBe(200);
    expect((json as any).routes).toBeArray();
    expect((json as any).routes.length).toBeGreaterThanOrEqual(5);
    expect((json as any).local_capabilities).toEqual([
      "kuri",
      "cookies",
      "vault",
      "browser",
      "fs",
    ]);
  });

  test("POST /v1/contract/declare returns a typed declared row", async () => {
    const app = mountApp();
    const { status, json } = await postJson(app, "/v1/contract/declare", {
      plan: "wired router smoke test",
      action: "agent-judges",
    });
    expect(status).toBe(200);
    const body = json as { id: string; row: { event: string; plan: string; pointer_type: string } };
    expect(body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.row.event).toBe("declared");
    expect(body.row.plan).toBe("wired router smoke test");
    expect(body.row.pointer_type).toBe("agent-judges");
  });

  test("POST /v1/contract/declare rejects malformed bodies (no plan)", async () => {
    const app = mountApp();
    const { status, json } = await postJson(app, "/v1/contract/declare", {
      action: "agent-judges",
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toContain("plan");
  });

  test("GET /v1/contract/status?id=<unknown> returns 200 pending (no events yet)", async () => {
    // projectStatus treats an id with zero events as "pending" — same
    // logic as a freshly-declared contract that hasn't iterated yet.
    // The wire returns a structured response, not an error.
    const app = mountApp();
    const { status, json } = await getJson(app, "/v1/contract/status?id=ffffffff");
    expect(status).toBe(200);
    const body = json as { id: string; status: string; rows: unknown[] };
    expect(body.id).toBe("ffffffff");
    expect(body.status).toBe("pending");
    expect(body.rows).toEqual([]);
  });

  test("POST /v1/contract/plan-for-intent validates intent is required", async () => {
    const app = mountApp();
    const { status, json } = await postJson(app, "/v1/contract/plan-for-intent", {});
    expect(status).toBe(400);
    expect((json as { error: string }).error).toContain("intent");
  });
});
