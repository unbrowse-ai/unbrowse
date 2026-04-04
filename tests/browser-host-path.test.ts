import { describe, test, expect } from "bun:test";
import {
  detectHostEnvironment,
  getBrowserConfig,
  type HostEnvironment,
  type BrowserPathConfig,
} from "../src/runtime/browser-host.js";

describe("#121 browser replacement host path", () => {
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

  test("getBrowserConfig without argument uses detectHostEnvironment", () => {
    const config = getBrowserConfig();
    // In test env, should detect "unknown" -> headless false
    expect(config).toHaveProperty("headless");
  });

  test("openclaw config sets default binary_path", () => {
    const config = getBrowserConfig("openclaw");
    expect(config.binary_path).toBe("/usr/bin/chromium");
    expect(config.user_data_dir).toBe("/tmp/openclaw-chrome");
  });

  test("openai config default CDP port is 9222", () => {
    const config = getBrowserConfig("openai");
    expect(config.cdp_port).toBe(9222);
  });
});
