#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_DEFINITIONS, toolParamsFromCall, buildArgs, runUnbrowse } from "./tools.js";

const UNBROWSE_BIN = process.env.UNBROWSE_BIN || "unbrowse";
const TIMEOUT_MS = Number(process.env.UNBROWSE_TIMEOUT_MS) || 120_000;

const server = new McpServer({
  name: "unbrowse",
  version: "0.1.0",
});

for (const [name, def] of Object.entries(TOOL_DEFINITIONS)) {
  const toolName = name;
  const schema = def.inputSchema;

  // Build zod-like shape from inputSchema for the MCP SDK
  // The SDK accepts raw JSON Schema when passed via the lower-level API
  server.tool(
    toolName,
    def.description,
    schema as unknown as Record<string, unknown>,
    async (args: Record<string, unknown>) => {
      try {
        const params = toolParamsFromCall(toolName, args);
        const cliArgs = buildArgs(params);
        const result = await runUnbrowse(UNBROWSE_BIN, cliArgs, TIMEOUT_MS);

        if (!result.ok) {
          const errorText = result.stderr?.trim() || result.stdout?.trim() || `Exit code ${result.exitCode}`;
          return {
            content: [{ type: "text" as const, text: `Error: ${errorText}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: result.stdout.trim() || "OK" }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
