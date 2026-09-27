// @unbrowse/plugin-unbrowse: Unbrowse for elizaOS (1.x, forward-compatible with 2.x action fields).
import type { Plugin } from "@elizaos/core";
import { browseAction, discoverAction, resumeAction, runAction, unbrowseActions, webFetchAction } from "./actions.ts";
import { PLUGIN_NAME } from "./client.ts";
import { unbrowseProvider } from "./provider.ts";

// No `init`: elizaOS 1.x registers character plugins concurrently and `await plugin.init()` yields, so a plugin
// with an init registers its actions after plugins without one. Staying init-free keeps WEB_FETCH first-wins.
export const unbrowsePlugin: Plugin = {
  name: PLUGIN_NAME,
  description:
    "Unbrowse website access: read pages (WEB_FETCH), run website tasks through verified site APIs (UNBROWSE_RUN), discover capabilities, answer paused runs, and use Unbrowse's cloud browser (UNBROWSE_BROWSE). Replaces the default browser.",
  actions: unbrowseActions,
  providers: [unbrowseProvider],
};

export default unbrowsePlugin;
export { browseAction, discoverAction, resumeAction, runAction, unbrowseActions, unbrowseProvider, webFetchAction };
