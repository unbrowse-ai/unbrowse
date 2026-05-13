import { describe, expect, test } from "bun:test";
import http from "node:http";

// Day-9 follow-up: W3's probe-fast-fail gap.
// The B3 fix in commit 06ddc6b9 plumbs response_headers through serverFetch,
// but executeEndpoint also has a probe-ladder short-circuit at the
// "return-error" case that synthesises a result with no response_headers.
// On HTTP 429 + Retry-After from the probe HEAD, the 429 branch then sees
// {} and always falls through to 429_retry_after_absent.
//
// This seed test asserts the bottom of the stack: probeUrl must surface
// the Retry-After header (raw) on its ProbeResult so the synth result can
// thread it through to response_headers.

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{port: number; close: () => Promise<void>}> {
  const server = http.createServer(handler);
  const port = await new Promise<number>((res, rej) => {
    server.once("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") res(addr.port);
      else rej(new Error("no addr"));
    });
    server.once("error", rej);
    server.listen(0, "127.0.0.1");
  });
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("probeUrl surfaces Retry-After (Day-9 seed)", () => {
  test("429 with Retry-After: 30 produces probe.retry_after === '30'", async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(429, { "Retry-After": "30", "Content-Type": "text/plain" });
      res.end("rate limited");
    });
    try {
      const { probeUrl } = await import("../src/execution/probe.ts");
      const probe = await probeUrl(`http://127.0.0.1:${srv.port}/`);
      expect(probe.status).toBe(429);
      // The new field — this assertion FAILS before Day-9 implementation.
      expect((probe as { retry_after?: string }).retry_after).toBe("30");
    } finally {
      await srv.close();
    }
  }, 10_000);

  test("429 with HTTP-date Retry-After surfaces the raw header verbatim", async () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const srv = await startServer((req, res) => {
      res.writeHead(429, { "Retry-After": future, "Content-Type": "text/plain" });
      res.end("rate limited");
    });
    try {
      const { probeUrl } = await import("../src/execution/probe.ts");
      const probe = await probeUrl(`http://127.0.0.1:${srv.port}/`);
      expect(probe.status).toBe(429);
      expect((probe as { retry_after?: string }).retry_after).toBe(future);
    } finally {
      await srv.close();
    }
  }, 10_000);

  test("200 OK leaves retry_after undefined (only set when status warrants)", async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    try {
      const { probeUrl } = await import("../src/execution/probe.ts");
      const probe = await probeUrl(`http://127.0.0.1:${srv.port}/`);
      expect(probe.status).toBe(200);
      expect((probe as { retry_after?: string }).retry_after).toBeUndefined();
    } finally {
      await srv.close();
    }
  }, 10_000);

  test("429 without Retry-After leaves retry_after undefined", async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("rate limited");
    });
    try {
      const { probeUrl } = await import("../src/execution/probe.ts");
      const probe = await probeUrl(`http://127.0.0.1:${srv.port}/`);
      expect(probe.status).toBe(429);
      expect((probe as { retry_after?: string }).retry_after).toBeUndefined();
    } finally {
      await srv.close();
    }
  }, 10_000);
});
