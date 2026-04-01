export type HostEnvironment = "openclaw" | "openai" | "native" | "mcp" | "unknown";

export interface BrowserPathConfig {
  binary_path?: string;
  cdp_port?: number;
  headless: boolean;
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

/** Get browser configuration appropriate for the detected host */
export function getBrowserConfig(env?: HostEnvironment): BrowserPathConfig {
  const detected = env ?? detectHostEnvironment();
  switch (detected) {
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
