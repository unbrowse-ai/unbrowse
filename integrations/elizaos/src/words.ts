// What the plugin tells the agent beyond each action's own description (which is the node's MCP tool's, from
// `unbrowse/tools`): the node's MCP instructions, with the action names put in for the tool names, and the rules the
// unbrowse skill adds.

export const INSTRUCTIONS =
  "Unbrowse turns websites into calls. Say what you want with UNBROWSE_DO, with the url of a page that does it: the node calls the route that does it, or learns one from the page and calls that. Calls go straight to the site's own API, no browser. When UNBROWSE_DO says the page needs hands (how: browse), drive it with UNBROWSE_BROWSE, never another browser: the node learns from every step.";

/** What the skill adds on top: how to keep using a route, check an answer, retry and sign in. */
export const RULES = [
  "Keep using the goal words you started with: the same words find the same route.",
  "Once a route is learned, call it (UNBROWSE_DO with the same goal, or UNBROWSE_CALL with its id) instead of clicking through the flow again.",
  "Read the answer against the goal: when it isn't what was asked for on that page, say so with UNBROWSE_JUDGE (verdict wrong, the route's id, the url and why), then ask again.",
  "Another contributor's route costs its fee, which the node pays by itself from its balance up to the owner's per-fetch maximum: nothing to approve.",
  "A write that fails is never sent twice by the node: read retry before running it again (as_is: run it again; check_first: look at the site first; never: do not send it again).",
  "To sign in or pay, fill a field with a vault reference from UNBROWSE_LOGINS (vault:<site>:<account>, vault:card:<label>:number); the node types the secret itself, and a card asks the owner first.",
];

/** A tool's name as this plugin's action: unbrowse_do → UNBROWSE_DO. */
export const actionName = (tool: string) => tool.toUpperCase();

/** The node's words with each tool name as its action's, so the agent reads the names it can pick. */
export const asActions = (text: string) => text.replace(/\bunbrowse_[a-z_]+\b/g, actionName);
