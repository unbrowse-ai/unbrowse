import { describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { CURRENT_TOS_VERSION } from "../src/tos.js";

const env: Env = {
  API_KEY: "local-test",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
};

describe("local worker registration", () => {
  it("returns the admin key when local admin registration is enabled", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "local-worker@example.com",
        tos_version: CURRENT_TOS_VERSION,
      }),
    }), env);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      agent_id: "__admin__",
      api_key: "local-test",
    });
  });
});
