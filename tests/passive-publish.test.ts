import { describe, test, expect } from "bun:test";
import type { SkillManifest } from "../src/types/skill.js";
import {
  queuePassiveSkillPublish,
  resetPassivePublishQueueForTests,
  type PassiveParityVerdict,
} from "../src/orchestrator/passive-publish.js";

/** Minimal SkillManifest for tests. */
function makeSkill(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "test-skill-1",
    version: "1.0.0",
    schema_version: "1",
    name: "Test Skill",
    intent_signature: "search for widgets",
    domain: "example.com",
    description: "Test skill description",
    owner_type: "community",
    execution_type: "http",
    endpoints: [
      {
        endpoint_id: "ep-1",
        method: "GET",
        url_template: "https://example.com/api/widgets?q={query}",
        description: "Search widgets",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        response_schema: {
          type: "object",
          properties: {
            items: { type: "array" },
          },
        },
        semantic: {
          action_kind: "search",
          resource_kind: "widget",
          example_fields: ["items[].id"],
        },
      },
    ],
    lifecycle: { status: "active" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as SkillManifest;
}

describe("#233 passive skill publish", () => {
  test("publishes a valid http skill and caches it", async () => {
    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];
    const cached: SkillManifest[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: draft.skill_id ?? "pub-1", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (skill: SkillManifest) => { cached.push(skill); },
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    const promise = queuePassiveSkillPublish(skill, { deps });
    await promise;

    expect(published.length).toBe(1);
    expect(published[0]!.skill_id).toBe("test-skill-1");
    expect(cached.length).toBe(1);
  });

  test("skips publish when parity verdict is 'fail'", async () => {
    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: "pub-2", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    const promise = queuePassiveSkillPublish(skill, {
      deps,
      parity: "fail" as PassiveParityVerdict,
    });
    await promise;

    expect(published.length).toBe(0);
  });

  test("publishes when parity verdict is 'pass'", async () => {
    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: "pub-3", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    const promise = queuePassiveSkillPublish(skill, {
      deps,
      parity: "pass" as PassiveParityVerdict,
    });
    await promise;

    expect(published.length).toBe(1);
  });

  test("publishes when parity is undefined (no baseline available)", async () => {
    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: "pub-4", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    const promise = queuePassiveSkillPublish(skill, { deps });
    await promise;

    expect(published.length).toBe(1);
  });

  test("resolves async parity function", async () => {
    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: "pub-5", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    const promise = queuePassiveSkillPublish(skill, {
      deps,
      parity: async () => "fail" as PassiveParityVerdict,
    });
    await promise;

    expect(published.length).toBe(0);
  });

  test("skips non-http execution types", async () => {
    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: "pub-6", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill({ execution_type: "browser" as any });
    const promise = queuePassiveSkillPublish(skill, { deps });
    await promise;

    expect(published.length).toBe(0);
  });

  test("skips when validation fails", async () => {
    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: "pub-7", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: false, hardErrors: ["bad schema"], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    const promise = queuePassiveSkillPublish(skill, { deps });
    await promise;

    expect(published.length).toBe(0);
  });

  test("deduplicates concurrent publishes for same skill_id", async () => {
    resetPassivePublishQueueForTests();
    let publishCount = 0;

    const deps = {
      publishSkill: async (draft: any) => {
        publishCount++;
        await new Promise((r) => setTimeout(r, 50));
        return { ...draft, skill_id: draft.skill_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    const p1 = queuePassiveSkillPublish(skill, { deps });
    const p2 = queuePassiveSkillPublish(skill, { deps });

    expect(p1).toBe(p2); // same promise returned
    await p1;

    expect(publishCount).toBe(1);
  });

  test("filters out WS endpoints before publishing", async () => {
    resetPassivePublishQueueForTests();
    let publishedEndpoints: any[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        publishedEndpoints = draft.endpoints;
        return { ...draft, skill_id: draft.skill_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill({
      endpoints: [
        {
          endpoint_id: "ep-http",
          method: "GET",
          url_template: "https://example.com/api/data",
          description: "HTTP endpoint",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
          response_schema: {
            type: "object",
            properties: {
              data: { type: "array" },
            },
          },
        },
        {
          endpoint_id: "ep-ws",
          method: "WS" as any,
          url_template: "wss://example.com/ws",
          description: "WebSocket endpoint",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
        },
      ],
    });

    await queuePassiveSkillPublish(skill, { deps });

    expect(publishedEndpoints.length).toBe(1);
    expect(publishedEndpoints[0]!.endpoint_id).toBe("ep-http");
  });

  test("skips publish when all endpoints are WS", async () => {
    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];

    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: draft.skill_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill({
      endpoints: [
        {
          endpoint_id: "ep-ws",
          method: "WS" as any,
          url_template: "wss://example.com/ws",
          description: "WebSocket endpoint",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
        },
      ],
    });

    await queuePassiveSkillPublish(skill, { deps });
    expect(published.length).toBe(0);
  });

  test("does not throw when publishSkill rejects — fire and forget", async () => {
    resetPassivePublishQueueForTests();

    const deps = {
      publishSkill: async (_draft: any) => { throw new Error("network timeout"); },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    // Should not throw
    const promise = queuePassiveSkillPublish(skill, { deps });
    await promise;
    // If we got here, the error was swallowed correctly
  });

  test("merges backend descriptions into cached skill", async () => {
    resetPassivePublishQueueForTests();
    let cachedSkill: SkillManifest | null = null;

    const deps = {
      publishSkill: async (draft: any) => {
        return {
          ...draft,
          skill_id: draft.skill_id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: "1.0.0",
          endpoints: draft.endpoints.map((ep: any) => ({
            ...ep,
            description: `Backend: ${ep.description}`,
          })),
        } as SkillManifest;
      },
      cachePublishedSkill: (skill: SkillManifest) => { cachedSkill = skill; },
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill();
    await queuePassiveSkillPublish(skill, { deps });

    expect(cachedSkill).not.toBeNull();
    expect(cachedSkill!.endpoints[0]!.description).toBe("Backend: Search widgets");
  });

  test("preserves operation_graph in cached skill", async () => {
    resetPassivePublishQueueForTests();
    let cachedSkill: SkillManifest | null = null;

    const opGraph = {
      operations: [{ operation_id: "op-1", endpoint_id: "ep-1", method: "GET" as const, url_pattern: "https://example.com/api/widgets" }],
      edges: [],
      version: 1,
    };

    const deps = {
      publishSkill: async (draft: any) => {
        return {
          ...draft,
          skill_id: draft.skill_id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: "1.0.0",
        } as SkillManifest;
      },
      cachePublishedSkill: (skill: SkillManifest) => { cachedSkill = skill; },
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill({ operation_graph: opGraph as any });
    await queuePassiveSkillPublish(skill, { deps });

    expect(cachedSkill).not.toBeNull();
    expect(cachedSkill!.operation_graph).toBeDefined();
    expect(cachedSkill!.operation_graph!.operations.length).toBe(1);
  });

  test("preserves auth_profile_ref in cached skill", async () => {
    resetPassivePublishQueueForTests();
    let cachedSkill: SkillManifest | null = null;

    const deps = {
      publishSkill: async (draft: any) => {
        return {
          ...draft,
          skill_id: draft.skill_id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: "1.0.0",
        } as SkillManifest;
      },
      cachePublishedSkill: (skill: SkillManifest) => { cachedSkill = skill; },
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    const skill = makeSkill({ auth_profile_ref: "vault://myprofile" });
    await queuePassiveSkillPublish(skill, { deps });

    expect(cachedSkill).not.toBeNull();
    expect(cachedSkill!.auth_profile_ref).toBe("vault://myprofile");
  });
});

describe("passive publish honors capture-pipeline settings", () => {
  const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;
  const tempDirs: string[] = [];

  function freshConfigDir(prefix: string): string {
    const dir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), prefix),
    );
    tempDirs.push(dir);
    process.env.UNBROWSE_CONFIG_DIR = dir;
    return dir;
  }

  function restoreConfigDir(): void {
    if (originalConfigDir == null) delete process.env.UNBROWSE_CONFIG_DIR;
    else process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
  }

  test("global kill switch (auto_publish_checkpoints=false) blocks per-execute publish", async () => {
    freshConfigDir("unbrowse-passive-killswitch-");
    const { updateCapturePipelineSettings } = await import("../src/settings.js");
    updateCapturePipelineSettings({ auto_publish_checkpoints: false });

    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];
    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: draft.skill_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    await queuePassiveSkillPublish(makeSkill(), { deps });

    expect(published.length).toBe(0);
    restoreConfigDir();
  });

  test("domain blacklist blocks per-execute publish for matching domain", async () => {
    freshConfigDir("unbrowse-passive-blacklist-");
    const { updateCapturePipelineSettings } = await import("../src/settings.js");
    updateCapturePipelineSettings({ publish_domain_blacklist: ["example.com"] });

    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];
    const deps = {
      publishSkill: async (draft: any) => {
        published.push(draft as SkillManifest);
        return { ...draft, skill_id: draft.skill_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    await queuePassiveSkillPublish(makeSkill({ domain: "example.com" }), { deps });

    expect(published.length).toBe(0);
    restoreConfigDir();
  });

  test("prompt-list blocks per-execute publish (treated as pause, not allow)", async () => {
    freshConfigDir("unbrowse-passive-promptlist-");
    const { updateCapturePipelineSettings } = await import("../src/settings.js");
    updateCapturePipelineSettings({ publish_domain_promptlist: ["example.com"] });

    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];
    const deps = {
      publishSkill: async (draft: any) => {
        published.push(draft as SkillManifest);
        return { ...draft, skill_id: draft.skill_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    await queuePassiveSkillPublish(makeSkill({ domain: "api.example.com" }), { deps });

    expect(published.length).toBe(0);
    restoreConfigDir();
  });

  test("default settings (auto-publish on, no rules) still publishes", async () => {
    freshConfigDir("unbrowse-passive-default-");

    resetPassivePublishQueueForTests();
    const published: SkillManifest[] = [];
    const deps = {
      publishSkill: async (draft: any) => {
        const result = { ...draft, skill_id: draft.skill_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: "1.0.0" } as SkillManifest;
        published.push(result);
        return result;
      },
      cachePublishedSkill: (_s: SkillManifest) => {},
      validateManifest: async (_m: any) => ({ valid: true, hardErrors: [] as string[], softWarnings: [] as string[] }),
    };

    await queuePassiveSkillPublish(makeSkill(), { deps });

    expect(published.length).toBe(1);
    restoreConfigDir();
  });
});
