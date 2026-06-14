/**
 * cross-skill-route-e2e.test — the cross-skill DAG suggestion across the real route.
 *
 * Two skills are cached: a PRODUCER (yields post::id) and a CONSUMER whose endpoint
 * requires `postId`. Executing the consumer WITHOUT postId (no session yield) must return
 * `cross_skill_producers` naming the producer skill+endpoint — the agent-actionable join.
 *
 * Live network (the consumer endpoint is a real GET) — skips when unreachable.
 */
import { describe, expect, it } from "bun:test";
import { getInProcessApp } from "../src/runtime/in-process-app.ts";
import { cachePublishedSkill } from "../src/client/index.js";
import type { SkillManifest } from "../src/types/index.js";

const producer = {
  skill_id: "xs-producer", version: "1.0.0", schema_version: "1", name: "blog",
  intent_signature: "create post", domain: "jsonplaceholder.typicode.com", description: "x",
  owner_type: "agent", execution_type: "http", lifecycle: "active",
  created_at: "2026-06-14T00:00:00Z", updated_at: "2026-06-14T00:00:00Z",
  endpoints: [{
    endpoint_id: "create_post", method: "POST", url_template: "https://jsonplaceholder.typicode.com/posts",
    idempotency: "unsafe",
    semantic: { action_kind: "write", resource_kind: "post", provides: [{ key: "id", source: "response", semantic_type: "resource_id" }] },
  }],
} as unknown as SkillManifest;

const consumer = {
  skill_id: "xs-consumer", version: "1.0.0", schema_version: "1", name: "comments",
  intent_signature: "list posts", domain: "jsonplaceholder.typicode.com", description: "x",
  owner_type: "agent", execution_type: "http", lifecycle: "active",
  created_at: "2026-06-14T00:00:00Z", updated_at: "2026-06-14T00:00:00Z",
  endpoints: [{
    endpoint_id: "list_posts", method: "GET", url_template: "https://jsonplaceholder.typicode.com/posts",
    idempotency: "safe",
    semantic: { action_kind: "fetch", resource_kind: "comment", requires: [{ key: "postId", required: true, source: "query" }] },
  }],
} as unknown as SkillManifest;

describe("cross-skill DAG suggestion through the execute route", () => {
  it("execute with an unfilled cross-skill hole returns cross_skill_producers naming the other skill", async () => {
    const app = await getInProcessApp();
    cachePublishedSkill(producer);
    cachePublishedSkill(consumer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/skills/xs-consumer/execute",
      headers: { "content-type": "application/json", "x-unbrowse-client-id": "xs-e2e" },
      payload: JSON.stringify({ params: { endpoint_id: "list_posts" }, projection: { raw: true } }),
    });

    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-json */ }
    if (/ENOTFOUND|ETIMEDOUT|execution_timeout/i.test(JSON.stringify(body)) && !body.cross_skill_producers) {
      console.warn("[xs-route-e2e] network unreachable, skipping");
      return;
    }

    const sugg = body.cross_skill_producers as Array<{ hole: string; producers: Array<{ skill_id: string; endpoint_id: string }> }> | undefined;
    expect(Array.isArray(sugg)).toBe(true);
    const postIdSugg = sugg!.find((s) => s.hole === "postId");
    expect(postIdSugg).toBeDefined();
    expect(postIdSugg!.producers.some((p) => p.skill_id === "xs-producer" && p.endpoint_id === "create_post")).toBe(true);
  }, 60_000);
});
