/**
 * Unbrowse as OpenAI Agents SDK tools: `new Agent({ name, instructions, tools: unbrowseTools() })`.
 *
 * Each tool is the node's MCP tool of the same name, with its description and input schema, and answers what the MCP
 * server would, as JSON text: the node's answer, or `{ error, code }` when a call fails, so the model reads what went
 * wrong. The tools aren't strict: a route's `inputs` is an open map, which strict mode can't describe.
 */
import { tool, type FunctionTool } from "@openai/agents";
import type { UnbrowseNode, UnbrowseNodeOptions } from "../client.js";
import { asText, chosen, nodeOf, runTool, type UnbrowseToolsOptions } from "./core.js";

export { DEFAULT_TOOLS, TOOLS, type ToolName, type UnbrowseToolsOptions } from "./core.js";

/**
 * The Unbrowse tools as OpenAI Agents function tools. `node` defaults to `new Unbrowse()`, which reads
 * `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN`.
 */
export function unbrowseTools(node?: UnbrowseNode | UnbrowseNodeOptions, opts: UnbrowseToolsOptions = {}): FunctionTool[] {
  const client = nodeOf(node);
  return chosen(opts).map(
    (spec) =>
      tool({
        name: spec.name,
        description: spec.description,
        parameters: { ...spec.inputSchema, additionalProperties: true as const },
        strict: false,
        execute: async (input: unknown) => asText(await runTool(client, spec, input)),
      }) as unknown as FunctionTool,
  );
}
