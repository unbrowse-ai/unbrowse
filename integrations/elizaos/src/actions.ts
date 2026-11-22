import type { Action, ActionExample, ActionResult, Content, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { TOOLS, runTool, type ToolName, type ToolSpec } from "unbrowse/tools";
import { extract, missing, paramsOf, type Param, type Values } from "./params.js";
import { unbrowse } from "./service.js";
import { actionName, asActions } from "./words.js";

/** How much of the node's answer goes into the reply text; all of it stays in the result's data. */
const SHOWN = 4000;

function shown(data: unknown): string {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return text.length > SHOWN ? `${text.slice(0, SHOWN)}\n… (${text.length - SHOWN} more characters in the result's data)` : text;
}

/** A refusal, as `runTool` answers one: `{ error, code }`, never a call's result (which has `ok`). */
function refusal(r: unknown): string | undefined {
  if (!r || typeof r !== "object" || "ok" in r) return undefined;
  const o = r as { error?: unknown; code?: unknown };
  return typeof o.error === "string" && typeof o.code === "string" ? o.error : undefined;
}

/** Whether the node's answer is a success: not a refusal, and not a call the site didn't pass (`ok: false`). */
function passed(r: unknown): boolean {
  if (refusal(r) !== undefined) return false;
  const o = (r ?? {}) as { ok?: unknown; result?: { ok?: unknown } };
  return o.ok !== false && o.result?.ok !== false;
}

/** Other names the planner may reach for, and examples, for the tools an agent uses most. */
const SIMILES: Partial<Record<ToolName, string[]>> = {
  do: ["USE_WEBSITE", "WEBSITE_DO", "FETCH_FROM_WEBSITE", "UNBROWSE"],
  browse: ["UNBROWSE_BROWSER", "DRIVE_PAGE", "CLICK_ON_PAGE", "FILL_ON_PAGE"],
  search: ["FIND_ROUTES", "LIST_ROUTES", "UNBROWSE_ROUTES"],
  call: ["CALL_ROUTE", "RUN_ROUTE"],
  logins: ["LIST_LOGINS", "VAULT_LOGINS"],
  report: ["REPORT_UNBROWSE_BUG"],
};

const EXAMPLES: Partial<Record<ToolName, ActionExample[][]>> = {
  do: [
    [
      { name: "{{name1}}", content: { text: "Find stories about rust on https://news.example/?q=rust" } },
      { name: "{{name2}}", content: { text: "I'll get them through Unbrowse.", actions: ["UNBROWSE_DO"] } },
    ],
    [
      { name: "{{name1}}", content: { text: "Now the same search for tauri." } },
      { name: "{{name2}}", content: { text: "Same goal, new query.", actions: ["UNBROWSE_DO"] } },
    ],
  ],
  browse: [
    [
      { name: "{{name1}}", content: { text: "Type hello into the message box (@e3) and send it." } },
      { name: "{{name2}}", content: { text: "Filling it in the node's browser.", actions: ["UNBROWSE_BROWSE"] } },
    ],
  ],
  search: [
    [
      { name: "{{name1}}", content: { text: "What can you already do on example.com?" } },
      { name: "{{name2}}", content: { text: "Let me look up the routes for it.", actions: ["UNBROWSE_SEARCH"] } },
    ],
  ],
  call: [
    [
      { name: "{{name1}}", content: { text: "Run route story-search with q=tauri." } },
      { name: "{{name2}}", content: { text: "Calling it.", actions: ["UNBROWSE_CALL"] } },
    ],
  ],
};

/**
 * One of the node's tools as an action: read its parameters, run it against the node, say what came back. The name,
 * description and parameters are the node's MCP tool's (`unbrowse/tools`), with action names for tool names. A
 * failure to reach the node or a refusal from it is answered as text, never thrown.
 */
function action(short: ToolName, spec: ToolSpec): Action {
  const name = actionName(spec.name);
  const description = asActions(spec.description);
  const params: Param[] = paramsOf(spec.inputSchema, spec.needsOneOf ?? []);
  return {
    name,
    similes: SIMILES[short] ?? [],
    description,
    examples: EXAMPLES[short] ?? [],
    validate: async (runtime: IAgentRuntime) => unbrowse(runtime) !== null,
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, _options?: unknown, callback?: HandlerCallback): Promise<ActionResult> => {
      const say = async (text: string) => {
        const content: Content = { text, actions: [name], source: message.content.source };
        await callback?.(content);
      };
      let values: Values;
      try {
        values = await extract(runtime, message, state, name, description, params);
      } catch (e) {
        const error = `couldn't read the parameters for ${name}: ${(e as Error).message}`;
        await say(error);
        return { success: false, text: error, error };
      }
      const absent = missing(params, values, spec.needsOneOf ?? []);
      if (absent.length) {
        const error = `${name} needs ${absent.join(" and ")}.`;
        await say(error);
        return { success: false, text: error, error, data: { params: values } };
      }
      const node = unbrowse(runtime)!.node;
      const reply = await runTool(node, spec, values);
      const ok = passed(reply);
      const refused = refusal(reply);
      const text = refused !== undefined ? `Unbrowse couldn't do it: ${refused}` : shown(reply);
      await say(text);
      return {
        success: ok,
        text,
        values: { unbrowseAction: name, unbrowseOk: ok },
        data: { params: values, reply },
        ...(!ok && { error: refused ?? text }),
      };
    },
  };
}

/** Every tool the node serves, as an action, in the node's order: UNBROWSE_DO, UNBROWSE_BROWSE, ... */
export const actions: Action[] = (Object.entries(TOOLS) as [ToolName, ToolSpec][]).map(([short, spec]) => action(short, spec));

const named = (n: string) => actions.find((a) => a.name === n)!;
export const doAction = named("UNBROWSE_DO");
export const browseAction = named("UNBROWSE_BROWSE");
export const searchAction = named("UNBROWSE_SEARCH");
export const callAction = named("UNBROWSE_CALL");
