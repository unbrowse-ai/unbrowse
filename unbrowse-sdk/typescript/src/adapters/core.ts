// What every framework adapter shares: which tools to give, and running one against the node. Each adapter
// (ai-sdk.ts, langchain.ts, mastra.ts, openai-agents.ts) only wraps these in its framework's tool type.
import { UnbrowseNode, type UnbrowseNodeOptions } from "../client.js";
import { UnbrowseError } from "../http.js";
import { primitiveRequest, type AgentPrimitives, type PrimitiveArgs } from "../generated.js";
import { TOOLS, type ToolName, type ToolSpec } from "./tools.js";

export { TOOLS, type ToolName, type ToolSpec, type InputSchema } from "./tools.js";

/**
 * The tools an adapter gives when `include` is left out. `browse` (driving the node's browser by hand) and `report`
 * come only when `include` names them.
 */
export const DEFAULT_TOOLS: readonly ToolName[] = ["do", "search", "call", "logins", "whoami"];

export type UnbrowseToolsOptions = {
  /**
   * Which tools to give, by name with or without `unbrowse_`: `["do", "search"]`. Defaults to `DEFAULT_TOOLS`. Add
   * `"browse"` for pages that need clicks or typing: `[...DEFAULT_TOOLS, "browse"]`.
   */
  include?: readonly (ToolName | `unbrowse_${ToolName}`)[];
};

/** A failed tool call, as the MCP server answers one (`{ error }`), with the client's `code` for it. */
export type ToolError = { error: string; code: string; hint?: string };

/** The client the tools use: the one given, one made from the options given, or `new Unbrowse()` (env). */
export function nodeOf(node?: UnbrowseNode | UnbrowseNodeOptions): UnbrowseNode {
  return node instanceof UnbrowseNode ? node : new UnbrowseNode(node ?? {});
}

/** The tools `include` asks for, in the order it names them; an unknown name throws, naming the ones there are. */
export function chosen(opts: UnbrowseToolsOptions = {}): ToolSpec[] {
  const names = opts.include ?? DEFAULT_TOOLS;
  return names.map((n) => {
    const short = (n.startsWith("unbrowse_") ? n.slice("unbrowse_".length) : n) as ToolName;
    const spec = TOOLS[short];
    if (!spec) throw new Error(`no Unbrowse tool ${n}: there are ${Object.keys(TOOLS).join(", ")}`);
    return spec;
  });
}

// A node without a browser can still call the routes it has and other contributors' routes; only walking a page it
// hasn't learned needs one. A node that has the browser add-on names the case itself (`code: "browser_missing"` in its
// answer, which an SDK that knows the code raises as BrowserMissingError and an older one as a 422) and says how to get
// the browser (`install`); an older node says it only in its words, which the pattern catches.
const NO_BROWSER = /has no browser|downloading its browser/i;
const STILL = "unbrowse_do still calls the routes the node has, and routes other contributors list for the site";

function browserHint(e: UnbrowseError): string {
  const said = (e.body ?? {}) as { browser?: unknown; install?: unknown };
  if (said.browser === "installing") return `The node is fetching its browser now: try again in a minute. Meanwhile ${STILL}.`;
  if (typeof said.install === "string") return `This node has no browser, so it can't walk a page it hasn't learned. ${STILL}; the owner gets the browser with \`${said.install}\` on the node's machine.`;
  return `This node has no browser, so it can't walk a page it hasn't learned. ${STILL}; ask the owner to install Chrome, or to download Chrome for Testing in the Unbrowse app's Settings, for the rest.`;
}

/** A thrown error as the tool's answer, so the model reads what went wrong instead of the run crashing. */
export function toolError(e: unknown): ToolError {
  if (e instanceof UnbrowseError) {
    const named = (e.body as { code?: unknown } | undefined)?.code === "browser_missing";
    const missing = named || e.name === "BrowserMissingError" || e.code === "browser_missing" || NO_BROWSER.test(e.message);
    return { error: e.message, code: missing ? "browser_missing" : e.code, ...(missing && { hint: browserHint(e) }) };
  }
  return { error: e instanceof Error ? e.message : String(e), code: "error" };
}

/** A string-valued map (a route's inputs): the node takes strings, and a model may send a number or a boolean. */
const isStringMap = (s: Record<string, unknown> | undefined) =>
  s?.type === "object" && (s.additionalProperties as { type?: string } | undefined)?.type === "string";

/**
 * Runs one tool against the node and answers what the MCP server would: the node's own JSON, in its snake case, or
 * `{ error, code }` when the call fails. It never throws for a failed call.
 */
export async function runTool(node: UnbrowseNode, spec: ToolSpec, input: unknown): Promise<unknown> {
  try {
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) {
      // A model in non-strict mode may send null for an argument it leaves out.
      if (v === null || v === undefined) continue;
      args[k] = isStringMap(spec.inputSchema.properties[k]) && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).map(([n, x]) => [n, String(x)])) : v;
    }
    // As the MCP server answers a call missing an argument it needs.
    const absent = (k: string) => args[k] === undefined || args[k] === "";
    const missing = spec.inputSchema.required.find(absent);
    if (missing) return { error: `${spec.name} needs ${missing}`, code: "bad_request" } satisfies ToolError;
    // And one of the argument sets the call takes one of in full (a goal, or an ask to collect): with none, the first
    // set's first missing name, as the MCP server says it.
    const groups = spec.needsOneOf ?? [];
    if (groups.length && !groups.some((g) => g.every((k) => !absent(k)))) {
      return { error: `${spec.name} needs ${groups[0].find(absent)}`, code: "bad_request" } satisfies ToolError;
    }
    // Every page this client opens is in its own session, as the MCP server keeps each client's: a session the model
    // names is one of this client's.
    if ("session" in spec.inputSchema.properties) args.session = args.session ? `${node.session}:${args.session}` : node.session;
    const tool = spec.name as keyof AgentPrimitives;
    const req = primitiveRequest(tool, args as PrimitiveArgs<typeof tool>);
    return await node.request(req.method, req.path, req.body);
  } catch (e) {
    return toolError(e);
  }
}

/** The answer as text, for frameworks whose tools answer a string. */
export function asText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? null);
}
