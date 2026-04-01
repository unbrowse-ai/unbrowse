export interface RuntimeSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  healthCheck(): Promise<{ healthy: boolean; uptime_ms: number }>;
}

export interface LoginUXConfig {
  interactive: boolean;
  timeout_ms: number;
  fallback_strategy: "skip" | "fail" | "prompt";
  progress_callback?: (message: string) => void;
}

export type HostType = "openclaw" | "mcp" | "hermes" | "elizaos" | "langchain" | "cli" | "unknown";

export interface HostIntegration {
  type: HostType;
  name: string;
  version: string;
  capabilities: string[];
  status: "active" | "planned" | "deprecated";
}

export const SUPPORTED_HOSTS: HostIntegration[] = [
  { type: "openclaw", name: "OpenClaw", version: "1.0", capabilities: ["capture", "execute", "search"], status: "active" },
  { type: "mcp", name: "MCP Server", version: "1.0", capabilities: ["execute", "search"], status: "active" },
  { type: "hermes", name: "Hermes", version: "0.1", capabilities: ["execute"], status: "planned" },
  { type: "elizaos", name: "ElizaOS", version: "0.1", capabilities: ["execute"], status: "planned" },
  { type: "langchain", name: "LangChain", version: "0.1", capabilities: ["execute", "search"], status: "planned" },
  { type: "cli", name: "CLI", version: "2.0", capabilities: ["capture", "execute", "search", "publish"], status: "active" },
];

export function getDefaultLoginConfig(headless: boolean): LoginUXConfig {
  return {
    interactive: !headless,
    timeout_ms: headless ? 30_000 : 120_000,
    fallback_strategy: headless ? "skip" : "prompt",
  };
}

/**
 * Local runtime server supervisor stub.
 * Manages the lifecycle of the local Unbrowse runtime server.
 */
export class LocalSupervisor implements RuntimeSupervisor {
  private running = false;
  private startTime = 0;

  async start(): Promise<void> {
    this.running = true;
    this.startTime = Date.now();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async healthCheck(): Promise<{ healthy: boolean; uptime_ms: number }> {
    return {
      healthy: this.running,
      uptime_ms: this.running ? Date.now() - this.startTime : 0,
    };
  }
}
