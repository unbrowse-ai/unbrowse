// Backwards-compatible re-export so the plugin can keep importing `./tools.js`
// while the actual implementation lives under `src/plugin/tools/`.

export { createTools } from "./tools/index.js";
export type { ToolDeps } from "./tools/deps.js";

