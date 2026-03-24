#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TOOL_DEFINITIONS, toolParamsFromCall, buildArgs, runUnbrowse } from "./tools.js";

const UNBROWSE_BIN = process.env.UNBROWSE_BIN || "unbrowse";
const TIMEOUT_MS = Number(process.env.UNBROWSE_TIMEOUT_MS) || 120_000;

const server = new McpServer({
  name: "unbrowse",
  version: "2.1.4",
});

function improveErrorText(errorText: string, toolName: string): string {
  const trimmed = errorText.trim();

  if (/skill not found/i.test(trimmed)) {
    return `${trimmed}. Use unbrowse_search, unbrowse_resolve, or unbrowse_skills first, then copy the returned skillId exactly.`;
  }

  if (/endpoint not found/i.test(trimmed)) {
    return `${trimmed}. Call unbrowse_skill with the same skillId to inspect valid endpointIds, then retry unbrowse_execute.`;
  }

  if (toolName === "unbrowse_execute" && /skillId required|endpointId required/i.test(trimmed)) {
    return `${trimmed}. Do not guess IDs. Get them from unbrowse_resolve, unbrowse_search, unbrowse_skills, or unbrowse_skill first.`;
  }

  return trimmed;
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

// Convert JSON Schema property definitions to Zod shapes
function toZodShape(inputSchema: { properties: Record<string, { type: string; description?: string; enum?: string[] }>; required?: readonly string[] }): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(inputSchema.required ?? []);

  for (const [key, prop] of Object.entries(inputSchema.properties)) {
    let schema: z.ZodTypeAny;
    if (prop.enum) {
      schema = z.enum(prop.enum as [string, ...string[]]);
    } else if (prop.type === "number") {
      schema = z.number();
    } else if (prop.type === "boolean") {
      schema = z.boolean();
    } else {
      schema = z.string();
    }
    if (prop.description) schema = schema.describe(prop.description);
    if (!required.has(key)) schema = schema.optional();
    shape[key] = schema;
  }
  return shape;
}

for (const [name, def] of Object.entries(TOOL_DEFINITIONS)) {
  const toolName = name;
  const zodShape = toZodShape(def.inputSchema as any);

  server.tool(
    toolName,
    def.description,
    zodShape,
    async (args: Record<string, unknown>) => {
      try {
        const params = toolParamsFromCall(toolName, args);
        const cliArgs = buildArgs(params);
        const result = await runUnbrowse(UNBROWSE_BIN, cliArgs, TIMEOUT_MS);
        const trimmed = result.stdout.trim();
        let parsed: unknown = null;
        try {
          parsed = trimmed ? JSON.parse(trimmed) : null;
        } catch {
          parsed = null;
        }

        if (!result.ok || hasErrorPayload(parsed)) {
          let payloadError: string | null = null;
          if (parsed && typeof parsed === "object") {
            const payload = parsed as Record<string, unknown>;
            if (typeof payload.error === "string") {
              payloadError = payload.error;
            } else {
              const resultPayload = payload.result;
              if (
                resultPayload &&
                typeof resultPayload === "object" &&
                typeof (resultPayload as Record<string, unknown>).error === "string"
              ) {
                payloadError = (resultPayload as Record<string, unknown>).error as string;
              }
            }
          }
          const rawErrorText = payloadError || result.stderr?.trim() || result.stdout?.trim() || `Exit code ${result.exitCode}`;
          const errorText = improveErrorText(rawErrorText, toolName);
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
