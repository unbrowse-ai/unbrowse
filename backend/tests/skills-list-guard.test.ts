// skillsListAuthGuard is GET-scoped: it gates the GET list dump (anti 30MB-dump) but
// must NOT shadow POST/PATCH /skills (the bearer-optional publish/contribution routes
// handled by skillRoutes with indexContributorAuth). Regression test for the live bug
// where POST /v1/skills 401'd before reaching indexContributorAuth.
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { skillsListAuthGuard } from "../src/routes/skills.js";

function makeApp() {
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/skills", skillsListAuthGuard as any);
  app.all("/skills", (c) => c.json({ reached: true }));
  return app;
}

describe("skillsListAuthGuard — GET-scoped, does not shadow publish", () => {
  it("POST passes through (no 401 — publish reaches indexContributorAuth downstream)", async () => {
    const res = await makeApp().request("/skills", { method: "POST" }, {} as never);
    expect(res.status).toBe(200);
    expect((await res.json()).reached).toBe(true);
  });

  it("PATCH passes through too", async () => {
    const res = await makeApp().request("/skills", { method: "PATCH" }, {} as never);
    expect(res.status).toBe(200);
  });

  it("GET with no bearer is still gated (the 30MB-dump guard stays)", async () => {
    const res = await makeApp().request("/skills", { method: "GET" }, {} as never);
    expect(res.status).toBe(401);
  });
});
