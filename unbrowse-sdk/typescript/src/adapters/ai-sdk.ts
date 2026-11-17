/**
 * Unbrowse as Vercel AI SDK tools: `generateText({ model, tools: unbrowseTools(), prompt })`.
 *
 * Each tool is the node's MCP tool of the same name, with its description and input schema, and answers what the MCP
 * server would: the node's JSON, or `{ error, code }` when a call fails, so the model reads what went wrong.
 */
import { jsonSchema, tool, type Tool } from "ai";
import type { UnbrowseNode, UnbrowseNodeOptions } from "../client.js";
import { chosen, nodeOf, runTool, type UnbrowseToolsOptions } from "./core.js";

export { DEFAULT_TOOLS, TOOLS, type ToolName, type UnbrowseToolsOptions } from "./core.js";

/**
 * The Unbrowse tools as an AI SDK tool set, keyed by tool name (`unbrowse_do`, ...). `node` defaults to
 * `new Unbrowse()`, which reads `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN`.
 */
export function unbrowseTools(node?: UnbrowseNode | UnbrowseNodeOptions, opts: UnbrowseToolsOptions = {}): Record<string, Tool> {
  const client = nodeOf(node);
  return Object.fromEntries(
    chosen(opts).map((spec) => [
      spec.name,
      tool({
        description: spec.description,
        inputSchema: jsonSchema<Record<string, unknown>>(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: (input: Record<string, unknown>) => runTool(client, spec, input),
      }),
    ]),
  );
}
