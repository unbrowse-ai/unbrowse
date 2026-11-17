import type { Plugin } from "@elizaos/core";
import { actions } from "./actions.js";
import { providers } from "./providers.js";
import { UnbrowseService } from "./service.js";

/**
 * Unbrowse for ElizaOS: say what you want from a website and get the site's own JSON back, through the Unbrowse node
 * on this machine. Settings: `UNBROWSE_AGENT_TOKEN` (required) and `UNBROWSE_NODE`.
 */
export const unbrowsePlugin: Plugin = {
  name: "unbrowse",
  description: "Websites as calls through the Unbrowse node on this machine: the node's own agent tools, as actions.",
  services: [UnbrowseService],
  actions,
  providers,
};

export { UnbrowseService, unbrowse } from "./service.js";
export { actions, doAction, browseAction, searchAction, callAction } from "./actions.js";
export { unbrowseProvider, unbrowseRoutesProvider } from "./providers.js";
export default unbrowsePlugin;
