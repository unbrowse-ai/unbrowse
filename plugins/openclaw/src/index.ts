// OpenClaw entry. A plain definition object (the shape `definePluginEntry` returns), so the built plugin
// imports nothing from `openclaw` and loads the same from npm, a local path or a linked checkout.
// Config is validated by the manifest's configSchema (openclaw.plugin.json).
import type { PluginApi } from "./host-types.ts";
import { PLUGIN_ID, register } from "./plugin.ts";

const entry = {
  id: PLUGIN_ID,
  name: "Unbrowse",
  description: "Websites as APIs: Unbrowse's hosted tools (discover, run, scrape, cloud browser) replace OpenClaw's built-in browser for web pages.",
  register(api: PluginApi): void {
    register(api);
  },
};

export default entry;
