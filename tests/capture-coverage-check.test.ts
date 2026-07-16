import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";

// Real witness for the coverage-check gate added to cmdCapture (src/cli.ts):
// `act capture` must check local cache, then the marketplace, before ever
// paying the cost of a real browser capture. See src/capture/coverage-check.ts.

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "unbrowse-coverage-check-"));
  process.env.UNBROWSE_SKILL_CACHE_DIR = cacheDir;
});

afterEach(() => {
  delete process.env.UNBROWSE_SKILL_CACHE_DIR;
  delete process.env.UNBROWSE_API_URL;
  try { rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedLocalSkill(domain: string, skillId: string): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, `${skillId}.json`),
    JSON.stringify({
      skill_id: skillId,
      domain,
      endpoints: [
        {
          endpoint_id: "ep1",
          method: "GET",
          url_template: `https://${domain}/api/data`,
          idempotency: "safe",
          verification_status: "active",
          reliability_score: 0.8,
        },
      ],
    }),
  );
}

function startStubMarketplace(domainResults: unknown[]): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ domain_results: domainResults, global_results: [] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("checkDomainCoverage", () => {
  it("returns covered=true, source=local_cache when this machine already captured the domain", async () => {
    seedLocalSkill("example.com", "local-skill-1");
    const { checkDomainCoverage } = await import("../src/capture/coverage-check.js");
    const result = await checkDomainCoverage("example.com");
    expect(result.covered).toBe(true);
    expect(result.source).toBe("local_cache");
    expect(result.skill_id).toBe("local-skill-1");
  });

  it("returns covered=true, source=marketplace when the local cache misses but the shared graph has it", async () => {
    const { server, baseUrl } = await startStubMarketplace([{ skill_id: "shared-skill-1", domain: "shared.example.com" }]);
    process.env.UNBROWSE_API_URL = baseUrl;
    try {
      const { checkDomainCoverage } = await import("../src/capture/coverage-check.js");
      const result = await checkDomainCoverage("shared.example.com");
      expect(result.covered).toBe(true);
      expect(result.source).toBe("marketplace");
      expect(result.skill_id).toBe("shared-skill-1");
    } finally {
      server.close();
    }
  });

  it("returns covered=false, source=none when neither local cache nor marketplace has the domain", async () => {
    const { server, baseUrl } = await startStubMarketplace([]);
    process.env.UNBROWSE_API_URL = baseUrl;
    try {
      const { checkDomainCoverage } = await import("../src/capture/coverage-check.js");
      const result = await checkDomainCoverage("truly-uncovered-domain.example");
      expect(result.covered).toBe(false);
      expect(result.source).toBe("none");
    } finally {
      server.close();
    }
  });

  it("fails open (covered=false) when the marketplace check errors, never throwing", async () => {
    // Point at a port nothing is listening on — real network failure, not a mock.
    process.env.UNBROWSE_API_URL = "http://127.0.0.1:1";
    const { checkDomainCoverage } = await import("../src/capture/coverage-check.js");
    const result = await checkDomainCoverage("unreachable-backend-test.example");
    expect(result.covered).toBe(false);
    expect(result.source).toBe("none");
  });

  it("local cache takes priority over marketplace — never makes the network call when local hits", async () => {
    seedLocalSkill("priority-test.com", "local-priority-skill");
    // Point at a port nothing is listening on. If the function incorrectly
    // checked marketplace first (or always), this would hang/error instead
    // of returning the local hit immediately.
    process.env.UNBROWSE_API_URL = "http://127.0.0.1:1";
    const { checkDomainCoverage } = await import("../src/capture/coverage-check.js");
    const result = await checkDomainCoverage("priority-test.com");
    expect(result.covered).toBe(true);
    expect(result.source).toBe("local_cache");
  });
});
