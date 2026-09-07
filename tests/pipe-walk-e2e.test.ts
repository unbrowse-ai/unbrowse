/**
 * pipe-walk-e2e.test — the write→hole pipe end-to-end through REAL executeSkill.
 *
 * A write to jsonplaceholder yields {id:101}; executeEndpoint backfills the endpoint's
 * semantic.provides from the response; we record those yields and prove a downstream
 * op's `requires:[id]` hole auto-fills from the session store. This is the in-process
 * flow the execute route now wires (MCP session); the stateless CLI is process-scoped.
 *
 * Live network test — skips when jsonplaceholder is unreachable.
 */
import { describe, expect, it } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import {
  recordYields,
  fillHolesFromYields,
  type YieldStore,
} from "../src/runtime/yield-store.js";
import type { SkillManifest } from "../src/types/index.js";

const writeSkill = {
  skill_id: "sk_jph_write",
  version: "1.0.0",
  schema_version: "1",
  name: "jsonplaceholder.typicode.com",
  intent_signature: "create a post",
  domain: "jsonplaceholder.typicode.com",
  description: "create post",
  owner_type: "agent",
  execution_type: "http",
  lifecycle: "active",
  created_at: "2026-06-14T00:00:00.000Z",
  updated_at: "2026-06-14T00:00:00.000Z",
  endpoints: [
    {
      endpoint_id: "create_post",
      method: "POST",
      url_template: "https://jsonplaceholder.typicode.com/posts",
      idempotency: "unsafe",
      body: { title: "hello", userId: 1 },
    },
  ],
} as unknown as SkillManifest;

describe("pipe-walk end-to-end (write provides → session store → downstream hole)", () => {
  it("a write's yielded id auto-fills a later op's requires hole", async () => {
    const store: YieldStore = new Map();
    const scope = "jsonplaceholder.typicode.com";
    const sid = "sess-e2e";

    let result: Awaited<ReturnType<typeof executeSkill>>;
    try {
      result = await executeSkill(writeSkill, { endpoint_id: "create_post" }, undefined, { confirm_unsafe: true } as never);
    } catch (e) {
      console.warn("[pipe-walk-e2e] live network unavailable, skipping:", (e as Error).message);
      return;
    }
    if (!result?.trace?.success) {
      console.warn("[pipe-walk-e2e] write did not succeed (network?), skipping");
      return;
    }

    // executeEndpoint backfilled provides on the endpoint from the response
    const ep = (writeSkill.endpoints[0] as Record<string, any>);
    const provides = ep.semantic?.provides;
    expect(Array.isArray(provides)).toBe(true);
    expect(provides.some((b: any) => b.key === "id")).toBe(true);

    // CAPTURE: record the write's yields (what the route does on success)
    const n = recordYields(sid, provides, { store, scope });
    expect(n).toBeGreaterThan(0);

    // FILL: a downstream op needs {id}; it was left empty → auto-filled from the yield
    const downstreamParams: Record<string, unknown> = {};
    const { filled } = fillHolesFromYields(
      sid,
      [{ key: "id", required: true, source: "body" }],
      downstreamParams,
      { store, scope },
    );
    expect(filled).toEqual(["id"]);
    // The pipe carries the binding's value. OperationBinding.example_value is typed
    // `string` by contract, so the id flows as "101" (string), not the number 101.
    // This is faithful for path params (/posts/101) and most bodies; strict
    // numeric-typed APIs are a documented fidelity limit (future: a typed yield).
    expect(String(downstreamParams.id)).toBe("101");
  }, 60_000);
});
