import { UnbrowseNode } from "unbrowse";
import { TOOLS, runTool, type ToolName, type ToolSpec } from "unbrowse/tools";

/**
 * What `plugins.entries.unbrowse.config` holds (its schema is openclaw.plugin.json's `configSchema`, read before this
 * code loads). The agent token must be present in this plugin's config; it never falls back to a process-wide key.
 */
export type UnbrowseConfig = {
  /** The node's address. Defaults to `UNBROWSE_NODE`, then http://127.0.0.1:7788. */
  node?: string;
  /** This agent's key token (`unbrowse agent token` prints it). Required; no process-wide fallback. */
  agentToken?: string;
};

export type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

/** An OpenClaw agent tool, as `api.registerTool` takes one. */
export type Tool = {
  name: string;
  label: string;
  description: string;
  parameters: object;
  /** The reply carries what a website said: OpenClaw treats it as outside content. */
  resultContentSource: "network";
  executionMode?: "sequential";
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
};

/** The part of OpenClaw's plugin API this plugin uses. */
export type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  registerTool(tool: Tool, opts: { name: string; workspaceAccess: boolean }): void;
};

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function reply(details: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

/** "whoami" → "Unbrowse whoami"; an underscore becomes a space. */
const label = (short: string) => `Unbrowse ${short.replace(/_/g, " ")}`;

/**
 * Every tool the node's MCP server lists, as OpenClaw tools, with the node's own names, descriptions and input
 * schemas (`unbrowse/tools`, written from unbrowse-node/agent-api.json). Each answers what the MCP server would: the
 * node's JSON, or `{ error, code }` when a call fails, so the model reads what went wrong.
 *
 * The client is made for each call from this agent's plugin config as it is then. A missing token fails closed instead
 * of borrowing another agent's process environment. Every call shares one browsing session, so the page an
 * `unbrowse_browse` step opens is the one the next step acts on.
 */
export function tools(config: () => UnbrowseConfig): Tool[] {
  const session = globalThis.crypto.randomUUID();
  const connect = () => {
    const c = config();
    return new UnbrowseNode({ baseUrl: text(c.node), token: text(c.agentToken) ?? "", session });
  };
  return (Object.entries(TOOLS) as [ToolName, ToolSpec][]).map(([short, spec]) => ({
    name: spec.name,
    label: label(short),
    description: spec.description,
    parameters: spec.inputSchema,
    resultContentSource: "network",
    // One tab per session in a site's browser: steps run in the order given.
    ...(short === "browse" && { executionMode: "sequential" as const }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      return reply(await runTool(connect(), spec, params));
    },
  }));
}

/** The plugin entry, in the shape OpenClaw's `definePluginEntry` returns, so the package needs nothing of OpenClaw's. */
export default {
  id: "unbrowse",
  name: "Unbrowse",
  description: "Websites as calls, through the Unbrowse node on this machine: the node's own agent tools.",
  register(api: PluginApi) {
    for (const tool of tools(() => (api.pluginConfig ?? {}) as UnbrowseConfig)) {
      api.registerTool(tool, { name: tool.name, workspaceAccess: false });
    }
  },
};
