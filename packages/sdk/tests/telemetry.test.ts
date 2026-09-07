import { afterEach, describe, expect, it } from "bun:test";
import { Unbrowse, sdkUsageOperationForPath, telemetryEnvDisabled } from "../src/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("SDK usage telemetry", () => {
  it("uses isolated global transport and sends only aggregate fields", async () => {
    const pings: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      pings.push(JSON.parse(String(init?.body))); return Response.json({ ok: true });
    }) as typeof fetch;
    let customCalls = 0;
    const client = new Unbrowse({ baseUrl: "http://localhost:6969", fetch: (async () => { customCalls++; return Response.json({ ok: true }); }) as typeof fetch });
    await client.request("POST", "/v1/resolve", { intent: "private person@example.com" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(customCalls).toBe(1); expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ verb: "resolve", operation: "sdk:resolve", surface: "sdk", execution_scope: "local", telemetry_schema_version: 2 });
    expect(JSON.stringify(pings[0])).not.toContain("person@example.com");
  });

  it("never turns SDK path parameters into telemetry labels", () => {
    expect(sdkUsageOperationForPath("/v1/skills/private-person@example.com")).toBe("sdk:skill");
    expect(sdkUsageOperationForPath("/v1/skills/private-person@example.com/execute")).toBe("sdk:execute");
    expect(sdkUsageOperationForPath("/v1/custom/private-person@example.com")).toBe("sdk:request");
    expect(sdkUsageOperationForPath("/v1/skills", "POST")).toBe("sdk:publish");
    expect(sdkUsageOperationForPath("/v1/attribution/indexer/private-person@example.com")).toBe("sdk:earnings");
    expect(sdkUsageOperationForPath("/v1/auth/steal")).toBe("sdk:steal_auth");
  });

  it("recognizes every documented environment opt-out without mutating process state", () => {
    expect(["0", "false", "off"].every((value) => telemetryEnvDisabled(value))).toBe(true);
    expect(telemetryEnvDisabled("1")).toBe(false);
  });

  it("honors the explicit SDK opt-out", async () => {
    let pings = 0; globalThis.fetch = (async () => { pings++; return Response.json({}); }) as typeof fetch;
    const client = new Unbrowse({ telemetry: false, fetch: (async () => Response.json({ ok: true })) as typeof fetch });
    await client.request("GET", "/health"); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pings).toBe(0);
  });
});
