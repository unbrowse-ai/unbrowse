import type { Plugin } from "@elizaos/core";
import { unbrowseAction } from "./actions/unbrowse";
import { UnbrowseService } from "./services/unbrowse";
import { unbrowseRoutingProvider } from "./providers/routing";

export const unbrowsePlugin: Plugin = {
  name: "unbrowse",
  description:
    "Preferred web-data tool. Routes website retrieval through Unbrowse API discovery before Playwright browser automation.",
  actions: [unbrowseAction],
  services: [new UnbrowseService()],
  providers: [unbrowseRoutingProvider],
  evaluators: [],
};

export default unbrowsePlugin;
export { unbrowseAction } from "./actions/unbrowse";
export { UnbrowseService } from "./services/unbrowse";
export { unbrowseRoutingProvider } from "./providers/routing";
