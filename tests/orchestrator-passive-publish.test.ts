import { afterEach, describe, expect, it } from "bun:test";
import { queuePassiveSkillPublish, resetPassivePublishQueueForTests } from "../src/orchestrator/passive-publish.js";

describe("passive skill publish", () => {
  afterEach(() => {
    resetPassivePublishQueueForTests();
  });

  it("publishes only HTTP endpoints while preserving local-only endpoints in cache", async () => {
    const cached: any[] = [];
    const published: any[] = [];
    const validated: any[] = [];
    const skill = {
      skill_id: "skill-1",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      name: "example.com",
      intent_signature: "search example",
      domain: "example.com",
      description: "API skill for example.com",
      owner_type: "agent",
      intents: ["search example"],
      operation_graph: { operations: [{ operation_id: "op-http", endpoint_id: "ep-http" }], edges: [] },
      endpoints: [
        {
          endpoint_id: "ep-http",
          method: "GET",
          url_template: "https://example.com/api/search?q={q}",
          idempotency: "safe",
          verification_status: "pending",
          reliability_score: 0.5,
          description: "local desc",
        },
        {
          endpoint_id: "ep-ws",
          method: "WS",
          url_template: "wss://example.com/socket",
          idempotency: "safe",
          verification_status: "pending",
          reliability_score: 0.5,
          description: "socket desc",
        },
      ],
    } as any;

    await queuePassiveSkillPublish(skill, {
      deps: {
        cachePublishedSkill: (cachedSkill) => {
          cached.push(cachedSkill);
        },
        publishSkill: async (draft) => {
          published.push(draft);
          return {
            ...draft,
            updated_at: "2026-03-23T00:01:00.000Z",
            endpoints: [
              {
                ...draft.endpoints[0],
                description: "backend desc",
              },
            ],
          } as any;
        },
        validateManifest: async (manifest) => {
          validated.push(manifest);
          return { valid: true, hardErrors: [], softWarnings: [] };
        },
      },
    });

    expect(validated).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0].endpoints).toHaveLength(1);
    expect(published[0].endpoints[0].endpoint_id).toBe("ep-http");
    expect(cached).toHaveLength(1);
    expect(cached[0].operation_graph).toEqual(skill.operation_graph);
    expect(cached[0].endpoints).toHaveLength(2);
    expect(cached[0].endpoints[0].description).toBe("backend desc");
    expect(cached[0].endpoints[1].description).toBe("socket desc");
  });

  it("deduplicates concurrent background publishes for the same skill", async () => {
    let publishCalls = 0;
    let releasePublish!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const skill = {
      skill_id: "skill-2",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      name: "example.com",
      intent_signature: "search example",
      domain: "example.com",
      description: "API skill for example.com",
      owner_type: "agent",
      intents: ["search example"],
      operation_graph: { operations: [], edges: [] },
      endpoints: [
        {
          endpoint_id: "ep-http",
          method: "GET",
          url_template: "https://example.com/api/search?q={q}",
          idempotency: "safe",
          verification_status: "pending",
          reliability_score: 0.5,
        },
      ],
    } as any;

    const deps = {
      cachePublishedSkill: () => {},
      publishSkill: async (draft: any) => {
        publishCalls += 1;
        await gate;
        return draft;
      },
      validateManifest: async () => ({ valid: true, hardErrors: [], softWarnings: [] }),
    };

    const first = queuePassiveSkillPublish(skill, { deps });
    const second = queuePassiveSkillPublish(skill, { deps });

    expect(first).toBe(second);
    await Promise.resolve();
    await Promise.resolve();
    expect(publishCalls).toBe(1);

    releasePublish();
    await Promise.all([first, second]);
  });

  it("skips publish when background parity fails", async () => {
    const cached: any[] = [];
    const published: any[] = [];
    const skill = {
      skill_id: "skill-3",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      name: "example.com",
      intent_signature: "search example",
      domain: "example.com",
      description: "API skill for example.com",
      owner_type: "agent",
      intents: ["search example"],
      operation_graph: { operations: [], edges: [] },
      endpoints: [
        {
          endpoint_id: "ep-http",
          method: "GET",
          url_template: "https://example.com/api/search?q={q}",
          idempotency: "safe",
          verification_status: "pending",
          reliability_score: 0.5,
        },
      ],
    } as any;

    await queuePassiveSkillPublish(skill, {
      parity: Promise.resolve("fail"),
      deps: {
        cachePublishedSkill: (cachedSkill) => {
          cached.push(cachedSkill);
        },
        publishSkill: async (draft) => {
          published.push(draft);
          return draft as any;
        },
        validateManifest: async () => ({ valid: true, hardErrors: [], softWarnings: [] }),
      },
    });

    expect(published).toHaveLength(0);
    expect(cached).toHaveLength(0);
  });
});
