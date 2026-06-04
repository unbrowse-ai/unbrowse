// Public surface for the telemetry module. Callers should depend on
// `getSessionLogger()` and the types — never instantiate RealSessionLogger
// directly.

import { getTelemetryConfig, type ResolvedTelemetryConfig } from "./config.js";
import { createSessionLogger, type SessionLogger, type SessionMeta } from "./session-log.js";

export type { ResolvedTelemetryConfig, TelemetryConfig } from "./config.js";
export type { SessionLogger, SessionMeta } from "./session-log.js";
export {
  getTelemetryConfig,
  writeTelemetryConfig,
  getConfigPath,
  getSessionsDir,
  ensureSessionsDir,
  getUnbrowseHome,
} from "./config.js";
export {
  scrubText,
  templateUrl,
  fingerprintIntent,
  sanitizeArgs,
  summarizeResponse,
  extractErrorCode,
  shaHex,
} from "./sanitize.js";
export { hashNotes, sessionFileExists } from "./session-log.js";

let singleton: SessionLogger | undefined;
let resolvedConfig: ResolvedTelemetryConfig | undefined;

export function getSessionLogger(meta?: SessionMeta): SessionLogger {
  if (singleton) return singleton;
  resolvedConfig = getTelemetryConfig();
  const sessionMeta: SessionMeta = meta ?? {
    mcp_version: process.env.UNBROWSE_VERSION ?? "unknown",
    node_version: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  singleton = createSessionLogger(resolvedConfig, sessionMeta);
  return singleton;
}

export function getResolvedTelemetryConfig(): ResolvedTelemetryConfig {
  if (resolvedConfig) return resolvedConfig;
  resolvedConfig = getTelemetryConfig();
  return resolvedConfig;
}

// Test-only: reset the singleton so a freshly-imported config is picked up.
// Production code never calls this.
export function __resetSessionLoggerForTests(): void {
  if (singleton) {
    try {
      singleton.end();
    } catch {
      // ignore
    }
  }
  singleton = undefined;
  resolvedConfig = undefined;
}
