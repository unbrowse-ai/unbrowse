import { spawn } from "node:child_process";

export type ToolParams = {
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

function pushFlag(args: string[], name: string, value: string | number | boolean | undefined): void {
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
      if (!params.intent) throw new Error("intent required for action=search");
      const args = ["search", "--intent", params.intent];
      pushFlag(args, "domain", params.domain);
      return args;
    }
    case "execute": {
      if (!params.skillId) throw new Error("skillId required for action=execute");
      if (!params.endpointId) throw new Error("endpointId required for action=execute");
      const args = ["execute", "--skill", params.skillId, "--endpoint", params.endpointId];
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

export function runUnbrowse(
  binPath: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut && !signal) {
        resolve({ ok: false, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(), exitCode: 124 });
        return;
      }
      resolve({ ok: exitCode === 0, stdout, stderr, exitCode });
    });
  });
}

export const TOOL_DEFINITIONS = {
  unbrowse_resolve: {
    description: "Reverse-engineer a website URL into API endpoints. Captures network traffic, discovers APIs, and returns a shortlist of reusable endpoints.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "Plain-English description of what data to extract" },
        url: { type: "string", description: "Target website URL to reverse-engineer" },
        path: { type: "string", description: "Optional response path extraction hint" },
        extract: { type: "string", description: "Comma-separated fields or alias:path spec" },
        limit: { type: "number", description: "Max results to return (1-200)" },
        pretty: { type: "boolean", description: "Pretty-print output" },
        dryRun: { type: "boolean", description: "Preview without side effects" },
        confirmUnsafe: { type: "boolean", description: "Allow non-GET execution" },
      },
      required: ["intent", "url"],
    },
  },
  unbrowse_search: {
    description: "Search the unbrowse marketplace for existing skills by intent or domain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "Plain-English search query" },
        domain: { type: "string", description: "Optional domain filter" },
      },
      required: ["intent"],
    },
  },
  unbrowse_execute: {
    description: "Execute a previously discovered or marketplace skill endpoint with parameters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skillId: { type: "string", description: "Skill ID to execute" },
        endpointId: { type: "string", description: "Endpoint ID within the skill" },
        path: { type: "string", description: "Optional response path extraction hint" },
        extract: { type: "string", description: "Comma-separated fields or alias:path spec" },
        limit: { type: "number", description: "Max results to return (1-200)" },
        pretty: { type: "boolean", description: "Pretty-print output" },
        dryRun: { type: "boolean", description: "Preview without side effects" },
        confirmUnsafe: { type: "boolean", description: "Allow non-GET execution" },
      },
      required: ["skillId", "endpointId"],
    },
  },
  unbrowse_login: {
    description: "Open a browser for the user to log into a website, capturing auth cookies for future requests.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Login page URL" },
      },
      required: ["url"],
    },
  },
  unbrowse_skills: {
    description: "List all locally cached skills.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  unbrowse_skill: {
    description: "Get details of a specific skill by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skillId: { type: "string", description: "Skill ID to inspect" },
      },
      required: ["skillId"],
    },
  },
  unbrowse_health: {
    description: "Check if the unbrowse CLI is installed and working.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
} as const;

export function toolParamsFromCall(toolName: string, args: Record<string, unknown>): ToolParams {
  switch (toolName) {
    case "unbrowse_resolve":
      return { action: "resolve", intent: args.intent as string, url: args.url as string, path: args.path as string | undefined, extract: args.extract as string | undefined, limit: args.limit as number | undefined, pretty: args.pretty as boolean | undefined, dryRun: args.dryRun as boolean | undefined, confirmUnsafe: args.confirmUnsafe as boolean | undefined };
    case "unbrowse_search":
      return { action: "search", intent: args.intent as string, domain: args.domain as string | undefined };
    case "unbrowse_execute":
      return { action: "execute", skillId: args.skillId as string, endpointId: args.endpointId as string, path: args.path as string | undefined, extract: args.extract as string | undefined, limit: args.limit as number | undefined, pretty: args.pretty as boolean | undefined, dryRun: args.dryRun as boolean | undefined, confirmUnsafe: args.confirmUnsafe as boolean | undefined };
    case "unbrowse_login":
      return { action: "login", url: args.url as string };
    case "unbrowse_skills":
      return { action: "skills" };
    case "unbrowse_skill":
      return { action: "skill", skillId: args.skillId as string };
    case "unbrowse_health":
      return { action: "health" };
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
