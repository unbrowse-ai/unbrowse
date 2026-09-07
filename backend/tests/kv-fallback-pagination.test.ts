import { describe, expect, it } from "bun:test";
import { EdbKV, FallbackKV } from "../src/services/kv.js";

describe("FallbackKV Cloudflare pagination", () => {
  it("reads every page when the primary is cold/empty", async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => ({ name: `stats:analytics:session:mcp-seed:seed:${i}` }));
    let pages = 0;
    const cf = {
      list: async ({ cursor }: { cursor?: string }) => {
        pages++;
        const offset = cursor ? Number(cursor) : 0;
        const keys = rows.slice(offset, offset + 500);
        const next = offset + keys.length;
        return { keys, list_complete: next >= rows.length, cursor: next >= rows.length ? undefined : String(next) };
      },
      get: async (name: string) => JSON.stringify({ name }),
      put: async () => {}, delete: async () => {}, getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace;
    const primary = new EdbKV("test", "stats");
    primary.listWithValues = async () => [];
    const kv = new FallbackKV(primary, cf, "stats");
    const result = await kv.listWithValues("analytics:session:mcp-seed:seed:");
    expect(result).toHaveLength(1201);
    expect(pages).toBe(3);
    expect(result.at(-1)?.key).toBe("analytics:session:mcp-seed:seed:1200");
  });
});
