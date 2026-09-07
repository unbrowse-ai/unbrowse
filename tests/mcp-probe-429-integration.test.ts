import { describe, expect, test } from "bun:test";
import http from "node:http";

// Day-9 integration test for the probe-fast-fail 429 gap.
// When the probe ladder returns "return-error" on a 429 (probe HEAD/ranged-GET
// got a rate-limit response), the synthesised result now carries
// response_headers: { "retry-after": probe.retry_after } so the downstream 429
// branch can call parseRetryAfter and emit decision_trace
// 429_retry_after_honored {retry_after_ms} instead of always falling through
// to 429_retry_after_absent.

async function start429Server(retryAfter: string | null): Promise<{port:number; close:()=>Promise<void>}> {
  const server = http.createServer((req, res) => {
    const headers: Record<string,string> = { "Content-Type": "text/plain" };
    if (retryAfter !== null) headers["Retry-After"] = retryAfter;
    res.writeHead(429, headers);
    res.end("rate limited");
  });
  const port = await new Promise<number>((res, rej) => {
    server.once("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") res(addr.port);
      else rej(new Error("no addr"));
    });
    server.once("error", rej);
    server.listen(0, "127.0.0.1");
  });
  return { port, close: () => new Promise<void>(r => server.close(()=>r())) };
}

function makeManifest(port: number, endpointUrl: string): { skill: unknown; endpoint: unknown } {
  return {
    skill: {
      skill_id: "test_probe_429",
      domain: "127.0.0.1",
      intent_signature: "test",
      endpoints: [],
      published_at: new Date().toISOString(),
    },
    endpoint: {
      endpoint_id: "ep_probe_429",
      url_template: endpointUrl,
      method: "GET",
      requires: [],
      yields: [],
      action_kind: "read",
      score: 1,
    },
  };
}

describe("probe-fast-fail 429 surfaces 429_retry_after_honored (Day-9 integration)", () => {
  test("probe HEAD 429 + Retry-After: 60 -> decision_trace contains 429_retry_after_honored", async () => {
    process.env.UNBROWSE_ALLOW_PRIVATE_IPS = "1";
    const srv = await start429Server("60");
    try {
      const { executeEndpoint } = await import("../src/execution/index.ts");
      const { skill, endpoint } = makeManifest(srv.port, `http://127.0.0.1:${srv.port}/`);
      const { trace } = await executeEndpoint(
        // deno-lint-ignore no-explicit-any
        skill as any,
        // deno-lint-ignore no-explicit-any
        endpoint as any,
        `http://127.0.0.1:${srv.port}/`,
        { intent: "test" },
      );
      const dt = (trace as unknown as { decision_trace: Array<{ step: string; retry_after_ms?: number }> }).decision_trace;
      const honored = dt.find(s => s.step === "429_retry_after_honored");
      expect(honored).toBeDefined();
      expect(honored?.retry_after_ms).toBe(60_000);
      // Must NOT have fallen through to absent
      const absent = dt.find(s => s.step === "429_retry_after_absent");
      expect(absent).toBeUndefined();
    } finally {
      await srv.close();
    }
  }, 20_000);

  test("probe HEAD 429 with NO Retry-After -> decision_trace contains 429_retry_after_absent", async () => {
    process.env.UNBROWSE_ALLOW_PRIVATE_IPS = "1";
    const srv = await start429Server(null);
    try {
      const { executeEndpoint } = await import("../src/execution/index.ts");
      const { skill, endpoint } = makeManifest(srv.port, `http://127.0.0.1:${srv.port}/`);
      const { trace } = await executeEndpoint(
        // deno-lint-ignore no-explicit-any
        skill as any,
        // deno-lint-ignore no-explicit-any
        endpoint as any,
        `http://127.0.0.1:${srv.port}/`,
        { intent: "test" },
      );
      const dt = (trace as unknown as { decision_trace: Array<{ step: string }> }).decision_trace;
      const absent = dt.find(s => s.step === "429_retry_after_absent");
      expect(absent).toBeDefined();
      const honored = dt.find(s => s.step === "429_retry_after_honored");
      expect(honored).toBeUndefined();
    } finally {
      await srv.close();
    }
  }, 20_000);
});
