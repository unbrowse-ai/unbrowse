import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainSkillCache, resolveAndExecute } from "../src/orchestrator/index.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("orchestrator search x402 propagation", () => {
  it("returns payment_required when marketplace search is x402-gated", async () => {
    process.env.AGENT_WALLET_ADDRESS = "0xfeedface";
    process.env.AGENT_WALLET_PROVIDER = "custom-wallet";
    const snapshotDir = join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");
    const backupDir = join(tmpdir(), `unbrowse-skill-snapshots-${Date.now()}`);
    const hadSnapshots = existsSync(snapshotDir);
    domainSkillCache.clear();
    if (hadSnapshots) {
      mkdirSync(backupDir, { recursive: true });
      renameSync(snapshotDir, backupDir);
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/search/resolve")) {
        return new Response(JSON.stringify({ error: "Payment Required" }), {
          status: 402,
          headers: {
            "content-type": "application/json",
            "PAYMENT-REQUIRED": encodeBase64Json({
              x402Version: 2,
              resource: { url },
              accepts: [{ amount: "1000", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }],
            }),
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;

    try {
      const out = await resolveAndExecute(
        "search packages",
        {},
        { url: "https://www.npmjs.com/search?q=openai-x402-test" },
      );

      expect(out.source).toBe("marketplace");
      expect(out.trace.status_code).toBe(402);
      expect((out.result as Record<string, unknown>).error).toBe("payment_required");
      expect((out.result as Record<string, unknown>).tier).toBe("tier3");
      expect((out.result as Record<string, unknown>).wallet_provider).toBe("custom-wallet");
      expect((out.result as Record<string, unknown>).wallet_address).toBe("0xfeedface");
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
      if (hadSnapshots) renameSync(backupDir, snapshotDir);
    }
  });

  it("falls back to a local canonical replay skill for structured detail pages", async () => {
    const snapshotDir = join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");
    const backupDir = join(tmpdir(), `unbrowse-skill-snapshots-${Date.now()}-detail`);
    const hadSnapshots = existsSync(snapshotDir);
    domainSkillCache.clear();
    if (hadSnapshots) {
      mkdirSync(backupDir, { recursive: true });
      renameSync(snapshotDir, backupDir);
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/search/resolve")) {
        return new Response(JSON.stringify({ error: "Payment Required" }), {
          status: 402,
          headers: {
            "content-type": "application/json",
            "PAYMENT-REQUIRED": encodeBase64Json({
              x402Version: 2,
              resource: { url },
              accepts: [{ amount: "1000", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }],
            }),
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;

    try {
      const out = await resolveAndExecute(
        "get package info",
        {},
        { url: "https://pypi.org/project/openai/" },
      );

      expect(out.source).toBe("marketplace");
      expect((out.result as Record<string, unknown>).error).toBeUndefined();
      expect((out.result as Record<string, unknown>).skill_id).toContain("canonical-");
      const endpoints = (out.result as Record<string, any>).available_endpoints as Array<Record<string, any>>;
      expect(Array.isArray(endpoints)).toBe(true);
      expect(endpoints[0]?.url).toContain("https://pypi.org/pypi/");
      expect(endpoints[0]?.trigger_url).toBe("https://pypi.org/project/openai/");
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
      if (hadSnapshots) renameSync(backupDir, snapshotDir);
    }
  });
});
