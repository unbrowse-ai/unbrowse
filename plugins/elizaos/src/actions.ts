// The actions. Names are chosen to take over the host's web slots: WEB_FETCH is the name elizaOS 2.x registers
// its keyless fallback under (skipped when a plugin already provides it), and every action carries a routingHint
// that sends website work here instead of BROWSER (@elizaos/plugin-browser).
import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { browse, discover, getPending, resume, run, scrape, type Outcome, type Requirement } from "./unbrowse.ts";
import { extractUrls, messageText, obj, params, parsePairs, str, targetUrl } from "./text.ts";

async function reply(name: string, outcome: Outcome, callback?: HandlerCallback): Promise<ActionResult> {
  const result: ActionResult = {
    success: outcome.success,
    text: outcome.text,
    values: { unbrowseStatus: outcome.kind, ...(typeof outcome.data.runId === "string" ? { unbrowseRunId: outcome.data.runId } : {}) },
    data: { actionName: name, kind: outcome.kind, ...outcome.data },
    ...(outcome.success ? {} : { error: outcome.error?.message ?? outcome.text }),
  };
  if (callback) {
    try {
      // 2.x passes the action name as a second argument; 1.x ignores it.
      await (callback as (c: Parameters<HandlerCallback>[0], a?: string) => Promise<unknown>)({ text: outcome.text, actions: [name], source: "unbrowse" }, name);
    } catch {
      /* a failing host callback must not turn a finished call into a failure */
    }
  }
  return result;
}

const fail = (name: string, text: string, callback?: HandlerCallback) =>
  reply(name, { success: false, kind: "invalid_input", text, data: {}, error: { code: "invalid_input", message: text, text } }, callback);

/** The message with its URLs removed, as a task. "read https://x" → "read". */
function taskFrom(message: Memory, options: unknown): string {
  return str(params(options).task) ?? messageText(message);
}

// ---------------------------------------------------------------------------------------------------------------

export const webFetchAction: Action = {
  name: "WEB_FETCH",
  similes: ["UNBROWSE_SCRAPE", "READ_URL", "READ_WEBPAGE", "READ_PAGE", "FETCH_URL", "FETCH_PAGE", "SCRAPE_PAGE", "GET_WEBPAGE", "OPEN_LINK"],
  description:
    "Read one web page by URL through Unbrowse and return its main content as clean markdown with title and source. Renders JavaScript pages in Unbrowse's cloud browser when needed, signed in when a login is saved. Use for any link or page whose address is known.",
  routingHint:
    "read/fetch/summarize ONE page whose URL is known -> WEB_FETCH (Unbrowse); do a task or get data on a site without a URL -> UNBROWSE_RUN; interactive page with no route -> UNBROWSE_BROWSE; never BROWSER for reading websites",
  contexts: ["web", "browser"],
  parameters: [{ name: "url", description: "The page to read, e.g. https://example.com", required: true, schema: { type: "string" } }],
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State, options?: unknown) => Boolean(targetUrl(message, options)),
  handler: async (runtime, message, _state, options, callback) => {
    const url = targetUrl(message, options);
    if (!url) return fail("WEB_FETCH", "Which page should I read? Send its URL.", callback);
    return reply("WEB_FETCH", await scrape(runtime, url), callback);
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "read https://example.com" } },
      { name: "{{agent}}", content: { text: "Reading it through Unbrowse.", actions: ["WEB_FETCH"] } },
    ],
    [
      { name: "{{user}}", content: { text: "Summarize this article: https://blog.example.org/post/42" } },
      { name: "{{agent}}", content: { text: "Fetching the article.", actions: ["WEB_FETCH"] } },
    ],
  ],
};

export const runAction: Action = {
  name: "UNBROWSE_RUN",
  similes: ["WEB_TASK", "WEBSITE_TASK", "DO_ON_WEBSITE", "GET_WEBSITE_DATA", "SITE_TASK", "UNBROWSE"],
  description:
    "Do a task on a website through Unbrowse, in plain words (\"top stories on hacker news\", \"search flights SFO to JFK on Oct 3\"). Unbrowse picks a verified site capability and calls the site's own API, no browser. Reports input_required fields to ask the user, and falls back to the cloud browser when no route exists and a URL is known.",
  routingHint:
    "get data from / act on a website by describing the task -> UNBROWSE_RUN; reading one known URL -> WEB_FETCH; answering a question Unbrowse asked -> UNBROWSE_RESUME; never BROWSER",
  contexts: ["web", "browser", "automation"],
  parameters: [
    { name: "task", description: "The task in plain words, including the site when known.", required: true, schema: { type: "string" } },
    { name: "url", description: "The site or page the task is about (optional).", required: false, schema: { type: "string" } },
    { name: "capability", description: "A capability id from UNBROWSE_DISCOVER (optional).", required: false, schema: { type: "string" } },
    { name: "input", description: "Inputs for the capability, keyed by the names discover lists (optional).", required: false, schema: { type: "object" } },
  ],
  validate: async (_runtime, message, _state, options?: unknown) => Boolean(str(params(options).task) ?? str(params(options).capability) ?? (messageText(message).length >= 3 ? "ok" : undefined)),
  handler: async (runtime, message, _state, options, callback) => {
    const p = params(options);
    const task = taskFrom(message, options);
    const capability = str(p.capability);
    if (!task && !capability) return fail("UNBROWSE_RUN", "What should I do on the web? Describe the task.", callback);
    const out = await run(runtime, { task: task || undefined, capability, targetUrl: targetUrl(message, options), input: obj(p.input) }, message.roomId);
    return reply("UNBROWSE_RUN", out, callback);
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "What are the top stories on Hacker News right now?" } },
      { name: "{{agent}}", content: { text: "Checking Hacker News through Unbrowse.", actions: ["UNBROWSE_RUN"] } },
    ],
    [
      { name: "{{user}}", content: { text: "Find the price of the cheapest flight from SFO to JFK next Friday" } },
      { name: "{{agent}}", content: { text: "Looking it up with Unbrowse.", actions: ["UNBROWSE_RUN"] } },
    ],
  ],
};

export const discoverAction: Action = {
  name: "UNBROWSE_DISCOVER",
  similes: ["FIND_WEBSITE_CAPABILITY", "SEARCH_SITE_TOOLS", "WHAT_CAN_UNBROWSE_DO"],
  description:
    "List the Unbrowse capabilities (verified site tools) that match a need, with their ids and inputs, without running anything. Use before UNBROWSE_RUN when the user wants options or the right capability is unclear.",
  routingHint: "which site tools/capabilities exist for a need -> UNBROWSE_DISCOVER; doing the task -> UNBROWSE_RUN",
  contexts: ["web"],
  parameters: [{ name: "query", description: "What the user wants to do, e.g. 'hacker news top stories'", required: true, schema: { type: "string" } }],
  validate: async (_runtime, message, _state, options?: unknown) => Boolean(str(params(options).query) ?? (messageText(message).length >= 3 ? "ok" : undefined)),
  handler: async (runtime, message, _state, options, callback) => {
    const query = str(params(options).query) ?? messageText(message);
    if (!query) return fail("UNBROWSE_DISCOVER", "What should I look for?", callback);
    return reply("UNBROWSE_DISCOVER", await discover(runtime, query), callback);
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "What can Unbrowse do on news.ycombinator.com?" } },
      { name: "{{agent}}", content: { text: "Listing Unbrowse capabilities.", actions: ["UNBROWSE_DISCOVER"] } },
    ],
  ],
};

export const browseAction: Action = {
  name: "UNBROWSE_BROWSE",
  similes: ["BROWSE_SITE", "OPEN_SITE", "NAVIGATE_SITE", "CLOUD_BROWSER", "OPEN_IN_BROWSER", "UNBROWSE_OPEN"],
  description:
    "Open a URL in Unbrowse's cloud browser with a task, return the rendered page text, and close the session. Unbrowse records the visit and learns the site, so the next UNBROWSE_RUN on it can skip the browser. Use for interactive or JavaScript-heavy pages no capability covers.",
  routingHint:
    "open/browse/navigate a website or a page that needs a real browser -> UNBROWSE_BROWSE (Unbrowse cloud browser), not BROWSER; plain page read -> WEB_FETCH",
  contexts: ["browser", "web", "automation"],
  parameters: [
    { name: "url", description: "The page to open.", required: true, schema: { type: "string" } },
    { name: "task", description: "What to do there, in plain words.", required: false, schema: { type: "string" } },
  ],
  validate: async (_runtime, message, _state, options?: unknown) => Boolean(targetUrl(message, options)),
  handler: async (runtime, message, _state, options, callback) => {
    const url = targetUrl(message, options);
    if (!url) return fail("UNBROWSE_BROWSE", "Which site should I open? Send its URL.", callback);
    return reply("UNBROWSE_BROWSE", await browse(runtime, url, taskFrom(message, options) || undefined), callback);
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Open https://news.ycombinator.com and tell me what's on the front page" } },
      { name: "{{agent}}", content: { text: "Opening it in Unbrowse's cloud browser.", actions: ["UNBROWSE_BROWSE"] } },
    ],
  ],
};

/** Answers for the open requirements, from parameters or from the user's reply text. */
export function answersFrom(text: string, reqs: Requirement[], given?: Record<string, unknown>): Record<string, unknown> {
  if (given && Object.keys(given).length) return given;
  const fields = reqs.map((r) => r.affectedAction ?? r.id).filter((f): f is string => Boolean(f));
  const pairs = parsePairs(text);
  const lowerFields = new Map(fields.map((f) => [f.toLowerCase(), f]));
  const answers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pairs)) {
    const f = lowerFields.get(k.toLowerCase()) ?? (fields.length ? undefined : k);
    if (f) answers[f] = v;
  }
  // A single open question answered in plain words: the whole reply is the answer.
  if (!Object.keys(answers).length && reqs.length === 1 && text.trim()) answers[fields[0] ?? "answer"] = text.trim();
  // Choices: map a label or a 1-based number to the option's value.
  for (const r of reqs) {
    const f = r.affectedAction ?? r.id;
    if (!f || !r.options?.length || typeof answers[f] !== "string") continue;
    const a = (answers[f] as string).toLowerCase();
    const n = Number(a);
    const hit = Number.isInteger(n) && n >= 1 && n <= r.options.length ? r.options[n - 1] : r.options.find((o) => o.label?.toLowerCase() === a || String(o.value).toLowerCase() === a) ?? r.options.find((o) => o.label?.toLowerCase().includes(a));
    if (hit) answers[f] = hit.value;
  }
  return answers;
}

export const resumeAction: Action = {
  name: "UNBROWSE_RESUME",
  similes: ["ANSWER_UNBROWSE", "CONTINUE_UNBROWSE_RUN", "UNBROWSE_ANSWER"],
  description:
    "Answer the questions a paused Unbrowse run asked (input_required) and continue the same run. Takes the user's reply, e.g. \"origin: SFO, date: 2026-10-03\", or a choice by name or number.",
  routingHint: "user answers a question Unbrowse asked about a running task -> UNBROWSE_RESUME (same run, do not start a new one)",
  contexts: ["web"],
  parameters: [
    { name: "runId", description: "The paused run (defaults to the last one in this conversation).", required: false, schema: { type: "string" } },
    { name: "answers", description: "Map of requirement field -> value.", required: false, schema: { type: "object" } },
  ],
  validate: async (runtime, message, _state, options?: unknown) =>
    Boolean(str(params(options).runId) ?? getPending(runtime, message.roomId) ?? messageText(message).match(/\brun_[a-z0-9]+\b/i)),
  handler: async (runtime, message, _state, options, callback) => {
    const p = params(options);
    const text = messageText(message);
    const pending = getPending(runtime, message.roomId);
    const runId = str(p.runId) ?? text.match(/\brun_[a-z0-9]+\b/i)?.[0] ?? pending?.runId;
    if (!runId) return fail("UNBROWSE_RESUME", "There is no paused Unbrowse run to answer.", callback);
    const reqs = pending?.runId === runId ? pending.requirements : [];
    const answers = answersFrom(text.replace(/\brun_[a-z0-9]+\b/i, "").trim(), reqs, obj(p.answers));
    if (!Object.keys(answers).length) {
      const fields = reqs.map((r) => r.affectedAction ?? r.id).join(", ");
      return fail("UNBROWSE_RESUME", `Reply with the missing values${fields ? ` (${fields})` : ""}, e.g. "field: value".`, callback);
    }
    return reply("UNBROWSE_RESUME", await resume(runtime, runId, answers, message.roomId), callback);
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "origin: SFO, date: 2026-10-03" } },
      { name: "{{agent}}", content: { text: "Passing that to Unbrowse.", actions: ["UNBROWSE_RESUME"] } },
    ],
  ],
};

export const unbrowseActions: Action[] = [webFetchAction, browseAction, runAction, discoverAction, resumeAction];

export { extractUrls };
