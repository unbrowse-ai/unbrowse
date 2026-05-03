import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getApiKey, isValidAgentEmail, normalizeAgentEmail, resetLocalRegistration, resolveAgentName } from "../src/client/index.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_LOG = console.log;
const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeConfigDirWithConfig(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "unbrowse-client-"));
  tempDirs.push(home);
  const configDir = join(home, ".unbrowse");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2));
  return configDir;
}

async function loadClientModule() {
  return import(`../src/client/index.ts?test=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  console.warn = ORIGINAL_WARN;
  console.log = ORIGINAL_LOG;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("client registration recovery", () => {
  it("force-resets the local registration cache", () => {
    const configDir = makeConfigDirWithConfig({
      api_key: "broken-key",
      agent_id: "broken-agent",
      agent_name: "broken-agent",
      registered_at: "2026-03-13T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-03-13T00:00:00.000Z",
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;

    const result = resetLocalRegistration();

    expect(result.removed).toBe(true);
    expect(result.config_path).toBe(join(configDir, "config.json"));
    expect(() => readFileSync(join(configDir, "config.json"), "utf8")).toThrow();
  });

  it("prefers fresh saved key over env when reset marked the env key stale", () => {
    const configDir = makeConfigDirWithConfig({
      api_key: "fresh-config-key",
      agent_id: "fresh-agent",
      agent_name: "fresh-agent",
      registered_at: "2026-03-13T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-03-13T00:00:00.000Z",
      ignore_env_api_key: true,
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    process.env.UNBROWSE_API_KEY = "stale-env-key";

    expect(getApiKey()).toBe("fresh-config-key");
    expect(process.env.UNBROWSE_API_KEY).toBe("fresh-config-key");
  });

  it("falls back to saved config when UNBROWSE_API_KEY is stale", async () => {
    const configDir = makeConfigDirWithConfig({
      api_key: "config-key",
      agent_id: "agent-config",
      agent_name: "saved-agent",
      registered_at: "2026-03-13T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-03-13T00:00:00.000Z",
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    process.env.UNBROWSE_API_KEY = "env-key";
    console.warn = () => {};
    console.log = () => {};

    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const auth = init?.headers && typeof init.headers === "object"
        ? (init.headers as Record<string, string>).Authorization
        : undefined;
      calls.push(`${init?.method ?? "GET"} ${url} ${auth ?? ""}`.trim());
      if (url.endsWith("/v1/agents/me") && auth === "Bearer env-key") {
        return jsonResponse({ error: "Agent profile not found" }, 404);
      }
      if (url.endsWith("/v1/agents/me") && auth === "Bearer config-key") {
        return jsonResponse({
          agent_id: "agent-config",
          name: "saved-agent",
          created_at: "2026-03-13T00:00:00.000Z",
          skills_discovered: [],
          total_executions: 0,
          total_feedback_given: 0,
          tos_accepted_version: "2026-02-22-v1",
          tos_accepted_at: "2026-03-13T00:00:00.000Z",
          activity_dates: [],
        });
      }
      if (url.endsWith("/v1/tos/current")) {
        return jsonResponse({
          version: "2026-02-22-v1",
          summary: "tos",
          url: "https://unbrowse.ai/terms",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { ensureRegistered } = await loadClientModule();
    await ensureRegistered();

    expect(process.env.UNBROWSE_API_KEY).toBe("config-key");
    expect(calls.some((call) => call.includes("/v1/agents/register"))).toBeFalse();
  });

  it("re-registers when cached key has no agent profile", async () => {
    const configDir = makeConfigDirWithConfig({
      api_key: "stale-config-key",
      agent_id: "stale-agent",
      agent_name: "stale-agent",
      registered_at: "2026-03-13T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-03-13T00:00:00.000Z",
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    delete process.env.UNBROWSE_API_KEY;
    process.env.UNBROWSE_NON_INTERACTIVE = "1";
    process.env.UNBROWSE_TOS_ACCEPTED = "1";
    process.env.UNBROWSE_AGENT_EMAIL = "agent@example.com";
    console.warn = () => {};
    console.log = () => {};

    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const auth = init?.headers && typeof init.headers === "object"
        ? (init.headers as Record<string, string>).Authorization
        : undefined;
      if (url.endsWith("/v1/agents/me") && auth === "Bearer stale-config-key") {
        return jsonResponse({ error: "Agent profile not found" }, 404);
      }
      if (url.endsWith("/v1/tos/current")) {
        return jsonResponse({
          version: "2026-02-22-v1",
          summary: "tos",
          url: "https://unbrowse.ai/terms",
        });
      }
      if (url.endsWith("/v1/agents/register") && init?.method === "POST") {
        return jsonResponse({ agent_id: "new-agent", api_key: "new-key" }, 201);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { ensureRegistered } = await loadClientModule();
    await ensureRegistered();

    expect(process.env.UNBROWSE_API_KEY).toBe("new-key");
    const saved = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as { api_key: string; agent_id: string };
    expect(saved.api_key).toBe("new-key");
    expect(saved.agent_id).toBe("new-agent");
  });

  it("registers and syncs the local lobster wallet", async () => {
    const configDir = makeConfigDirWithConfig({
      api_key: "config-key",
      agent_id: "agent-config",
      agent_name: "saved-agent",
      registered_at: "2026-03-13T00:00:00.000Z",
      tos_accepted_version: "2026-02-22-v1",
      tos_accepted_at: "2026-03-13T00:00:00.000Z",
    });
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    process.env.UNBROWSE_API_KEY = "config-key";
    process.env.LOBSTER_WALLET_ADDRESS = "wallet-live";
    console.warn = () => {};
    console.log = () => {};

    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/v1/agents/me")) {
        return jsonResponse({
          agent_id: "agent-config",
          name: "saved-agent",
          created_at: "2026-03-13T00:00:00.000Z",
          wallet_address: null,
          wallet_provider: null,
          skills_discovered: [],
          total_executions: 0,
          total_feedback_given: 0,
          tos_accepted_version: "2026-02-22-v1",
          tos_accepted_at: "2026-03-13T00:00:00.000Z",
          activity_dates: [],
        });
      }
      if (url.endsWith("/v1/agents/wallet")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { ensureRegistered } = await loadClientModule();
    await ensureRegistered();

    const walletCall = calls.find((call) => call.url.endsWith("/v1/agents/wallet"));
    expect(walletCall?.body).toEqual({
      wallet_address: "wallet-live",
      wallet_provider: "lobster.cash",
    });
  });

  it("retries registration without wallet when the wallet is already claimed", async () => {
    const configDir = makeConfigDirWithConfig({});
    process.env.UNBROWSE_CONFIG_DIR = configDir;
    delete process.env.UNBROWSE_API_KEY;
    process.env.UNBROWSE_NON_INTERACTIVE = "1";
    process.env.UNBROWSE_TOS_ACCEPTED = "1";
    process.env.UNBROWSE_AGENT_EMAIL = "agent@example.com";
    process.env.LOBSTER_WALLET_ADDRESS = "wallet-claimed";
    console.warn = () => {};
    console.log = () => {};

    const registerBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/tos/current")) {
        return jsonResponse({
          version: "2026-02-22-v1",
          summary: "tos",
          url: "https://unbrowse.ai/terms",
        });
      }
      if (url.endsWith("/v1/agents/register") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        registerBodies.push(body);
        if (body.wallet_address === "wallet-claimed") {
          return jsonResponse({ error: "wallet_already_claimed" }, 400);
        }
        return jsonResponse({ agent_id: "new-agent", api_key: "new-key" }, 201);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { ensureRegistered } = await loadClientModule();
    await ensureRegistered({ promptForEmail: false, exitOnFailure: false });

    expect(registerBodies).toHaveLength(2);
    expect(registerBodies[0]?.wallet_address).toBe("wallet-claimed");
    expect(registerBodies[1]?.wallet_address).toBeUndefined();
    const saved = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as {
      api_key: string;
      agent_id: string;
      wallet_address?: string;
    };
    expect(saved.api_key).toBe("new-key");
    expect(saved.agent_id).toBe("new-agent");
    expect(saved.wallet_address).toBeUndefined();
  });
});

describe("client registration identity", () => {
  it("normalizes valid email agent names", () => {
    expect(normalizeAgentEmail("  Lewis@Example.COM ")).toBe("lewis@example.com");
    expect(isValidAgentEmail("Lewis@Example.COM")).toBe(true);
    expect(resolveAgentName(" Lewis@Example.COM ", "host-abc123")).toBe("lewis@example.com");
  });

  it("falls back to local agent id when email is invalid", () => {
    expect(isValidAgentEmail("not-an-email")).toBe(false);
    expect(resolveAgentName("not-an-email", "host-abc123")).toBe("host-abc123");
    expect(resolveAgentName("", "host-abc123")).toBe("host-abc123");
  });
});

describe("searchIntentResolve fallback", () => {
  it("falls back to legacy search endpoints when resolve route is unavailable", async () => {
    process.env.UNBROWSE_API_KEY = "test-key";

    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/search/resolve")) {
        return jsonResponse({ error: "not found" }, 404);
      }
      if (url.endsWith("/v1/search/domain")) {
        return jsonResponse({
          results: [{ id: 1, score: 0.9, metadata: { content: JSON.stringify({ skill_id: "domain-skill" }) } }],
        });
      }
      if (url.endsWith("/v1/search")) {
        return jsonResponse({
          results: [{ id: 2, score: 0.8, metadata: { content: JSON.stringify({ skill_id: "global-skill" }) } }],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { searchIntentResolve } = await loadClientModule();
    const result = await searchIntentResolve("get stock quote", "finance.yahoo.com", 5, 10);

    expect(result.domain_results).toHaveLength(1);
    expect(result.global_results).toHaveLength(1);
    expect(result.skipped_global).toBe(false);
  });
});
