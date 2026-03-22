import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { rateLimit } from "../src/middleware/rate-limit.js";
import type { Env } from "../src/types.js";

const env: Env = {
  API_KEY: "local-test",
  UNKEY_ROOT_KEY: "local-test",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/limited", rateLimit({ limit: 1, window: 60, prefix: `test-${crypto.randomUUID()}` }));
  app.post("/limited", (c) => c.json({ ok: true }));
  return app;
}

describe("public rate limit identity", () => {
  it("still limits anonymous requests by IP", async () => {
    const app = makeApp();
    const first = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), env);
    const second = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("uses bearer tokens as a separate bucket from anonymous traffic", async () => {
    const app = makeApp();
    const anonymous = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.11" },
    }), env);
    const authed = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.11",
        Authorization: "Bearer staging-eval",
      },
    }), env);

    expect(anonymous.status).toBe(200);
    expect(authed.status).toBe(200);
  });

  it("still limits repeated bearer-token traffic in the same bucket", async () => {
    const app = makeApp();
    const first = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.12",
        Authorization: "Bearer normal-eval",
      },
    }), env);
    const second = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.99",
        Authorization: "Bearer normal-eval",
      },
    }), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("bypasses staging-eval token traffic in staging only", async () => {
    const app = makeApp();
    const first = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.13",
        Authorization: "Bearer staging-eval",
      },
    }), env);
    const second = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.14",
        Authorization: "Bearer staging-eval",
      },
    }), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("does not bypass non-staging environments", async () => {
    const app = makeApp();
    const prodEnv: Env = { ...env, ENVIRONMENT: "production" };
    const first = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.15",
        Authorization: "Bearer staging-eval",
      },
    }), prodEnv);
    const second = await app.fetch(new Request("http://local.test/limited", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.16",
        Authorization: "Bearer staging-eval",
      },
    }), prodEnv);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});
