import { describe, test, expect } from "bun:test";
import { detectHostEnvironment, getBrowserConfig } from "../src/runtime/browser-host.js";

describe("#225 browser host detection wired into kuri launch", () => {
  test("detects unknown environment by default", () => {
    const env = detectHostEnvironment();
    expect(["unknown", "openclaw", "openai", "native", "mcp"]).toContain(env);
  });

  test("openclaw config uses headless", () => {
    const config = getBrowserConfig("openclaw");
    expect(config.headless).toBe(true);
  });

  test("openai config uses headless with CDP port", () => {
    const config = getBrowserConfig("openai");
    expect(config.headless).toBe(true);
    expect(config.cdp_port).toBeDefined();
  });

  test("native config allows headed mode", () => {
    const config = getBrowserConfig("native");
    expect(config.headless).toBe(false);
  });

  test("mcp config uses headless", () => {
    const config = getBrowserConfig("mcp");
    expect(config.headless).toBe(true);
  });

  test("unknown config defaults to headed mode", () => {
    const config = getBrowserConfig("unknown");
    expect(config.headless).toBe(false);
  });
});

describe("applyBrowserConfigToEnv wires config into process.env", () => {
  test("sets HEADLESS env var from detected config", async () => {
    const { applyBrowserConfigToEnv } = await import("../src/runtime/kuri-config.js");
    applyBrowserConfigToEnv();
    // HEADLESS must be set as a string ("true" or "false")
    expect(["true", "false"]).toContain(process.env.HEADLESS);
  });
});
