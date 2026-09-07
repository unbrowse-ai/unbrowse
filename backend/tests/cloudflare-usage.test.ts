import { afterEach, describe, expect, it } from "bun:test";
import { getCloudflareWorkerUsage } from "../src/services/cloudflare-usage.js";
import type { Env } from "../src/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Cloudflare Worker usage witness", () => {
  it("is honest when credentials are absent", async () => {
    const result = await getCloudflareWorkerUsage({} as Env, 7);
    expect(result).toMatchObject({ configured: false, requests: null, unavailable_reason: "not_configured" });
  });

  it("aggregates Workers Analytics rows without exposing the token", async () => {
    let requestBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cf-secret");
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { sum: { requests: 10, subrequests: 4, errors: 1 }, quantiles: { cpuTimeP50: 100, cpuTimeP99: 400 } },
        { sum: { requests: 5, subrequests: 2, errors: 0 }, quantiles: { cpuTimeP50: 120, cpuTimeP99: 300 } },
      ] }] } } });
    }) as typeof fetch;
    const result = await getCloudflareWorkerUsage({ CLOUDFLARE_ANALYTICS_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_WORKER_SCRIPT_NAME: "unbrowse-backend" } as Env, 7);
    expect(result).toMatchObject({ configured: true, requests: 15, subrequests: 6, errors: 1, cpu_time_p99_us: null });
    expect(result.error_rate).toBeCloseTo(1 / 15, 4);
    expect(requestBody).not.toContain("cf-secret");
  });
});
