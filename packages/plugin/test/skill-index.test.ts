import { afterEach, describe, expect, it } from "bun:test";

import { SkillIndexClient } from "@getfoundry/unbrowse-core";

type FetchType = typeof fetch;
const originalFetch: FetchType = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SkillIndexClient", () => {
  it("search maps alternate response shapes returned by the index API", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      results: [{ skillId: "skill_123", name: "trustmrr", downloadCount: 3 }],
      total: 1,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as FetchType;

    const client = new SkillIndexClient({ indexUrl: "https://index.example" });
    const out = await client.search(" trustmrr ", { limit: 10 });

    expect(out.total).toBe(1);
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0]?.skillId).toBe("skill_123");
  });

  it("download falls back to /marketplace/skills/:id/download when legacy endpoint returns 404", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("/marketplace/skill-downloads/")) {
        return new Response("not found", { status: 404 });
      }

      if (url.includes("/marketplace/skills/") && url.endsWith("/download")) {
        return new Response(JSON.stringify({
          skill: {
            skillId: "skill_123",
            name: "trustmrr",
            description: "ShipFast metrics",
            skillMd: "# trustmrr",
            scripts: {},
            references: {},
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("unexpected", { status: 500 });
    }) as FetchType;

    const client = new SkillIndexClient({ indexUrl: "https://index.example" });
    const pkg = await client.download("skill_123");

    expect(pkg.name).toBe("trustmrr");
    expect(calls[0]).toContain("/marketplace/skill-downloads/skill_123");
    expect(calls[1]).toContain("/marketplace/skills/skill_123/download");
  });
});
