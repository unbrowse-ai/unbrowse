import { ModelType, composePromptFromState, parseKeyValueXml, type IAgentRuntime, type Memory, type State } from "@elizaos/core";
import type { InputSchema } from "unbrowse/tools";
import { asActions } from "./words.js";

/** What one parameter is, in the words the extraction prompt shows the model. */
export type Param = {
  name: string;
  kind: "string" | "number" | "boolean" | "object" | "list";
  required?: boolean;
  description: string;
};

const KINDS: Record<string, Param["kind"]> = { string: "string", number: "number", integer: "number", boolean: "boolean", object: "object", array: "list" };

/**
 * A tool's input schema as the parameters its action reads off the conversation. The first of the argument sets a
 * call takes one of in full (`needsOneOf`: a goal, or an ask to collect) is said as required: it is what the model
 * reads off a conversation; `missing` lets any one set through.
 */
export function paramsOf(schema: InputSchema, needsOneOf: string[][] = []): Param[] {
  return Object.entries(schema.properties).map(([name, p]) => {
    const kind = KINDS[String(p.type)] ?? "string";
    const said = typeof p.description === "string" ? asActions(p.description) : name.replace(/_/g, " ");
    const choices = Array.isArray(p.enum) ? ` One of: ${p.enum.join(", ")}.` : "";
    const shape = kind === "object" ? " A JSON object of strings." : kind === "list" ? " A JSON array." : "";
    return { name, kind, required: schema.required.includes(name) || (needsOneOf[0] ?? []).includes(name), description: `${said}${choices}${shape}` };
  });
}

export type Values = {
  [name: string]: string | number | boolean | (string | object)[] | Record<string, string> | undefined;
};

/** The numbers someone wrote, read as amounts: "$12.50", "1,200", "3". */
function numbers(text: string): number[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, ""))).filter(Number.isFinite);
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One value as its parameter takes it, or undefined when it can't be read as that. */
function read(p: Param, raw: unknown): Values[string] {
  if (raw === undefined || raw === null) return undefined;
  switch (p.kind) {
    case "string": {
      const s = String(raw).trim();
      return s ? s : undefined;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
      return String(raw).trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
    }
    case "boolean":
      return raw === true || String(raw).trim().toLowerCase() === "true" ? true : undefined;
    case "object": {
      const o = typeof raw === "string" ? json(raw.trim()) : raw;
      if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
      const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
      return Object.keys(out).length ? out : undefined;
    }
    case "list": {
      const l = Array.isArray(raw) ? raw : json(String(raw).trim());
      // An item that is an object (one of a call's pages) stays one; anything else is its text.
      if (Array.isArray(l)) return l.length ? l.map((x) => (x && typeof x === "object" ? (x as object) : String(x))) : undefined;
      // Not JSON: the command as words.
      const words = String(raw).trim().split(/\s+/).filter(Boolean);
      return words.length ? words : undefined;
    }
  }
}

function prompt(action: string, description: string, params: Param[], state: State, message: Memory): string {
  const head = composePromptFromState({
    state,
    template: `# Task: Fill in the parameters for {{agentName}}'s ${action} action.

${action}: ${description}

{{recentMessages}}`,
  });
  const lines = params.map((p) => `- ${p.name} (${p.required ? "required" : "optional"}): ${p.description}`);
  const tags = params.map((p) => `  <${p.name}>...</${p.name}>`);
  // The latest message goes in after the template is filled, so its text is never read as a template.
  return `${head}

The latest message:
${message.content.text ?? ""}

Parameters:
${lines.join("\n")}

Take the values from the conversation. Leave out a parameter the conversation doesn't give; never make one up.

Respond with only this, keeping the tags of the parameters you fill:
<response>
${tags.join("\n")}
</response>`;
}

/**
 * The parameters for an action. Values the planner already gave (`content.actionParams`, as other plugins take them)
 * are used as they are; otherwise the model reads them off the conversation. A number the model reads off the
 * conversation (a bounty's id, a click's place) is kept only when the conversation says that number: it's never
 * invented.
 */
export async function extract(runtime: IAgentRuntime, message: Memory, state: State | undefined, action: string, description: string, params: Param[]): Promise<Values> {
  const given = (message.content as { actionParams?: unknown; actionInput?: unknown }).actionParams ?? (message.content as { actionInput?: unknown }).actionInput;
  if (given && typeof given === "object" && !Array.isArray(given)) {
    const g = given as Record<string, unknown>;
    return Object.fromEntries(params.map((p) => [p.name, read(p, g[p.name])]));
  }

  const s = state ?? (await runtime.composeState(message));
  const reply = await runtime.useModel(ModelType.TEXT_SMALL, { prompt: prompt(action, description, params, s, message) });
  const parsed = parseKeyValueXml<Record<string, unknown>>(String(reply)) ?? {};
  const values: Values = Object.fromEntries(params.map((p) => [p.name, read(p, parsed[p.name])]));

  const said = numbers(`${message.content.text ?? ""}\n${String(s.values?.recentMessages ?? "")}`);
  for (const p of params) {
    const v = values[p.name];
    if (p.kind === "number" && typeof v === "number" && !said.some((n) => Math.abs(n - v) < 1e-9)) values[p.name] = undefined;
  }
  return values;
}

/**
 * The required parameters with no value; with none of those, the first missing names of the first of the sets the call
 * takes one of in full (`needsOneOf`: a goal, or an ask to collect) when it has none of them.
 */
export function missing(params: Param[], values: Values, needsOneOf: string[][] = []): string[] {
  const inASet = (name: string) => needsOneOf.some((g) => g.includes(name));
  const required = params.filter((p) => p.required && !inASet(p.name) && values[p.name] === undefined).map((p) => p.name);
  if (required.length || !needsOneOf.length) return required;
  const absent = (k: string) => values[k] === undefined || values[k] === "";
  return needsOneOf.some((g) => g.every((k) => !absent(k))) ? [] : needsOneOf[0].filter(absent);
}
