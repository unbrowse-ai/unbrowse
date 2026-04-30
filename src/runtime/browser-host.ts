export type HostEnvironment = "openclaw" | "openai" | "native" | "mcp" | "unknown";

/** Detect the host environment from environment variables */
export function detectHostEnvironment(): HostEnvironment {
  if (process.env.OPENCLAW_RUNTIME) return "openclaw";
  if (process.env.OPENAI_TOOL_RUNTIME) return "openai";
  if (process.env.MCP_SERVER_MODE) return "mcp";
  if (process.env.UNBROWSE_NATIVE) return "native";
  return "unknown";
}

