import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeConfigDir(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "unbrowse-attr-"));
  tempDirs.push(home);
  const configDir = join(home, ".unbrowse");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2));
  return configDir;
}

async function loadClientModule() {
  return import(`../src/client/index.ts?attr=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("#232 delta attribution — indexer_id wired client-side", () => {
  it("recordExecution sends indexer_id derived from saved agent_id", async () => {
    const configDir = makeConfigDir({
      api_key: "test-api-key",
      agent_id: "agent-abc123",
      agent_name: "test-agent",
      registered_at: "2026-01-01T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-01-01T00:00:00.000Z",
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    process.env.UNBROWSE_API_KEY = "test-api-key";

    const bodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/stats/execution") && init?.method === "POST") {
        bodies.push(JSON.parse(init.body as string));
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { recordExecution } = await loadClientModule();
    const trace = {
      trace_id: "trace-1",
      skill_id: "skill-1",
      endpoint_id: "ep-1",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
    };
    await recordExecution("skill-1", "ep-1", trace);

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.skill_id).toBe("skill-1");
    expect(body.endpoint_id).toBe("ep-1");
    expect(body.indexer_id).toBe("agent-abc123");
  });

  it("recordExecution uses explicit indexer_id when provided", async () => {
    const configDir = makeConfigDir({
      api_key: "test-api-key",
      agent_id: "agent-abc123",
      agent_name: "test-agent",
      registered_at: "2026-01-01T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-01-01T00:00:00.000Z",
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    process.env.UNBROWSE_API_KEY = "test-api-key";

    const bodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/stats/execution") && init?.method === "POST") {
        bodies.push(JSON.parse(init.body as string));
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { recordExecution } = await loadClientModule();
    const trace = {
      trace_id: "trace-2",
      skill_id: "skill-2",
      endpoint_id: "ep-2",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
    };
    await recordExecution("skill-2", "ep-2", trace, "explicit-indexer-999");

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.indexer_id).toBe("explicit-indexer-999");
  });

  it("publishSkill includes indexer_id from saved agent_id", async () => {
    const configDir = makeConfigDir({
      api_key: "test-api-key",
      agent_id: "indexer-publisher-456",
      agent_name: "test-publisher",
      registered_at: "2026-01-01T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-01-01T00:00:00.000Z",
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    process.env.UNBROWSE_API_KEY = "test-api-key";

    const publishBodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/skills") && init?.method === "POST") {
        publishBodies.push(JSON.parse(init.body as string));
        return jsonResponse({
          skill_id: "pub-skill-1",
          version: "1.0.0",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          warnings: [],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { publishSkill } = await loadClientModule();
    await publishSkill({
      skill_id: "pub-skill-1",
      version: "1.0.0",
      schema_version: "1",
      name: "Test Skill",
      intent_signature: "fetch widget data",
      domain: "example.com",
      description: "Test skill",
      owner_type: "community",
      execution_type: "http",
      endpoints: [
        {
          endpoint_id: "ep-1",
          method: "GET",
          url_template: "https://example.com/api/widgets?q={query}",
          description: "fetch widgets",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
        },
      ],
      lifecycle: { status: "active" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);

    expect(publishBodies).toHaveLength(1);
    const body = publishBodies[0] as Record<string, unknown>;
    expect(body.indexer_id).toBe("indexer-publisher-456");
  });

  it("publishSkill preserves caller-supplied indexer_id", async () => {
    const configDir = makeConfigDir({
      api_key: "test-api-key",
      agent_id: "indexer-publisher-456",
      agent_name: "test-publisher",
      registered_at: "2026-01-01T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-01-01T00:00:00.000Z",
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    process.env.UNBROWSE_API_KEY = "test-api-key";

    const publishBodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/skills") && init?.method === "POST") {
        publishBodies.push(JSON.parse(init.body as string));
        return jsonResponse({
          skill_id: "pub-skill-2",
          version: "1.0.0",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          warnings: [],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { publishSkill } = await loadClientModule();
    await publishSkill({
      skill_id: "pub-skill-2",
      version: "1.0.0",
      schema_version: "1",
      name: "Test Skill",
      intent_signature: "fetch data",
      domain: "example.com",
      description: "Test",
      owner_type: "community",
      execution_type: "http",
      indexer_id: "override-indexer-789",
      endpoints: [
        {
          endpoint_id: "ep-1",
          method: "GET",
          url_template: "https://example.com/api/data",
          description: "fetch data",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.9,
        },
      ],
      lifecycle: { status: "active" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);

    expect(publishBodies).toHaveLength(1);
    const body = publishBodies[0] as Record<string, unknown>;
    // Caller-supplied indexer_id must not be overwritten
    expect(body.indexer_id).toBe("override-indexer-789");
  });

  it("getAgentId returns empty string in local-only mode", async () => {
    process.env.UNBROWSE_LOCAL_ONLY = "1";
    const { getAgentId } = await loadClientModule();
    expect(getAgentId()).toBe("");
  });

  it("getAgentId returns agent_id from config", async () => {
    const configDir = makeConfigDir({
      api_key: "test-api-key",
      agent_id: "config-agent-id-777",
      agent_name: "test",
      registered_at: "2026-01-01T00:00:00.000Z",
      tos_accepted_version: null,
      tos_accepted_at: null,
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    const { getAgentId } = await loadClientModule();
    expect(getAgentId()).toBe("config-agent-id-777");
  });
});
