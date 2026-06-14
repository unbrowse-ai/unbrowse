/**
 * pipe-walk-route-e2e.test — DOMINION: the pipe across the real HTTP seam.
 *
 * Two sequential POST /v1/skills/:id/execute calls in ONE process sharing a session_id.
 * Call 1 is an agent-native write (ad-hoc, jsonplaceholder); the route's CAPTURE wiring
 * records its yielded id into the session store. We then assert the yield is visible to
 * the session (the in-process firmament holds across real HTTP calls) — the full caller
 * path: HTTP request → executeSkill → provides backfill → recordYields → session store.
 *
 * Live network — skips when jsonplaceholder is unreachable.
 */
import { describe, expect, it } from "bun:test";
import { getInProcessApp } from "../src/runtime/in-process-app.ts";
import { getYieldCache, fillHolesFromYields, clearSessionYields } from "../src/runtime/yield-store.js";

describe("DOMINION: write→yield captured across the real execute route", () => {
  it("an ad-hoc write through the HTTP route records its id into the session yield store", async () => {
    const app = await getInProcessApp();
    const session_id = "dominion-e2e";
    clearSessionYields(session_id); // start clean (module store)

    const res = await app.inject({
      method: "POST",
      url: "/v1/skills/adhoc-write-dominion/execute",
      headers: { "content-type": "application/json", "x-unbrowse-client-id": "dominion-e2e" },
      payload: JSON.stringify({
        method: "POST",
        context_url: "https://jsonplaceholder.typicode.com/posts",
        params: { url: "https://jsonplaceholder.typicode.com/posts", body: { title: "dom", userId: 1 } },
        confirm_unsafe: true,
        session_id,
        projection: { raw: true },
      }),
    });

    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-json */ }
    const blob = JSON.stringify(body);
    if (/ENOTFOUND|ETIMEDOUT|cli_timeout|network|execution_timeout/i.test(blob) && !/"id"/.test(blob)) {
      console.warn("[dominion-e2e] jsonplaceholder unreachable, skipping:", blob.slice(0, 160));
      return;
    }

    const success = (body.trace as Record<string, unknown> | undefined)?.success;
    expect(success).toBe(true);

    // CAPTURE seam: the route recorded the write's yielded id into the session store,
    // scoped by the producer host. Verify via the PUBLIC consume path (not the internal
    // key format): a downstream hole keyed `id`, same host scope, auto-fills from it.
    expect(getYieldCache(session_id)).toBeDefined();
    const downstream: Record<string, unknown> = {};
    const { filled } = fillHolesFromYields(
      session_id,
      [{ key: "id", required: true, source: "body" }],
      downstream,
      { scope: "jsonplaceholder.typicode.com" },
    );
    expect(filled).toEqual(["id"]);
    expect(String(downstream.id)).toBe("101");

    clearSessionYields(session_id);
  }, 60_000);
});
