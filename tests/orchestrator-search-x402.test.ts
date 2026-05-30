import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainSkillCache, resolveAndExecute } from "../src/orchestrator/index.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

// The orchestrator rewrite (2026-05) races recipe ‖ marketplace ‖ probe in
// parallel. A non-/v1/search/resolve URL is the parallel probe of the context
// page; a real run lets that probe fail-soft when the page is unreachable. The
// stub below models exactly that: it answers /v1/search/resolve (the marketplace
// branch) and rejects every other URL like a network miss, so the marketplace
// x402 contract is what surfaces — not a hard throw that crashes the test.
// HOME is isolated so isLobsterAvailable() === false and the 402 propagates as
// an x402 error instead of being silently auto-paid by a real local wallet.
function networkMiss(url: string): never {
  throw new TypeError(`fetch failed (test isolation, unreachable in probe): ${url}`);
}

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "unbrowse-orch-x402-home-"));
});

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
      return networkMiss(url);
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

  it("does NOT bypass the Tier 3 fee for structured detail pages (canonical-replay removed in Phase 8.3)", async () => {
    // Pre-8.3 the orchestrator synthesised a local canonical-replay skill for
    // structured detail pages, silently bypassing the x402 search fee. Phase 8.3
    // deleted the per-host replay registry (buildLocalCanonicalReplaySkill now
    // returns undefined; live-capture is the sole source of truth). So a detail
    // page hitting an x402-gated marketplace search must now surface the same
    // Tier 3 payment_required envelope as any other intent — no free bypass.
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
      return networkMiss(url);
    }) as typeof globalThis.fetch;

    try {
      const out = await resolveAndExecute(
        "get package info",
        {},
        { url: "https://pypi.org/project/openai/" },
      );

      const result = out.result as Record<string, unknown>;
      expect(out.source).toBe("marketplace");
      expect(out.trace.status_code).toBe(402);
      expect(result.error).toBe("payment_required");
      expect(result.tier).toBe("tier3");
      // No silent canonical-replay bypass: the result is a payment envelope,
      // never a synthesised skill with auto-executed endpoints.
      expect(result.skill_id).toBeUndefined();
      expect(result.available_endpoints).toBeUndefined();
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
      if (hadSnapshots) renameSync(backupDir, snapshotDir);
    }
  });
});
