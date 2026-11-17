/**
 * Unbrowse as Mastra tools: `new Agent({ name, instructions, model, tools: unbrowseTools() })`.
 *
 * Each tool is the node's MCP tool of the same name, with its description and input schema, and answers what the MCP
 * server would: the node's JSON, or `{ error, code }` when a call fails, so the model reads what went wrong.
 */
import { createTool } from "@mastra/core/tools";
import type { UnbrowseNode, UnbrowseNodeOptions } from "../client.js";
import { chosen, nodeOf, runTool, type UnbrowseToolsOptions } from "./core.js";

export { DEFAULT_TOOLS, TOOLS, type ToolName, type UnbrowseToolsOptions } from "./core.js";

/** A Mastra tool as `createTool` makes one. */
export type MastraTool = ReturnType<typeof createTool>;

/**
 * The Unbrowse tools as Mastra tools, keyed by tool name (`unbrowse_do`, ...), as an agent's `tools` takes them.
 * `node` defaults to `new Unbrowse()`, which reads `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN`.
 */
export function unbrowseTools(node?: UnbrowseNode | UnbrowseNodeOptions, opts: UnbrowseToolsOptions = {}): Record<string, MastraTool> {
  const client = nodeOf(node);
  return Object.fromEntries(
    chosen(opts).map((spec) => [
      spec.name,
      createTool({
        id: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema as Parameters<typeof createTool>[0]["inputSchema"],
        execute: async (input: unknown) => (await runTool(client, spec, input)) as Record<string, unknown>,
      }) as MastraTool,
    ]),
  );
}
