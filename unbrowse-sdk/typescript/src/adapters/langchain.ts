/**
 * Unbrowse as LangChain tools: `createAgent({ model, tools: unbrowseTools() })`, or `model.bindTools(unbrowseTools())`.
 *
 * Each tool is the node's MCP tool of the same name, with its description and input schema, and answers what the MCP
 * server would, as JSON text: the node's answer, or `{ error, code }` when a call fails, so the model reads what went
 * wrong.
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { UnbrowseNode, UnbrowseNodeOptions } from "../client.js";
import { asText, chosen, nodeOf, runTool, type UnbrowseToolsOptions } from "./core.js";

export { DEFAULT_TOOLS, TOOLS, type ToolName, type UnbrowseToolsOptions } from "./core.js";

/**
 * The Unbrowse tools as LangChain `DynamicStructuredTool`s. `node` defaults to `new Unbrowse()`, which reads
 * `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN`.
 */
export function unbrowseTools(node?: UnbrowseNode | UnbrowseNodeOptions, opts: UnbrowseToolsOptions = {}): DynamicStructuredTool[] {
  const client = nodeOf(node);
  return chosen(opts).map(
    (spec) =>
      new DynamicStructuredTool({
        name: spec.name,
        description: spec.description,
        schema: spec.inputSchema,
        func: async (input: unknown) => asText(await runTool(client, spec, input)),
      }),
  );
}
