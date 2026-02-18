// Backwards-compatible export so plugin code keeps importing `./tools.js`,
// while the actual tool implementations live in `@getfoundry/unbrowse-core`.

import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { createToolList, type ToolDeps } from "@getfoundry/unbrowse-core";

export type { ToolDeps } from "@getfoundry/unbrowse-core";

export function createTools(deps: ToolDeps) {
  return (_ctx: OpenClawPluginToolContext) => {
    return createToolList(deps as any) as any;
  };
}
