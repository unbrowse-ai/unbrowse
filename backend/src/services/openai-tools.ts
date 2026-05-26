/**
 * OpenAI-compatible tools format for the contract substrate.
 *
 * Three classes of tools, one shape:
 *
 *   1. Substrate primitives — built-in ops (aiko_declare, aiko_status,
 *      aiko_iterate, aiko_pick_channel). Always available.
 *   2. Declared contracts as callable tools — any row whose declared
 *      payload carries a `tool_schema` field becomes a callable tool
 *      whose body IS that contract's action.
 *   3. Client-registered tools — when a client wrapping /contract
 *      registers its own tools (file_read, web_search, etc) via
 *      /v1/contract/register-tool, those land as declared contracts
 *      with tool_schema set, and become visible to other clients.
 *
 * The wire shape is OpenAI Chat Completions tool format:
 *   { type: "function",
 *     function: {
 *       name: <slug>,
 *       description: <plan text>,
 *       parameters: <JSON Schema> } }
 *
 * Same array works with: OpenAI Assistants API, Anthropic Tool Use,
 * Mistral function calling, Google Gemini function calling (all
 * converge on this OpenAI-shape since 2024).
 *
 * MCP equivalence is structural — MCP tools and OpenAI function
 * tools differ only in envelope. A future PR can emit the same
 * registry as MCP `tools/list` by wrapping each entry in
 * `{ name, description, inputSchema }`. That's a one-line projection.
 */

import type { ContractEventRow, ContractLedger } from "./contract-ledger.js";

export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

export interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
}

/**
 * Built-in substrate primitives. Always registered. The wire shape
 * matches the substrate's actual write/read operations one-to-one.
 *
 * These are NOT a separate code path — when a client calls
 * `aiko_declare`, the dispatcher routes it to the same handleDeclare
 * the /v1/contract/declare route uses. The OpenAI tool format is a
 * different envelope around the same neuron-shape API.
 */
export const SUBSTRATE_PRIMITIVES: OpenAIFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "aiko_declare",
      description:
        "Declare a new truth claim on the contract substrate. The substrate writes a `declared` row, recursively integrates child evidence, and fires when its evaluator threshold resolves true. Returns the contract id.",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description:
              "The truth claim, in words. The cloud aiko's compiler expands this into child contracts.",
          },
          action: {
            type: "string",
            description:
              "Pointer category: 'neuron' (default LLM composition), 'cli', 'http', 'funnel', 'sequence', 'daemon', 'http-server'. Determines whether the substrate provisions a body (pod) for the contract.",
          },
          parent_id: {
            type: "string",
            description:
              "Optional containment edge. When set, the new contract runs inside the environmental field of the parent.",
          },
          visibility: {
            type: "string",
            enum: ["lineage", "public", "marketplace"],
            description:
              "Read access policy. Default 'lineage' = only lineage-chain callers can read. 'public' = anyone. 'marketplace' = paid replication.",
          },
        },
        required: ["plan", "action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aiko_status",
      description:
        "Read the projected status of a contract. Returns {id, status, rows[]} where status ∈ {pending, active, satisfied, merged}. Lineage-gated: outsiders see synthetic empty rows.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "8-hex contract id.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aiko_iterate",
      description:
        "Record an iterate wave on a previously-declared contract. The substrate runs one wave of evaluation, integrates evidence, and returns the next-step plan (KEY 2 — agent judges).",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "8-hex contract id of the contract to iterate.",
          },
          local_result: {
            type: "object",
            description:
              "Optional locally-executed evidence the agent returns when it satisfied a step requiring local capability.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aiko_pick_channel",
      description:
        "Ask the substrate's channel picker to choose the best contact channel right now. The pick is itself a contract neuron; the cloud aiko's compiler reads channel registry rows and scores them. Returns a channel:<id> pointer.",
      parameters: {
        type: "object",
        properties: {
          urgency: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
            description: "How time-sensitive is the message?",
          },
          kind: {
            type: "string",
            enum: ["escalation", "fyi", "approval-request", "good-morning", "alert"],
            description: "Classification of the outgoing message.",
          },
        },
        required: ["urgency", "kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aiko_search",
      description:
        "Discover existing contracts on the ledger that match an intent. Returns a ranked list of {id, plan, status, score}. Use BEFORE declaring a new contract to reuse existing work (see /contract-and-find-skills doctrine).",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "Free-text intent to match against existing contracts.",
          },
          limit: {
            type: "integer",
            description: "Max results (default 5).",
          },
        },
        required: ["intent"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Convert a declared contract row to an OpenAI function tool. Returns
 * null when the row's tool_schema is absent — not every contract is
 * callable as a tool. A contract becomes a tool by declaring with
 * `tool_schema` populated; everything else stays a private neuron.
 *
 * Naming: tool name = `contract_<id>` for id-based access, OR the
 * row's `tool_name` field when the declarer chose a human-readable
 * alias. Aliases must match /^[a-z][a-z0-9_]{1,63}$/ (OpenAI's name
 * pattern); IDs always match since they're 8-hex.
 *
 * Description: prefer the row's `tool_description` if set; fall
 * back to its `plan` text (truncated to 1024 chars to fit context
 * budgets).
 */
export function contractRowToOpenAITool(row: ContractEventRow): OpenAIFunctionTool | null {
  if (row.event !== "declared") return null;
  // Cast: tool_schema / tool_name / tool_description are ad-hoc fields
  // added by declarers that want to surface their contract as a tool.
  // The ledger row type is open-shape, so a TS cast here is honest.
  const r = row as ContractEventRow & {
    tool_schema?: JSONSchema;
    tool_name?: string;
    tool_description?: string;
  };
  if (!r.tool_schema) return null;
  const alias = r.tool_name;
  const validAlias =
    typeof alias === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(alias) ? alias : null;
  const name = validAlias ?? `contract_${row.id}`;
  const description = (r.tool_description ?? row.plan ?? "(no description)").slice(0, 1024);
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: r.tool_schema,
    },
  };
}

/**
 * Build the full OpenAI tool array. Combines substrate primitives +
 * declared-contract tools filtered by lineage visibility (per #796).
 *
 * Filtering by caller pubkey is mandatory: a contract declared with
 * visibility="lineage" is only visible to its lineage chain. The
 * tools list mirrors that — outsiders only see public/marketplace
 * tools + primitives. Same security model as /v1/contract/status.
 *
 * If `intent` is set, the cloud aiko's compiler scores tools against
 * the intent and returns only the top-K (BM25-like or LLM-judged;
 * deferred to a future iterate per the BM25-not-embeddings discipline).
 */
export async function buildOpenAIToolList(
  ledger: ContractLedger,
  opts: { caller_pubkey?: string | null; intent?: string; limit?: number } = {},
): Promise<OpenAIFunctionTool[]> {
  const tools: OpenAIFunctionTool[] = [...SUBSTRATE_PRIMITIVES];
  const allRows = await ledger.listAll();
  for (const row of allRows) {
    const tool = contractRowToOpenAITool(row);
    if (!tool) continue;
    // Lineage filter — same shape as isCallerInLineage in #796
    const visibility =
      (row as { visibility?: string }).visibility ?? "lineage";
    if (visibility === "public" || visibility === "marketplace") {
      tools.push(tool);
      continue;
    }
    // Lineage: row's wallet_identity must match caller_pubkey OR an
    // ancestor's. We use a simple direct-match check here; full
    // ancestor-walk happens in handleStatus already.
    const rowOwner = (row as { wallet_identity?: string }).wallet_identity;
    if (!rowOwner) {
      tools.push(tool);
      continue;
    }
    if (opts.caller_pubkey && rowOwner === opts.caller_pubkey) {
      tools.push(tool);
    }
  }
  return opts.limit ? tools.slice(0, opts.limit) : tools;
}

/**
 * Same registry, MCP envelope. One-line projection — proves the
 * registry is format-agnostic.
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export function asMCPTools(tools: OpenAIFunctionTool[]): MCPTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));
}
