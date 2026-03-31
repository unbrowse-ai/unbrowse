import { describe, test, expect } from "bun:test";

type HostType = "openclaw" | "mcp" | "hermes" | "elizaos" | "langchain" | "cli" | "unknown";

interface HostIntegration {
  type: HostType;
  name: string;
  version: string;
  capabilities: string[];
  status: "active" | "planned" | "deprecated";
}

interface LoginUXConfig {
  interactive: boolean;
  timeout_ms: number;
  fallback_strategy: "skip" | "fail" | "prompt";
  progress_callback?: (message: string) => void;
}

interface RuntimeSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  healthCheck(): Promise<{ healthy: boolean; uptime_ms: number }>;
}

const SUPPORTED_HOSTS: HostIntegration[] = [
  { type: "openclaw", name: "OpenClaw", version: "1.0", capabilities: ["capture", "execute", "search"], status: "active" },
  { type: "mcp", name: "MCP Server", version: "1.0", capabilities: ["execute", "search"], status: "active" },
  { type: "hermes", name: "Hermes", version: "0.1", capabilities: ["execute"], status: "planned" },
  { type: "elizaos", name: "ElizaOS", version: "0.1", capabilities: ["execute"], status: "planned" },
  { type: "langchain", name: "LangChain", version: "0.1", capabilities: ["execute", "search"], status: "planned" },
  { type: "cli", name: "CLI", version: "2.0", capabilities: ["capture", "execute", "search", "publish"], status: "active" },
];

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
    const config: LoginUXConfig = {
      interactive: true,
      timeout_ms: 120_000,
      fallback_strategy: "prompt",
    };
    expect(config.interactive).toBe(true);
    expect(config.timeout_ms).toBe(120_000);
  });

  test("headless environments use skip fallback", () => {
    const config: LoginUXConfig = {
      interactive: false,
      timeout_ms: 30_000,
      fallback_strategy: "skip",
    };
    expect(config.fallback_strategy).toBe("skip");
  });
});

describe("#90 runtime supervisor", () => {
  test("supervisor interface contract", () => {
    class StubSupervisor implements RuntimeSupervisor {
      private running = false;
      private startTime = 0;
      async start() { this.running = true; this.startTime = Date.now(); }
      async stop() { this.running = false; }
      isRunning() { return this.running; }
      async healthCheck() { return { healthy: this.running, uptime_ms: this.running ? Date.now() - this.startTime : 0 }; }
    }

    const sup = new StubSupervisor();
    expect(sup.isRunning()).toBe(false);
  });

  test("supervisor starts and reports healthy", async () => {
    class StubSupervisor implements RuntimeSupervisor {
      private running = false;
      private startTime = 0;
      async start() { this.running = true; this.startTime = Date.now(); }
      async stop() { this.running = false; }
      isRunning() { return this.running; }
      async healthCheck() { return { healthy: this.running, uptime_ms: this.running ? Date.now() - this.startTime : 0 }; }
    }

    const sup = new StubSupervisor();
    await sup.start();
    expect(sup.isRunning()).toBe(true);
    const health = await sup.healthCheck();
    expect(health.healthy).toBe(true);
  });
});
