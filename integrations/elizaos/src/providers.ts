import type { IAgentRuntime, Provider } from "@elizaos/core";
import { unbrowse } from "./service.js";
import { INSTRUCTIONS, RULES } from "./words.js";

/** How many routes the routes provider lists. */
const LISTED = 25;

/** What Unbrowse can do and how to use it, in every prompt while the plugin has a token. */
export const unbrowseProvider: Provider = {
  name: "UNBROWSE",
  description: "What Unbrowse can do: websites as calls through the node on this machine.",
  get: async (runtime: IAgentRuntime) => {
    const s = unbrowse(runtime);
    if (!s) return { text: "", values: { unbrowseReady: false }, data: {} };
    return {
      text: `# Unbrowse\n${INSTRUCTIONS}\n\n${RULES.map((r) => `- ${r}`).join("\n")}`,
      values: { unbrowseReady: true, unbrowseNode: s.node.baseUrl },
      data: {},
    };
  },
};

/** The routes the node knows, asked for when an action or prompt wants them: it calls the node. */
export const unbrowseRoutesProvider: Provider = {
  name: "UNBROWSE_ROUTES",
  description: "The routes the Unbrowse node knows: what each does, on which site, with which inputs.",
  dynamic: true,
  get: async (runtime: IAgentRuntime) => {
    const s = unbrowse(runtime);
    if (!s) return { text: "", values: {}, data: { routes: [] } };
    try {
      const routes = (await s.node.search("")).slice(0, LISTED);
      if (!routes.length) return { text: "# Unbrowse routes\nNone yet: UNBROWSE_DO with the url of a page learns one.", values: {}, data: { routes } };
      const lines = routes.map((r) => `- ${r.id}: ${r.what} (${r.site})${r.inputs?.length ? `, inputs: ${r.inputs.map((i) => i.name).join(", ")}` : ""}${r.write ? ", writes" : ""}`);
      return { text: `# Unbrowse routes\n${lines.join("\n")}`, values: {}, data: { routes } };
    } catch (e) {
      // The node is down or refused: the prompt goes on without its routes.
      return { text: "", values: {}, data: { routes: [], error: (e as Error).message } };
    }
  },
};

export const providers = [unbrowseProvider, unbrowseRoutesProvider];
