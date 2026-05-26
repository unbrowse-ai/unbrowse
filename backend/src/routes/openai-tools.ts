/**
 * GET /v1/contract/tools — return the OpenAI-format tool array for the
 * caller. Lineage-gated; outsiders see only public + substrate primitives.
 *
 * The wire format is the standard OpenAI Chat Completions tools array.
 * Same array works with Anthropic Tool Use, Mistral function calling,
 * Gemini function calling (all converge on this shape). MCP `tools/list`
 * is a one-line projection (see asMCPTools).
 *
 * The contract substrate becomes the meta-tool-registry: every callable
 * contract surfaces here; every client wrapping /contract gets the same
 * tools list; client-registered tools (POST /v1/contract/register-tool —
 * future PR) land as declared contracts and become visible to other
 * clients via the same endpoint.
 *
 * Query params:
 *   intent  (optional) — filter/rank tools by relevance to the intent
 *   limit   (optional) — cap the returned array (default unlimited)
 *
 * Header:
 *   X-Wallet-Pubkey  (optional) — caller identity for lineage filter.
 *                                  Without it, only public/marketplace
 *                                  tools + primitives are returned.
 */
import { Hono } from "hono";
import { buildOpenAIToolList, asMCPTools } from "../services/openai-tools.js";
import type { ContractLedger, ContractEventRow } from "../services/contract-ledger.js";

// Local ephemeral ledger for scaffold; production wires the durable one
// via the env binding. Same pattern as the existing /v1/contract routes.
function ephemeralLedger(): ContractLedger {
  const rows: ContractEventRow[] = [];
  return {
    async append(row) {
      const stamped = { ...row, ts: row.ts || new Date().toISOString() };
      rows.push(stamped);
      return stamped;
    },
    async get(id) {
      const hit = rows.filter((r) => r.id === id);
      return hit.length ? hit : null;
    },
    async listAll() {
      return rows.slice();
    },
    async listChildren(parentId) {
      return rows.filter((r) => r.parent_id === parentId);
    },
  };
}

export const openaiToolsRoutes = new Hono();

openaiToolsRoutes.get("/contract/tools", async (c) => {
  const intent = c.req.query("intent") || undefined;
  const limitStr = c.req.query("limit");
  const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
  const callerPubkey = c.req.header("X-Wallet-Pubkey") || null;
  // Optional ?format=mcp to get MCP envelope instead
  const format = c.req.query("format");
  try {
    const tools = await buildOpenAIToolList(ephemeralLedger(), {
      intent,
      caller_pubkey: callerPubkey,
      limit,
    });
    if (format === "mcp") {
      return c.json({ tools: asMCPTools(tools) });
    }
    return c.json({ tools });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
