import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";

export type TelemetryLevel = "minimal" | "standard" | "debug";
export type TelemetryConfig = { enabled: boolean; level: TelemetryLevel };

const TELEMETRY_DIR = join(homedir(), ".openclaw", "unbrowse");
const DEVICE_ID_PATH = join(TELEMETRY_DIR, "device-id.json");
const TELEMETRY_CFG_PATH = join(TELEMETRY_DIR, "telemetry.json");

function safeJsonParse<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function loadTelemetryConfig(opts?: { pluginConfig?: any }): TelemetryConfig {
  // 1) File override (tool-driven opt-out)
  if (existsSync(TELEMETRY_CFG_PATH)) {
    const parsed = safeJsonParse<any>(readFileSync(TELEMETRY_CFG_PATH, "utf-8"));
    if (parsed && typeof parsed.enabled === "boolean") {
      const level: TelemetryLevel =
        parsed.level === "minimal" || parsed.level === "standard" || parsed.level === "debug"
          ? parsed.level
          : "standard";
      return { enabled: parsed.enabled, level };
    }
  }

  // 2) Plugin config
  const cfg = opts?.pluginConfig ?? {};
  const enabled = (cfg.telemetryEnabled as boolean | undefined);
  const level = (cfg.telemetryLevel as TelemetryLevel | undefined);
  return {
    enabled: enabled ?? true,
    level: level === "minimal" || level === "standard" || level === "debug" ? level : "standard",
  };
}

export function setTelemetryConfigFile(cfg: TelemetryConfig): void {
  mkdirSync(TELEMETRY_DIR, { recursive: true });
  writeFileSync(
    TELEMETRY_CFG_PATH,
    JSON.stringify({ enabled: cfg.enabled, level: cfg.level, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

export function getOrCreateDeviceId(): string {
  try {
    if (existsSync(DEVICE_ID_PATH)) {
      const parsed = safeJsonParse<any>(readFileSync(DEVICE_ID_PATH, "utf-8"));
      if (parsed?.deviceId && typeof parsed.deviceId === "string") return parsed.deviceId;
    }
  } catch { /* ignore */ }

  mkdirSync(TELEMETRY_DIR, { recursive: true });
  const deviceId = crypto.randomUUID();
  try {
    writeFileSync(DEVICE_ID_PATH, JSON.stringify({ deviceId, createdAt: new Date().toISOString() }, null, 2), "utf-8");
  } catch { /* ignore */ }
  return deviceId;
}

function redactString(s: string): string {
  let out = String(s);
  // Basic token redactions
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, "Bearer [REDACTED]");
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{10,})\b/g, "[REDACTED_API_KEY]");
  if (out.length > 280) out = `${out.slice(0, 280)}…`;
  return out;
}

function safeProps(props: Record<string, any> | undefined, level: TelemetryLevel): Record<string, any> {
  const p = props && typeof props === "object" ? props : {};
  const out: Record<string, any> = {};

  // Always-safe keys (no URLs, no raw text, no headers/cookies).
  const allow = new Set([
    "tool",
    "ok",
    "statusCode",
    "durationMs",
    "errorName",
    "errorType",
    "domainHash",
    "executionMode",
    "skillMode",
    "endpointCount",
    "endpointGroups",
    "merged",
    "qualityScore",
    "hasWallet",
    "browserConnect",
  ]);

  for (const [k, v] of Object.entries(p)) {
    if (!allow.has(k)) continue;
    if (typeof v === "string") out[k] = redactString(v);
    else if (typeof v === "number" || typeof v === "boolean" || v == null) out[k] = v;
    else if (Array.isArray(v) && level !== "minimal") out[k] = v.slice(0, 12);
  }

  // Debug adds a little more, still redacted.
  if (level === "debug") {
    for (const [k, v] of Object.entries(p)) {
      if (k.toLowerCase().includes("url") || k.toLowerCase().includes("cookie") || k.toLowerCase().includes("header")) continue;
      if (typeof v === "string" && v.length <= 120) out[`dbg_${k}`] = redactString(v);
    }
  }

  return out;
}

export function hashDomain(domain: string): string {
  const d = String(domain ?? "").toLowerCase().trim();
  if (!d) return "";
  return crypto.createHash("sha256").update(d).digest("hex").slice(0, 12);
}

export function createTelemetryClient(opts: {
  indexUrl: string;
  pluginConfig?: any;
  pluginVersion: string;
  platform: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  const deviceId = getOrCreateDeviceId();
  const queue: Array<{ event: string; properties?: Record<string, any>; timestamp: number }> = [];

  const flush = async (): Promise<void> => {
    const cfg = loadTelemetryConfig({ pluginConfig: opts.pluginConfig });
    if (!cfg.enabled) return;
    if (queue.length === 0) return;

    const batch = queue.splice(0, 100);
    const payload = {
      deviceId,
      pluginVersion: opts.pluginVersion,
      platform: opts.platform,
      events: batch.map((e) => ({
        event: e.event,
        properties: safeProps(e.properties, cfg.level),
        timestamp: e.timestamp,
      })),
    };

    try {
      await fetch(`${opts.indexUrl.replace(/\/$/, "")}/telemetry/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      // Non-blocking; drop on failures to avoid slowing the agent.
      opts.logger.warn(`[unbrowse] Telemetry flush failed: ${(err as Error).message ?? String(err)}`);
    }
  };

  const record = (event: string, properties?: Record<string, any>) => {
    const cfg = loadTelemetryConfig({ pluginConfig: opts.pluginConfig });
    if (!cfg.enabled) return;
    queue.push({ event, properties, timestamp: Date.now() });
    // Best-effort micro-batching
    if (queue.length >= 20) void flush();
  };

  return { record, flush, deviceId };
}
