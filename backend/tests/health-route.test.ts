import { describe, expect, it } from "bun:test";
import app from "../src/index.js";
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
};

describe("health route", () => {
  it("reports EmergentDB when DATABASE_URL is unset", async () => {
    const res = await app.fetch(new Request("http://local.test/health"), baseEnv);
    const data = await res.json() as { storage_backend?: string };

    expect(res.status).toBe(200);
    expect(data.storage_backend).toBe("emergentdb");
  });

  it("reports Postgres when DATABASE_URL is configured", async () => {
    const res = await app.fetch(
      new Request("http://local.test/health"),
      { ...baseEnv, DATABASE_URL: "postgres://test" },
    );
    const data = await res.json() as { storage_backend?: string };

    expect(res.status).toBe(200);
    expect(data.storage_backend).toBe("postgres");
  });
});
