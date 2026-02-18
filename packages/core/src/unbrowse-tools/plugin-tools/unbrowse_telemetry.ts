import { setTelemetryConfigFile, loadTelemetryConfig, type TelemetryLevel } from "../../telemetry-client.js";

export const TELEMETRY_SCHEMA = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["status", "opt_in", "opt_out", "set_level"],
      description: "Telemetry action",
    },
    level: {
      type: "string" as const,
      enum: ["minimal", "standard", "debug"],
      description: "Telemetry level (only for set_level)",
    },
  },
  required: ["action"] as string[],
};

import type { ToolDeps } from "./deps.js";

export function makeUnbrowseTelemetryTool(deps: ToolDeps) {
  const { logger } = deps;

  return {
    name: "unbrowse_telemetry",
    label: "Telemetry",
    description: "Configure anonymous telemetry (opt-out). No credentials, headers, cookies, or full URLs are sent.",
    parameters: TELEMETRY_SCHEMA,
    async execute(_toolCallId: string, params: unknown) {
      const p = params as { action: string; level?: TelemetryLevel };

      const current = loadTelemetryConfig({ pluginConfig: deps.pluginConfig });

      if (p.action === "status") {
        return { content: [{ type: "text", text: `Telemetry: ${current.enabled ? "ENABLED" : "DISABLED"} (level=${current.level})` }] };
      }

      if (p.action === "opt_out") {
        setTelemetryConfigFile({ enabled: false, level: current.level });
        logger.info("[unbrowse] Telemetry opt-out saved.");
        return { content: [{ type: "text", text: `Telemetry: DISABLED` }] };
      }

      if (p.action === "opt_in") {
        setTelemetryConfigFile({ enabled: true, level: current.level });
        logger.info("[unbrowse] Telemetry opt-in saved.");
        return { content: [{ type: "text", text: `Telemetry: ENABLED (level=${current.level})` }] };
      }

      if (p.action === "set_level") {
        const level = p.level;
        if (level !== "minimal" && level !== "standard" && level !== "debug") {
          return { content: [{ type: "text", text: `Invalid level. Use minimal|standard|debug.` }] };
        }
        setTelemetryConfigFile({ enabled: current.enabled, level });
        logger.info(`[unbrowse] Telemetry level set to ${level}.`);
        return { content: [{ type: "text", text: `Telemetry: ${current.enabled ? "ENABLED" : "DISABLED"} (level=${level})` }] };
      }

      return { content: [{ type: "text", text: `Unknown action: ${String(p.action)}` }] };
    },
  };
}
