import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const requireFromHere = createRequire(import.meta.url);
const PLUGIN_ID = "unbrowse-openclaw";
const TOOL_NAME = "unbrowse";
const BOOTSTRAP_GUIDE_PATH = "UNBROWSE_BROWSER.md";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ROUTING_MODE = "strict";

type PluginConfig = {
  baseUrl?: string;
  routingMode?: "strict" | "fallback";
  binPath?: string;
  timeoutMs?: number;
  preferInBootstrap?: boolean;
  allowBrowserFallback?: boolean;
  healthcheckOnStart?: boolean;
  logStderr?: boolean;
};

type ToolParams = {
  action: "resolve" | "search" | "execute" | "login" | "skills" | "skill" | "health";
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

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type CompatibleRegisterHook = OpenClawPluginApi["registerHook"];
type CompatibleHookOptions = Parameters<CompatibleRegisterHook>[2];
type BeforeToolCallEvent = {
  toolName?: string;
};

function getPluginVersion(): string {
  try {
    const packageJsonPath = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function normalizeConfig(raw: unknown): Required<PluginConfig> {
  const cfg = (raw ?? {}) as PluginConfig;
  const timeoutMs =
    typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs)
      ? Math.max(1_000, Math.min(300_000, Math.trunc(cfg.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;

  return {
    baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl.trim() : "",
    routingMode: cfg.routingMode === "strict" ? "strict" : DEFAULT_ROUTING_MODE,
    binPath: typeof cfg.binPath === "string" ? cfg.binPath.trim() : "",
    timeoutMs,
    preferInBootstrap: cfg.preferInBootstrap !== false,
    allowBrowserFallback: cfg.routingMode === "strict" ? false : cfg.allowBrowserFallback !== false,
    healthcheckOnStart: cfg.healthcheckOnStart !== false,
    logStderr: cfg.logStderr === true,
  };
}

function resolveUnbrowseBin(config: Required<PluginConfig>): string {
  if (config.binPath) return config.binPath;
  const packageJsonPath = requireFromHere.resolve("unbrowse/package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const declaredBin = typeof pkg.bin === "string"
    ? pkg.bin
    : Object.values(pkg.bin ?? {}).find((value) => typeof value === "string");
  return join(dirname(packageJsonPath), declaredBin ?? "bin/unbrowse.js");
}

function pushFlag(args: string[], name: string, value: string | number | boolean | undefined): void {
  if (value === undefined || value === false || value === "") return;
  args.push(`--${name}`);
  if (value !== true) args.push(String(value));
}

function buildArgs(params: ToolParams): string[] {
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
      if (!params.intent) throw new Error("intent required for action=search");
      const args = ["search", "--intent", params.intent];
      pushFlag(args, "domain", params.domain);
      return args;
    }
    case "execute": {
      if (!params.skillId) throw new Error("skillId required for action=execute");
      if (!params.endpointId) throw new Error("endpointId required for action=execute");
      const args = ["execute", "--skill", params.skillId, "--endpoint", params.endpointId];
      pushFlag(args, "url", params.url);
      pushFlag(args, "intent", params.intent);
      pushFlag(args, "path", params.path);
      pushFlag(args, "extract", params.extract);
      pushFlag(args, "limit", params.limit);
      pushFlag(args, "pretty", params.pretty);
      pushFlag(args, "dry-run", params.dryRun);
      pushFlag(args, "confirm-unsafe", params.confirmUnsafe);
      return args;
    }
    case "resolve": {
      if (!params.intent) throw new Error("intent required for action=resolve");
      if (!params.url) throw new Error("url required for action=resolve");
      const args = ["resolve", "--intent", params.intent, "--url", params.url];
      pushFlag(args, "path", params.path);
      pushFlag(args, "extract", params.extract);
      pushFlag(args, "limit", params.limit);
      pushFlag(args, "pretty", params.pretty);
      pushFlag(args, "dry-run", params.dryRun);
      pushFlag(args, "confirm-unsafe", params.confirmUnsafe);
      return args;
    }
    default:
      throw new Error(`Unsupported action: ${(params as { action: string }).action}`);
  }
}

function summarizeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "Unbrowse finished with no stdout.";

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.error === "string" && parsed.error.trim()) return `Unbrowse error: ${parsed.error}`;
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
    if (parsed.data && typeof parsed.data === "object") return "Unbrowse returned structured data.";
    return "Unbrowse returned JSON output.";
  } catch {
    return trimmed.split("\n").slice(0, 4).join("\n");
  }
}

function parseMaybeJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function hasErrorPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.error === "string" && rec.error.trim()) return true;
  if (rec.result && typeof rec.result === "object") {
    const nested = rec.result as Record<string, unknown>;
    if (typeof nested.error === "string" && nested.error.trim()) return true;
  }
  return false;
}

function registerCompatibleHook(
  api: OpenClawPluginApi,
  event: string,
  handler: unknown,
  options?: CompatibleHookOptions,
): void {
  api.registerHook(
    event,
    handler as Parameters<CompatibleRegisterHook>[1],
    options,
  );
}

async function runCommand(binPath: string, args: string[], config: Required<PluginConfig>): Promise<CommandResult> {
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
        resolve({ ok: false, stdout, stderr: `${stderr}\nTimed out after ${config.timeoutMs}ms`.trim(), exitCode: 124, signal: null });
        return;
      }
      resolve({
        ok: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        signal,
      });
    });
  });
}

function buildBootstrapGuide(config: Required<PluginConfig>): string {
  const template = readFileSync(new URL("./prompts/UNBROWSE_BROWSER.md", import.meta.url), "utf8");
  const fallbackLine = config.allowBrowserFallback
    ? "- Fall back to `browser` only for login-only flows, visual verification, canvas/file-upload work, or when Unbrowse cannot discover a usable API path."
    : "- Do not use `browser` for normal website work. Stay on `unbrowse` and report when the task is unsupported.";
  const policyRule = config.routingMode === "strict"
    ? "- This plugin is in strict mode. Treat `unbrowse` as mandatory for normal web tasks."
    : "- This plugin is in fallback mode. Prefer `unbrowse` first, then fall back only when the task truly needs browser automation.";

  return template
    .replace("{{FALLBACK_RULE}}", fallbackLine)
    .replace("{{BROWSER_POLICY_RULE}}", policyRule);
}

function buildPromptGuidance(config: Required<PluginConfig>): string {
  const lines = [
    "Web-routing policy:",
    "- The `unbrowse` tool is the preferred website path in this workspace.",
    "- Use `unbrowse` first for website retrieval, search, extraction, authenticated reads, and API-backed workflows.",
    "- Use `browser` only for visual QA, selector/pixel work, drag-drop, canvas apps, uploads/downloads, or when Unbrowse has no usable path.",
  ];

  if (config.routingMode === "strict") {
    lines.push("- Strict mode is on. Avoid `browser` for normal website work.");
  }

  return lines.join("\n");
}

function buildBrowserFallbackBlockReason(): string {
  return [
    "`browser` is disabled by unbrowse-openclaw strict mode.",
    "Use `unbrowse` for normal website work, or switch the plugin to fallback mode if you truly need legacy UI automation.",
  ].join(" ");
}

function buildSuggestedConfig(mode: "strict" | "fallback"): string {
  return [
    "{",
    "  plugins: {",
    "    entries: {",
    `      "${PLUGIN_ID}": {`,
    "        enabled: true,",
    "        config: {",
    `          routingMode: "${mode}",`,
    "          preferInBootstrap: true,",
    "          timeoutMs: 120000",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
}

export const __test = {
  buildArgs,
  buildPromptGuidance,
  buildBrowserFallbackBlockReason,
  buildBootstrapGuide,
  buildSuggestedConfig,
  normalizeConfig,
  resolveUnbrowseBin,
};

const plugin = {
  id: PLUGIN_ID,
  name: "Unbrowse Browser",
  description: "Routes website tasks through the local Unbrowse CLI before pixel browser automation.",
  register(api: OpenClawPluginApi) {
    const config = normalizeConfig(api.pluginConfig);
    const binPath = resolveUnbrowseBin(config);
    const version = getPluginVersion();

    api.logger.info(`${PLUGIN_ID}@${version}: registered (bin: ${binPath})`);

    api.registerTool({
      name: TOOL_NAME,
      label: "Unbrowse",
      description:
        "Preferred website tool. Use this first for website data extraction, search, authenticated reads, and API discovery. Prefer it over the core browser tool unless the task truly needs pixel-level UI interaction.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("resolve"),
          Type.Literal("search"),
          Type.Literal("execute"),
          Type.Literal("login"),
          Type.Literal("skills"),
          Type.Literal("skill"),
          Type.Literal("health"),
        ]),
        intent: Type.Optional(Type.String({ description: "Plain-English task or marketplace search intent" })),
        url: Type.Optional(Type.String({ description: "Target website URL" })),
        domain: Type.Optional(Type.String({ description: "Optional domain filter for search" })),
        skillId: Type.Optional(Type.String({ description: "Skill id for skill/execute actions" })),
        endpointId: Type.Optional(Type.String({ description: "Endpoint id for execute action" })),
        path: Type.Optional(Type.String({ description: "Optional response path extraction hint" })),
        extract: Type.Optional(Type.String({ description: "Comma-separated fields or alias:path spec" })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
        pretty: Type.Optional(Type.Boolean({ description: "Ask Unbrowse CLI for pretty output where supported" })),
        confirmUnsafe: Type.Optional(Type.Boolean({ description: "Allow non-GET execution when required" })),
        dryRun: Type.Optional(Type.Boolean({ description: "Preview unsafe execution without side effects" })),
      }),
      async execute(_toolCallId, rawParams) {
        try {
          const params = rawParams as ToolParams;
          const args = buildArgs(params);
          const result = await runCommand(binPath, args, config);
          const parsed = parseMaybeJson(result.stdout);
          const stderr = config.logStderr || !result.ok ? result.stderr.trim() : "";
          const failed = !result.ok || hasErrorPayload(parsed);

          if (failed) {
            return {
              content: [{
                type: "text",
                text: `Unbrowse command failed for action=${params.action}. ${stderr || summarizeOutput(result.stdout)}`,
              }],
              details: {
                ok: false,
                action: params.action,
                args,
                exitCode: result.exitCode,
                signal: result.signal,
                stdout: parsed,
                stderr,
              },
            };
          }

          return {
            content: [{
              type: "text",
              text: summarizeOutput(result.stdout),
            }],
            details: {
              ok: true,
              action: params.action,
              args,
              result: parsed,
              ...(stderr ? { stderr } : {}),
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Unbrowse invocation failed: ${message}` }],
            details: {
              ok: false,
              error: message,
            },
          };
        }
      },
    });

    if (config.preferInBootstrap) {
      registerCompatibleHook(api, "before_prompt_build", async () => ({
        systemPrompt: buildPromptGuidance(config),
      }), {
        name: `${PLUGIN_ID}.before-prompt-build`,
        description: "Reinforce Unbrowse as the default browser path before prompt build",
      });

      api.registerHook("agent:bootstrap", async (event) => {
        const context = (event.context ?? {}) as { bootstrapFiles?: Array<Record<string, unknown>>; sessionKey?: string };
        const bootstrapFiles = context.bootstrapFiles;
        if (!Array.isArray(bootstrapFiles)) return;

        const exists = bootstrapFiles.some((file) => file?.path === BOOTSTRAP_GUIDE_PATH);
        if (exists) return;

        bootstrapFiles.push({
          path: BOOTSTRAP_GUIDE_PATH,
          content: buildBootstrapGuide(config),
          virtual: true,
        });
      }, {
        name: `${PLUGIN_ID}.agent-bootstrap`,
        description: "Inject Unbrowse-first browsing guidance into bootstrap context",
      });
    }

    if (!config.allowBrowserFallback) {
      registerCompatibleHook(api, "before_tool_call", async (event: BeforeToolCallEvent) => {
        if (event.toolName !== "browser") return;
        return {
          block: true,
          blockReason: buildBrowserFallbackBlockReason(),
        };
      }, {
        name: `${PLUGIN_ID}.before-tool-call`,
        description: "Block legacy browser fallback while Unbrowse strict mode is active",
      });
    }

    api.registerCli(({ program }) => {
      const command = program.command("unbrowse-plugin").description("Debug the Unbrowse OpenClaw plugin");

      command.command("health").description("Run `unbrowse health` through the plugin").action(async () => {
        const result = await runCommand(binPath, ["health"], config);
        process.stdout.write(result.stdout || result.stderr || "\n");
        process.exitCode = result.ok ? 0 : result.exitCode ?? 1;
      });

      command.command("print-bootstrap").description("Print the injected bootstrap guidance").action(() => {
        process.stdout.write(`${buildBootstrapGuide(config)}\n`);
      });

      command.command("print-config").description("Print a suggested OpenClaw config snippet")
        .argument("[mode]", "strict or fallback", config.routingMode)
        .action((mode?: string) => {
          const normalizedMode = mode === "strict" ? "strict" : "fallback";
          process.stdout.write(`${buildSuggestedConfig(normalizedMode)}\n`);
        });
    }, { commands: ["unbrowse-plugin"] });

    api.registerService({
      id: PLUGIN_ID,
      start: async () => {
        if (!config.healthcheckOnStart) return;
        try {
          const result = await runCommand(binPath, ["health"], config);
          if (result.ok) {
            api.logger.info(`${PLUGIN_ID}: startup healthcheck passed`);
          } else {
            api.logger.warn(`${PLUGIN_ID}: startup healthcheck failed: ${result.stderr || result.stdout}`);
          }
        } catch (error) {
          api.logger.warn(`${PLUGIN_ID}: startup healthcheck threw: ${String(error)}`);
        }
      },
    });
  },
};

export default plugin;
