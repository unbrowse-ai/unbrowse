/**
 * kuri-proxy-reachable.test — the unit witness for the proxy-resilience fix: a dead/unreachable
 * KURI_PROXY is un-wired (→ direct egress) so a flaky residential-proxy upstream cannot brick
 * every browser capture; a reachable one is kept; no proxy is a no-op.
 */
import { describe, expect, it, afterEach } from "bun:test";
import net from "node:net";
import { ensureKuriProxyReachable } from "../src/env/kuri-proxy-bridge.js";

afterEach(() => { delete process.env.KURI_PROXY; });

describe("ensureKuriProxyReachable (proxy resilience)", () => {
  it("un-wires an unreachable proxy (falls back to direct)", async () => {
    const env: NodeJS.ProcessEnv = { KURI_PROXY: "http://127.0.0.1:1" }; // nothing listens on :1
    const r = await ensureKuriProxyReachable(env, 800);
    expect(r.unwired).toBe(true);
    expect(env.KURI_PROXY).toBeUndefined();
  });

  it("keeps a reachable proxy wired", async () => {
    const server = net.createServer(() => {});
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const env: NodeJS.ProcessEnv = { KURI_PROXY: `http://127.0.0.1:${port}` };
      const r = await ensureKuriProxyReachable(env, 800);
      expect(r.unwired).toBe(false);
      expect(env.KURI_PROXY).toBe(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  });

  it("is a no-op when no proxy is wired", async () => {
    const env: NodeJS.ProcessEnv = {};
    const r = await ensureKuriProxyReachable(env, 800);
    expect(r.unwired).toBe(false);
    expect(env.KURI_PROXY).toBeUndefined();
  });

  it("leaves an unparseable value untouched (doesn't crash)", async () => {
    const env: NodeJS.ProcessEnv = { KURI_PROXY: "not a url" };
    const r = await ensureKuriProxyReachable(env, 800);
    expect(r.unwired).toBe(false);
    expect(env.KURI_PROXY).toBe("not a url");
  });
});
