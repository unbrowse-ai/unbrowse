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

  // Storage is IQ-only since the Neon->IQ migration (src/services/kv.ts:614
  // "Legacy Postgres/PgKV removed in the Neon->IQ migration."). DATABASE_URL /
  // USE_PGKV are dead inputs (not on Env, read nowhere), so EmergentDB wins
  // regardless. This test was pinned to "postgres" back when Postgres was the
  // backend (310014f7) and was never updated when Postgres was removed.
  it("stays on EmergentDB even when legacy Postgres env vars are present", async () => {
    const res = await app.fetch(
      new Request("http://local.test/health"),
      { ...baseEnv, DATABASE_URL: "postgres://test", USE_PGKV: "1" } as Env,
    );
    const data = await res.json() as { storage_backend?: string };

    expect(res.status).toBe(200);
    expect(data.storage_backend).toBe("emergentdb");
  });
});
