import type { ToolDeps as PluginToolDeps } from "./plugin-tools/deps.js";
import { createTools as createPluginTools } from "./plugin-tools/index.js";

// Public deps type: currently matches the existing plugin ToolDeps shape.
// Long-term: split into smaller adapters (BrowserAdapter, MarketplaceAdapter, etc).
export type ToolDeps = PluginToolDeps;

/**
 * Create Unbrowse tool implementations (tool specs).
 *
 * This is framework-agnostic: OpenClaw plugin, standalone CLI, and other runtimes
 * should all call this and only provide `deps`.
 */
export function createToolList(deps: ToolDeps): any[] {
  // plugin-tools/index.ts today returns a function expecting OpenClaw context.
  // The context is unused; keep it `null` for non-OpenClaw runtimes.
  const factory = createPluginTools(deps) as any;
  return factory(null);
}

