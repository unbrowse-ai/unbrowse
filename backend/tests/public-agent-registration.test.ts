import { describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { CURRENT_TOS_VERSION } from "../src/tos.js";

const env: Env = {
  API_KEY: "local-test",
  UNKEY_ROOT_KEY: "local-test",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

describe("public agent registration", () => {
  it("serves tos metadata without auth", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/tos/current"), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: CURRENT_TOS_VERSION,
      url: "https://unbrowse.ai/terms",
    });
  });

  it("registers without auth and auto-accepts current tos", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Codex Smoke",
      }),
    }), env);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      agent_id: "__admin__",
      api_key: "local-test",
      tos_accepted_version: CURRENT_TOS_VERSION,
    });
  });

  it("still protects write-only stats routes", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/stats/execution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }), env);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: "Missing or invalid Authorization header",
    });
  });
});
