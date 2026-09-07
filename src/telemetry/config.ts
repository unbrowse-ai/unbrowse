// MCP telemetry config — read/write the `telemetry` block of
// ~/.unbrowse/config.json, honouring UNBROWSE_TELEMETRY env override.
//
// Hardcoding guard: no defaults baked in beyond "enabled: true" + the
// upload endpoint. Anything richer (sampling, opt-in tiers, etc.) gets
// added when there's evidence we need it — not pre-emptively.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_UPLOAD_ENDPOINT = "https://beta-api.unbrowse.ai/v1/telemetry/session";

export type TelemetryConfig = {
  enabled: boolean;
  session_id_seed: string;
  upload_endpoint: string;
  link_account: boolean;
};

export type ResolvedTelemetryConfig = TelemetryConfig & {
  source: "env-disabled" | "config" | "default";
  config_path: string;
  sessions_dir: string;
};

export function getUnbrowseHome(): string {
  // UNBROWSE_HOME (U-3) is the explicit data-root override and wins.
  const override = process.env.UNBROWSE_HOME?.trim();
  if (override) return override;
  // Honour $HOME so tests can sandbox with HOME=$(mktemp -d).
  const home = process.env.HOME || homedir();
  return path.join(home, ".unbrowse");
}

export function getConfigPath(): string {
  return path.join(getUnbrowseHome(), "config.json");
}

export function getSessionsDir(): string {
  return path.join(getUnbrowseHome(), "sessions");
}

function readConfigFile(): Record<string, unknown> {
  const p = getConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfigFile(updated: Record<string, unknown>): void {
  const dir = getUnbrowseHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(updated, null, 2), "utf8");
}

function defaultConfig(): TelemetryConfig {
  return {
    enabled: true,
    session_id_seed: randomUUID(),
    upload_endpoint: DEFAULT_UPLOAD_ENDPOINT,
    link_account: true,
  };
}

export function getTelemetryConfig(): ResolvedTelemetryConfig {
  const env = process.env.UNBROWSE_TELEMETRY;
  // Env override wins. "0" / "false" / "off" → forced disabled regardless of
  // file state. Any other env value falls through to config.
  const envDisabled = env === "0" || env === "false" || env === "off";

  const file = readConfigFile();
  const raw = (file.telemetry as Partial<TelemetryConfig> | undefined) ?? {};

  const resolved: TelemetryConfig = {
    enabled: raw.enabled ?? true,
    session_id_seed: raw.session_id_seed ?? randomUUID(),
    upload_endpoint: raw.upload_endpoint ?? DEFAULT_UPLOAD_ENDPOINT,
    link_account: raw.link_account ?? true,
  };

  const source: ResolvedTelemetryConfig["source"] = envDisabled
    ? "env-disabled"
    : raw.enabled !== undefined
      ? "config"
      : "default";

  return {
    ...resolved,
    enabled: envDisabled ? false : resolved.enabled,
    source,
    config_path: getConfigPath(),
    sessions_dir: getSessionsDir(),
  };
}

export function writeTelemetryConfig(patch: Partial<TelemetryConfig>): ResolvedTelemetryConfig {
  const file = readConfigFile();
  const current = (file.telemetry as Partial<TelemetryConfig> | undefined) ?? {};
  const merged: TelemetryConfig = {
    enabled: patch.enabled ?? current.enabled ?? true,
    session_id_seed: patch.session_id_seed ?? current.session_id_seed ?? randomUUID(),
    upload_endpoint: patch.upload_endpoint ?? current.upload_endpoint ?? DEFAULT_UPLOAD_ENDPOINT,
    link_account: patch.link_account ?? current.link_account ?? true,
  };
  file.telemetry = merged;
  writeConfigFile(file);
  return getTelemetryConfig();
}

export function ensureSessionsDir(): string {
  const dir = getSessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
