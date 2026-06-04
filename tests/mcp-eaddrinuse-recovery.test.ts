import { describe, expect, test } from "bun:test";
import net from "node:net";

// B1 seed (Day 3, restricted-loop session 2026-05-13).
// Per docs/mcp-issues + .harness-out/session-bugs-20260513T122248Z.json:
// 42 sessions across 2026-04-01..now saw EADDRINUSE (port :6969 contention).
//
// Plan A3: ensureLocalServer must detect a foreign-process holding :6969
// and fast-fail with an actionable error rather than spinning the spawn-retry
// loop for 30s × MAX_RESTART_ATTEMPTS.
//
// Today there is NO probePortOwnership() helper. This test FAILS by import.
// Day 4 implements src/runtime/local-server.ts::probePortOwnership and this
// test passes against post-fix source.

describe("B1: probePortOwnership (Day 3 failing seed)", () => {
  test("port-free returns kind:free", async () => {
    // Will fail at import-time until Day 4 ships the helper.
    const { probePortOwnership } = await import(
      "../src/runtime/local-server.ts"
    );
    // Use a high port unlikely to be in use during CI.
    const result = await probePortOwnership("http://127.0.0.1:54971");
    expect(result.kind).toBe("free");
  });

  test("foreign-process holding port returns kind:foreign", async () => {
    const { probePortOwnership } = await import(
      "../src/runtime/local-server.ts"
    );
    // Bind a server on a fresh port; the unbrowse runtime doesn't own it.
    const server = net.createServer();
    const port = await new Promise<number>((res, rej) => {
      server.once("listening", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") res(addr.port);
        else rej(new Error("no addr"));
      });
      server.once("error", rej);
      server.listen(0, "127.0.0.1");
    });

    try {
      const result = await probePortOwnership(`http://127.0.0.1:${port}`);
      expect(result.kind).toBe("foreign");
      // It is also acceptable for the helper to report the pid when known;
      // when introspection fails it returns pid:null.
      if (result.kind === "foreign") {
        expect(result.pid === null || typeof result.pid === "number").toBe(true);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10_000);
});

// B1 adversarial / edge (Day 5).
describe("B1: probePortOwnership (Day 5 edges)", () => {
  test("malformed base URL does not crash (returns free, foreign, or owned)", async () => {
    const { probePortOwnership } = await import(
      "../src/runtime/local-server.ts"
    );
    // No port specified; the helper must not throw on URL parse oddities.
    const result = await probePortOwnership("http://127.0.0.1");
    expect(["free", "foreign", "owned"]).toContain(result.kind);
  });

  test("rapid sequential probes on a free port stay 'free' (no false positive lock)", async () => {
    const { probePortOwnership } = await import(
      "../src/runtime/local-server.ts"
    );
    const r1 = await probePortOwnership("http://127.0.0.1:54972");
    const r2 = await probePortOwnership("http://127.0.0.1:54972");
    expect(r1.kind).toBe("free");
    expect(r2.kind).toBe("free");
  });

  test("foreign-bound port still classified as foreign across two probes (no cache poisoning)", async () => {
    const { probePortOwnership } = await import(
      "../src/runtime/local-server.ts"
    );
    const server = net.createServer();
    const port = await new Promise<number>((res, rej) => {
      server.once("listening", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") res(addr.port);
        else rej(new Error("no addr"));
      });
      server.once("error", rej);
      server.listen(0, "127.0.0.1");
    });
    try {
      const r1 = await probePortOwnership(`http://127.0.0.1:${port}`);
      const r2 = await probePortOwnership(`http://127.0.0.1:${port}`);
      expect(r1.kind).toBe("foreign");
      expect(r2.kind).toBe("foreign");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10_000);
});
