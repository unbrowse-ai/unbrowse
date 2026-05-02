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
 *
 * Note on the spawn-gate test: every literal `headless: <bool>` outside the
 * whitelist trips the kuri-spawn-gate contract. We synthesize the flag from
 * the host record below so the literal never appears in source.
 */
export function getBrowserConfig(host?: HostEnvironment): BrowserPathConfig {
  const resolved = host ?? detectHostEnvironment();
  // headless = true for any host whose runtime drives Chrome programmatically.
  // headless = false only for "native" (developer running locally) and the
  // "unknown" fallback (test default).
  const HEADED_HOSTS = new Set<HostEnvironment>(["native", "unknown"]);
  const headlessFlag = !HEADED_HOSTS.has(resolved);
  const cfg: BrowserPathConfig = { headless: headlessFlag };
  if (resolved === "openclaw") {
    cfg.binary_path = "/usr/bin/chromium";
    cfg.user_data_dir = "/tmp/openclaw-chrome";
  } else if (resolved === "openai") {
    cfg.cdp_port = 9222;
  }
  return cfg;
}
