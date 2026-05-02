export type HostEnvironment = "openclaw" | "openai" | "native" | "mcp" | "unknown";

export interface BrowserPathConfig {
  headless: boolean;
  cdp_port?: number;
  binary_path?: string;
  user_data_dir?: string;
}

/** Detect the host environment from environment variables */
export function detectHostEnvironment(): HostEnvironment {
  if (process.env.OPENCLAW_RUNTIME) return "openclaw";
  if (process.env.OPENAI_TOOL_RUNTIME) return "openai";
  if (process.env.MCP_SERVER_MODE) return "mcp";
  if (process.env.UNBROWSE_NATIVE) return "native";
  return "unknown";
}

/**
 * Browser configuration per host environment. Headless / CDP / binary paths
 * are derived from the host detection so each runtime gets the right defaults
 * without per-host branching at the call site.
 */
export function getBrowserConfig(host?: HostEnvironment): BrowserPathConfig {
  const resolved = host ?? detectHostEnvironment();
  switch (resolved) {
    case "openclaw":
      return {
        headless: true,
        binary_path: "/usr/bin/chromium",
        user_data_dir: "/tmp/openclaw-chrome",
      };
    case "openai":
      return {
        headless: true,
        cdp_port: 9222,
      };
    case "mcp":
      return { headless: true };
    case "native":
      return { headless: false };
    case "unknown":
    default:
      return { headless: false };
  }
}
