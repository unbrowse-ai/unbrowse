/**
 * MCP transport — auto-registers every CONTRACT_REGISTRY neuron as an
 * MCP tool. Thin shim over the dispatcher.
 *
 * Contracts:
 *   - 2d2f444a (single source of truth)
 *   - f5836e77 (MCP+CLI unification)
 *
 * Usage from an MCP server bootstrap:
 *   import { Server } from "@modelcontextprotocol/sdk/server/index.js";
 *   import { registerContractNeurons } from "./contract-shape/mcp-transport.js";
 *   const server = new Server({ name: "unbrowse", version: "..." }, { capabilities: { tools: {} } });
 *   registerContractNeurons(server);
 *
 * The MCP-listed tool name for each neuron is `${neuron.name}` (callers
 * see `mcp__unbrowse__${name}` per MCP convention). The handler routes
 * to the dispatcher which routes to src/contract-shape/impl/<name>.ts.
 *
 * NO duplication of registration boilerplate per neuron — this file
 * iterates CONTRACT_REGISTRY once.
 */

import { CONTRACT_REGISTRY } from "./registry.js";
import { dispatch } from "./dispatcher.js";

/**
 * Minimal MCP server surface we need from the SDK. Typed loosely so this
 * file does not couple to a specific SDK version. The real bootstrap
 * imports @modelcontextprotocol/sdk and passes its Server instance.
 */
export interface McpServerLike {
  setRequestHandler(schema: unknown, handler: (req: unknown) => Promise<unknown>): void;
}

interface ListToolsRequest {
  method: "tools/list";
  params?: { cursor?: string };
}

interface CallToolRequest {
  method: "tools/call";
  params: { name: string; arguments?: unknown };
}

/**
 * Register every CONTRACT_REGISTRY neuron as an MCP tool on the given
 * server. Idempotent — calling twice is harmless because the handlers
 * just overwrite.
 *
 * The handler returns the dispatcher's DispatchResult wrapped in MCP's
 * content envelope: { content: [{ type: "text", text: JSON.stringify(...) }] }
 */
export function registerContractNeurons(server: McpServerLike, schemaRefs: {
  listToolsRequestSchema: unknown;
  callToolRequestSchema: unknown;
}): void {
  server.setRequestHandler(schemaRefs.listToolsRequestSchema, async () => {
    return {
      tools: CONTRACT_REGISTRY.map((spec) => ({
        name: spec.name,
        description: `${spec.description} [contract:${spec.contract_id}, locality:${spec.locality}${spec.paid ? ", paid" : ""}]`,
        // inputSchema/outputSchema are described in spec.input_shape /
        // spec.output_shape as TS-shape strings. The MCP wire format wants
        // a JSON Schema. For now we surface a permissive shape and let
        // the impl module validate; future work normalises to JSON Schema.
        inputSchema: {
          type: "object",
          description: spec.input_shape,
          additionalProperties: true,
        },
      })),
    };
  });

  server.setRequestHandler(schemaRefs.callToolRequestSchema, async (rawReq: unknown) => {
    const req = rawReq as CallToolRequest;
    const name = req.params?.name ?? "";
    const args = req.params?.arguments ?? {};
    const r = await dispatch(name, args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(r),
        },
      ],
      isError: !r.ok,
    };
  });
}
