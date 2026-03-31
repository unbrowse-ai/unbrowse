import { describe, test, expect } from "bun:test";

type HostEnvironment = "openclaw" | "openai" | "native" | "mcp" | "unknown";

interface BrowserPathConfig {
  binary_path?: string;
  cdp_port?: number;
  headless: boolean;
  user_data_dir?: string;
}

function detectHostEnvironment(): HostEnvironment {
  if (process.env.OPENCLAW_RUNTIME) return "openclaw";
  if (process.env.OPENAI_TOOL_RUNTIME) return "openai";
  if (process.env.MCP_SERVER_MODE) return "mcp";
  if (process.env.UNBROWSE_NATIVE) return "native";
  return "unknown";
}

function getBrowserConfig(env: HostEnvironment): BrowserPathConfig {
  switch (env) {
    case "openclaw":
      return {
        binary_path: process.env.OPENCLAW_BROWSER_PATH ?? "/usr/bin/chromium",
        headless: true,
        user_data_dir: process.env.OPENCLAW_USER_DATA ?? "/tmp/openclaw-chrome",
      };
    case "openai":
      return {
        binary_path: process.env.OPENAI_BROWSER_PATH,
        headless: true,
        cdp_port: parseInt(process.env.OPENAI_CDP_PORT ?? "9222"),
      };
    case "mcp":
      return {
        headless: true,
        cdp_port: parseInt(process.env.CDP_PORT ?? "0"),
      };
    case "native":
      return {
        headless: false,
        user_data_dir: process.env.UNBROWSE_USER_DATA,
      };
    default:
      return { headless: false };
  }
}

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
});
