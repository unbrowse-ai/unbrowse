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

const TOOL_DOCS = {
  resolve: [
    "Start here for most website tasks.",
    "Give Unbrowse a concrete page URL plus a natural-language intent.",
    "It will reuse an existing API skill when possible or capture the site and learn one.",
    "Returns candidate endpoints with a skillId and endpointId you can pass to unbrowse_execute.",
    "If you do not already have a skillId, do not call unbrowse_execute first.",
  ].join(" "),
  search: [
    "Search the marketplace for already-learned skills by intent.",
    "Use this when you want to find an existing skill before capturing a new page.",
    "If you know the site, pass domain to narrow the results.",
    "Use returned skillIds with unbrowse_skill or unbrowse_execute.",
  ].join(" "),
  execute: [
    "Run a known endpoint from a known skill.",
    "Use this only after unbrowse_resolve, unbrowse_search, unbrowse_skills, or unbrowse_skill gave you a skillId and endpointId.",
    "If the endpoint came from a browser capture, also pass the original url and intent so replay keeps the same page context.",
    "Do not guess skillId or endpointId values.",
  ].join(" "),
  login: [
    "Open an interactive login flow for a gated site.",
    "Use this before resolve or execute when the target site needs auth cookies.",
  ].join(" "),
  skills: [
    "List locally cached skills already known to this machine.",
    "This is local state, not a remote marketplace search.",
  ].join(" "),
  skill: [
    "Inspect one specific known skill by ID.",
    "The skillId must come from unbrowse_resolve, unbrowse_search, or unbrowse_skills.",
    "This does not discover new skills.",
  ].join(" "),
  health: [
    "Check that the Unbrowse CLI and browser engine are installed and callable.",
    "Use this first when MCP setup looks broken.",
  ].join(" "),
} as const;

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
    description: TOOL_DOCS.resolve,
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "Natural-language goal. Example: `get linkedin feed posts` or `find product prices`." },
        url: { type: "string", description: "Concrete page URL to learn from. Prefer the exact page the user cares about, not a homepage." },
        path: { type: "string", description: "Optional JSON path to focus the result. Example: `data.items[]`." },
        extract: { type: "string", description: "Optional field projection. Example: `title,price,url` or `author:user.name`." },
        limit: { type: "number", description: "Optional max rows/items to return after projection (1-200)." },
        pretty: { type: "boolean", description: "Pretty-print the JSON output for inspection." },
        dryRun: { type: "boolean", description: "Preview the replay plan without side effects." },
        confirmUnsafe: { type: "boolean", description: "Required only for non-GET requests or other unsafe replays." },
      },
      required: ["intent", "url"],
    },
  },
  unbrowse_search: {
    description: TOOL_DOCS.search,
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "Plain-English marketplace query. Example: `linkedin feed posts` or `shopify product prices`." },
        domain: { type: "string", description: "Optional site filter such as `linkedin.com` or `news.ycombinator.com`." },
      },
      required: ["intent"],
    },
  },
  unbrowse_execute: {
    description: TOOL_DOCS.execute,
    inputSchema: {
      type: "object" as const,
      properties: {
        skillId: { type: "string", description: "Known skill ID returned by unbrowse_resolve, unbrowse_search, unbrowse_skills, or unbrowse_skill." },
        endpointId: { type: "string", description: "Known endpoint ID from that skill." },
        url: { type: "string", description: "Recommended for browser-capture skills. Pass the original page URL so replay keeps the same page/query context." },
        intent: { type: "string", description: "Recommended for browser-capture skills. Pass the original user intent for endpoint-selection context." },
        path: { type: "string", description: "Optional JSON path to focus the result. Example: `data.items[]`." },
        extract: { type: "string", description: "Optional field projection. Example: `title,price,url` or `author:user.name`." },
        limit: { type: "number", description: "Optional max rows/items to return after projection (1-200)." },
        pretty: { type: "boolean", description: "Pretty-print the JSON output for inspection." },
        dryRun: { type: "boolean", description: "Preview the replay without side effects." },
        confirmUnsafe: { type: "boolean", description: "Required only for non-GET requests or other unsafe replays." },
      },
      required: ["skillId", "endpointId"],
    },
  },
  unbrowse_login: {
    description: TOOL_DOCS.login,
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Site or login page URL to authenticate against. Example: `https://www.linkedin.com/feed/`." },
      },
      required: ["url"],
    },
  },
  unbrowse_skills: {
    description: TOOL_DOCS.skills,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  unbrowse_skill: {
    description: TOOL_DOCS.skill,
    inputSchema: {
      type: "object" as const,
      properties: {
        skillId: { type: "string", description: "Known skill ID from unbrowse_resolve, unbrowse_search, or unbrowse_skills." },
      },
      required: ["skillId"],
    },
  },
  unbrowse_health: {
    description: TOOL_DOCS.health,
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
      return { action: "execute", skillId: args.skillId as string, endpointId: args.endpointId as string, intent: args.intent as string | undefined, url: args.url as string | undefined, path: args.path as string | undefined, extract: args.extract as string | undefined, limit: args.limit as number | undefined, pretty: args.pretty as boolean | undefined, dryRun: args.dryRun as boolean | undefined, confirmUnsafe: args.confirmUnsafe as boolean | undefined };
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
