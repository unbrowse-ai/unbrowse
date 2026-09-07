/**
 * validate-route-mounted.test — regression for the unmounted /v1/validate route.
 *
 * publicValidateRoutes (POST /v1/validate — self-improvement manifest validation) was imported in
 * index.ts but never mounted, so the shipped client's validation call 404'd and silently
 * "proceeded unvalidated". Surfaced by the 9.0.5 webagent write probe. This asserts the route is
 * reachable — any status BUT 404 proves the mount (the handler may 400/422/200 on the body; what
 * the regression guards is that the router knows the path at all).
 */
import { describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
} as unknown as Env;

async function postValidate(body: unknown): Promise<Response> {
  return app.fetch(
    new Request("http://local.test/v1/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    baseEnv,
  );
}

describe("POST /v1/validate is mounted (was imported-but-unmounted)", () => {
  it("does not 404 — the router knows the path", async () => {
    const res = await postValidate({ skill_id: "sk_test", endpoints: [] });
    expect(res.status).not.toBe(404);
  });
});
