import { afterEach, describe, expect, it } from "bun:test";
import { __resetNeonForTests, __setNeonFactoryForTests, getNeonClient } from "../src/services/neon.js";
import { PgKV } from "../src/services/pg-kv.js";

afterEach(() => {
  __resetNeonForTests();
});

describe("Neon-backed KV reliability", () => {
  it("retries initialization after a transient bootstrap failure", async () => {
    let createTableAttempts = 0;

    const sql = Object.assign(
      async (strings: TemplateStringsArray): Promise<unknown[]> => {
        const query = strings.join(" ").replace(/\s+/g, " ").trim();
        if (query.includes("CREATE TABLE IF NOT EXISTS app_kv")) {
          createTableAttempts += 1;
          if (createTableAttempts === 1) {
            throw new Error("transient bootstrap failure");
          }
        }
        return [];
      },
      {
        transaction: async (queries: unknown[]) => queries,
      },
    );

    __setNeonFactoryForTests((() => sql) as unknown as typeof import("@neondatabase/serverless").neon);

    await expect(getNeonClient("postgres://test")).rejects.toThrow("transient bootstrap failure");
    await expect(getNeonClient("postgres://test")).resolves.toBe(sql);
    expect(createTableAttempts).toBe(2);
  });

  it("uses a transaction for batch writes", async () => {
    const transactionCalls: unknown[][] = [];

    const sql = Object.assign(
      async (): Promise<unknown[]> => [],
      {
        transaction: async (queries: unknown[]) => {
          transactionCalls.push(queries);
          return [];
        },
      },
    );

    __setNeonFactoryForTests((() => sql) as unknown as typeof import("@neondatabase/serverless").neon);

    const kv = new PgKV("postgres://test", "stats");
    await kv.putBatch([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);

    expect(transactionCalls).toHaveLength(1);
    expect(transactionCalls[0]).toHaveLength(2);
  });
});
