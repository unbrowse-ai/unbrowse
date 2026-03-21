import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";

const requireFromHere = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 120_000;

export type ToolParams = {
  action:
    | "resolve"
    | "search"
    | "execute"
    | "login"
    | "skills"
    | "skill"
    | "health";
  intent?: string;
  url?: string;
  domain?: string;
  skillId?: string;
  endpointId?: string;
  path?: string;
  extract?: string;
  limit?: number;
  pretty?: boolean;
  confirmUnsafe?: boolean;
  dryRun?: boolean;
};

export type PluginConfig = {
  baseUrl: string;
  binPath: string;
  timeoutMs: number;
  routingMode: "strict" | "fallback";
  healthcheckOnStart: boolean;
};

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export function getConfig(runtime: IAgentRuntime): PluginConfig {
  const baseUrl = runtime.getSetting?.("UNBROWSE_BASE_URL") ?? "";
  const routingMode = runtime.getSetting?.("UNBROWSE_ROUTING_MODE") ?? "strict";
  const binPath = runtime.getSetting?.("UNBROWSE_BIN_PATH") ?? "";
  const timeoutStr = runtime.getSetting?.("UNBROWSE_TIMEOUT_MS") ?? "";
  const timeoutMs = timeoutStr ? parseInt(timeoutStr, 10) : DEFAULT_TIMEOUT_MS;
  const healthcheck = runtime.getSetting?.("UNBROWSE_HEALTHCHECK_ON_START") ?? "true";

  return {
    baseUrl: typeof baseUrl === "string" ? baseUrl.trim() : "",
    binPath: typeof binPath === "string" ? binPath.trim() : "",
    timeoutMs: Number.isFinite(timeoutMs)
      ? Math.max(1_000, Math.min(300_000, timeoutMs))
      : DEFAULT_TIMEOUT_MS,
    routingMode: routingMode === "fallback" ? "fallback" : "strict",
    healthcheckOnStart: healthcheck !== "false",
  };
}

export function resolveUnbrowseBin(config: PluginConfig): string {
  if (config.binPath) return config.binPath;
  const packageJsonPath = requireFromHere.resolve("unbrowse/package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const declaredBin =
    typeof pkg.bin === "string"
      ? pkg.bin
      : Object.values(pkg.bin ?? {}).find(
          (value) => typeof value === "string"
        );
  return join(dirname(packageJsonPath), declaredBin ?? "bin/unbrowse.js");
}

function pushFlag(
  args: string[],
  name: string,
  value: string | number | boolean | undefined
): void {
  if (value === undefined || value === false || value === "") return;
  args.push(`--${name}`);
  if (value !== true) args.push(String(value));
}

export function buildArgs(params: ToolParams): string[] {
  switch (params.action) {
    case "health":
      return ["health"];
    case "skills":
      return ["skills"];
    case "skill":
      if (!params.skillId) throw new Error("skillId required for action=skill");
      return ["skill", params.skillId];
    case "login":
      if (!params.url) throw new Error("url required for action=login");
      return ["login", "--url", params.url];
    case "search": {
      if (!params.intent)
        throw new Error("intent required for action=search");
      const args = ["search", "--intent", params.intent];
      pushFlag(args, "domain", params.domain);
      return args;
    }
    case "execute": {
      if (!params.skillId)
        throw new Error("skillId required for action=execute");
      if (!params.endpointId)
        throw new Error("endpointId required for action=execute");
      const args = [
        "execute",
        "--skill",
        params.skillId,
        "--endpoint",
        params.endpointId,
      ];
      pushFlag(args, "path", params.path);
      pushFlag(args, "extract", params.extract);
      pushFlag(args, "limit", params.limit);
      pushFlag(args, "pretty", params.pretty);
      pushFlag(args, "dry-run", params.dryRun);
      pushFlag(args, "confirm-unsafe", params.confirmUnsafe);
      return args;
    }
    case "resolve": {
      if (!params.intent)
        throw new Error("intent required for action=resolve");
      if (!params.url) throw new Error("url required for action=resolve");
      const args = [
        "resolve",
        "--intent",
        params.intent,
        "--url",
        params.url,
      ];
      pushFlag(args, "path", params.path);
      pushFlag(args, "extract", params.extract);
      pushFlag(args, "limit", params.limit);
      pushFlag(args, "pretty", params.pretty);
      pushFlag(args, "dry-run", params.dryRun);
      pushFlag(args, "confirm-unsafe", params.confirmUnsafe);
      return args;
    }
    default:
      throw new Error(
        `Unsupported action: ${(params as { action: string }).action}`
      );
  }
}

export function summarizeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "Unbrowse finished with no stdout.";

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.error === "string" && parsed.error.trim())
      return `Unbrowse error: ${parsed.error}`;
    if (typeof parsed.message === "string" && parsed.message.trim())
      return parsed.message;
    if (parsed.data && typeof parsed.data === "object")
      return "Unbrowse returned structured data.";
    return "Unbrowse returned JSON output.";
  } catch {
    return trimmed.split("\n").slice(0, 4).join("\n");
  }
}

export function parseMaybeJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export async function runCommand(
  binPath: string,
  args: string[],
  config: PluginConfig
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: {
        ...process.env,
        ...(config.baseUrl ? { UNBROWSE_URL: config.baseUrl } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, config.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut && !signal) {
        resolve({
          ok: false,
          stdout,
          stderr: `${stderr}\nTimed out after ${config.timeoutMs}ms`.trim(),
          exitCode: 124,
          signal: null,
        });
        return;
      }
      resolve({ ok: exitCode === 0, stdout, stderr, exitCode, signal });
    });
  });
}
