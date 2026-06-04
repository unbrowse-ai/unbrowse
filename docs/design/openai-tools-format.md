# OpenAI-compatible tools format for the contract platform

The contract platform becomes a **meta-tool-registry**. Any OpenAI-compatible
client (OpenAI Assistants API, Anthropic Tool Use, Mistral function calling,
Gemini function calling, MCP host) consumes the platform's tool array the
same way it consumes any other.

## Three classes of tools, one shape

| Class | Origin | Example |
|---|---|---|
| **platform primitives** | Always-on built-ins | `aiko_declare`, `aiko_status`, `aiko_iterate`, `aiko_pick_channel`, `aiko_search` |
| **Declared contracts as tools** | A `declared` row that carries `tool_schema` | A user-declared contract `reddit_search` becomes callable via the registry |
| **Client-registered tools** | Client wrapping `/contract` POSTs to `/v1/contract/register-tool` (future PR) — registers a new tool by declaring a contract row | Cursor's `read_file`, OpenAI assistant's `web_browser`, etc. |

The wire format is OpenAI Chat Completions:

```json
{
  "type": "function",
  "function": {
    "name": "<slug>",
    "description": "<plan text>",
    "parameters": { /* JSON Schema */ }
  }
}
```

MCP envelope is a one-line projection (`asMCPTools(openaiTools)` → `{name, description, inputSchema}`).

## Public endpoints

### `GET /v1/contract/tools` — the tool registry

```
GET /v1/contract/tools?intent=<x>&limit=<n>&format=openai|mcp
Headers:
  X-Wallet-Pubkey: <hex>    (optional; lineage-gated discovery)

Response:
  { tools: [<OpenAIFunctionTool>] }
```

Same lineage visibility rules as `/v1/contract/status` (per #796): outsiders only
see public + marketplace + platform primitives. Owners see their lineage's tools.

`?format=mcp` returns `{ name, description, inputSchema }` instead of the
OpenAI envelope — same registry, different shape, one Worker.

### `POST /v1/contract/tool-call` — execute a tool (future PR)

```json
{ "name": "<tool_name>", "arguments": { ... } }
```

Dispatches to either:
- A platform primitive (calls handleDeclare/handleStatus/etc directly)
- A contract row's bound action (provisions the pod per the runpod design)
- A client-registered tool (forwards to the registering client's endpoint)

This endpoint requires the signed-declare envelope from #797. Tool execution is
a contract iterate; the platform writes an `iterated` row signed by the
caller's wallet.

### `POST /v1/contract/register-tool` — bring a client's tool into the platform (future PR)

Sugar over `POST /v1/contract/declare` that requires `tool_schema` to be
populated. The declared row becomes a callable tool visible to any client
that asks the platform for its tool registry.

## Reality parallel

Every cell in your body has a receptor set. A tool registry IS a receptor set.
Surface receptors are what other cells (or in this case, agents) can bind to.

- **platform primitives** = constitutive receptors expressed on every cell
- **Declared contracts as tools** = induced receptors expressed under conditions
- **Client-registered tools** = exogenous binding sites engineered onto the cell

The receptor set is queryable (`GET /v1/contract/tools`), is lineage-gated
(visibility per the contract row's `visibility` field), and the same shape
serves every binding agent regardless of which signaling system it speaks.

## How clients use this

### Vanilla OpenAI client

```python
import openai

tools = requests.get("https://beta-api.unbrowse.ai/v1/contract/tools").json()["tools"]

response = openai.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "what's the bitcoin price?"}],
    tools=tools,
)
```

### Anthropic client (same array, different envelope)

```python
import anthropic

tools = requests.get("https://beta-api.unbrowse.ai/v1/contract/tools").json()["tools"]
# Anthropic accepts the OpenAI shape since 2024 — same `tools` parameter
anthropic_tools = [
    {"name": t["function"]["name"],
     "description": t["function"]["description"],
     "input_schema": t["function"]["parameters"]}
    for t in tools
]

client.messages.create(model="claude-sonnet-4-7", tools=anthropic_tools, ...)
```

### MCP host (Claude Desktop, Cursor, etc.)

```
GET /v1/contract/tools?format=mcp
```

Returns the registry pre-shaped as MCP `tools/list` entries. The MCP server
(`unbrowse mcp`) already exposes this internally — this HTTP endpoint mirrors
it for any non-MCP host.

## What this PR ships

| Component | Status |
|---|---|
| `backend/src/services/openai-tools.ts` (schema generator + 5 platform primitives) | ✅ scaffold |
| `backend/src/routes/openai-tools.ts` (`GET /v1/contract/tools`) | ✅ scaffold |
| `backend/tests/openai-tools.test.ts` — 12 tests | ✅ pass |
| Lineage-gated discovery | ✅ |
| MCP envelope projection | ✅ |
| Execution dispatch (`POST /v1/contract/tool-call`) | ⚠️ next PR |
| Client tool registration (`POST /v1/contract/register-tool`) | ⚠️ next PR |
| Intent-ranked tool filtering (BM25 or LLM judge) | ⚠️ next PR |

The execution + registration endpoints are gated because they let arbitrary
calls run on the platform — needs Lewis approval on:

1. **Execution authorization**: who can call a tool registered by someone else?
   Default: lineage-scoped (caller must be in the tool's lineage chain).
2. **Cost accounting**: tool calls are contract iterates; iterates can fire
   posthooks; posthooks can spawn pods. The x402 settlement walks the chain.
   Recommend: every tool call's cost is bounded by an `x402_max_usdc` field
   on the tool's declared row.
3. **Sandbox for client-registered tools**: when Cursor registers `read_file`,
   the file read happens on Cursor's side, not the platform's. the platform
   FORWARDS the call back to the registering client. Need a callback URL
   (signed by the client's wallet) on the tool's declared row.

## Why this matters strategically

the platform today is "/contract neurons that fire each other." Adding the
OpenAI tool registry makes it "/contract neurons that are callable from any
OpenAI-compatible LLM client, anywhere, with one HTTP GET."

That's the difference between:
- **"Aiko is a thing you spawn from a CLI"** (today)
- **"Aiko is the tool registry every LLM in the world points at"** (after this lands)

Every contract someone declares is now a tool any LLM can call. Every tool any
LLM calls becomes an iterated contract on the platform's ledger. the platform
absorbs the function-calling ecosystem the way it absorbed scheduling (clock-as-
platform) and execution (per-contract VMs).
