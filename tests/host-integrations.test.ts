import { describe, test, expect } from "bun:test";
import {
  SUPPORTED_HOSTS,
  LocalSupervisor,
  getDefaultLoginConfig,
} from "../src/runtime/supervisor.js";

describe("#91 host integrations", () => {
  test("all supported hosts have required fields", () => {
    for (const host of SUPPORTED_HOSTS) {
      expect(host.type).toBeDefined();
      expect(host.capabilities.length).toBeGreaterThan(0);
    }
  });

  test("active hosts include openclaw, mcp, cli", () => {
    const active = SUPPORTED_HOSTS.filter((h) => h.status === "active").map((h) => h.type);
    expect(active).toContain("openclaw");
    expect(active).toContain("mcp");
    expect(active).toContain("cli");
  });
});

describe("#112 interactive login UX", () => {
  test("default config uses interactive with timeout", () => {
    const config = getDefaultLoginConfig(false);
    expect(config.interactive).toBe(true);
    expect(config.timeout_ms).toBe(120_000);
    expect(config.fallback_strategy).toBe("prompt");
  });

  test("headless environments use skip fallback", () => {
    const config = getDefaultLoginConfig(true);
    expect(config.interactive).toBe(false);
    expect(config.timeout_ms).toBe(30_000);
    expect(config.fallback_strategy).toBe("skip");
  });
});

describe("#90 runtime supervisor", () => {
  test("supervisor interface contract", () => {
    const sup = new LocalSupervisor();
    expect(sup.isRunning()).toBe(false);
  });

  test("supervisor starts and reports healthy", async () => {
    const sup = new LocalSupervisor();
    await sup.start();
    expect(sup.isRunning()).toBe(true);
    const health = await sup.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.uptime_ms).toBeGreaterThanOrEqual(0);
    await sup.stop();
    expect(sup.isRunning()).toBe(false);
  });

  test("supervisor stop resets health to unhealthy", async () => {
    const sup = new LocalSupervisor();
    await sup.start();
    await sup.stop();
    const health = await sup.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.uptime_ms).toBe(0);
  });
});
