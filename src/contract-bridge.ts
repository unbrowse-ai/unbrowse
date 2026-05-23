// Top-level entrypoint for the /contract MCP bridge. Mirrors src/mcp.ts's
// role: this file is what resolveSiblingEntrypoint(import.meta.url,
// "contract-bridge") finds when cli.ts spawns the bridge as a sibling.
//
// The implementation lives at src/bridges/contract-mcp-bridge.ts so it can
// be re-used (and unit-tested) without a side-effecting top-level main()
// call. This thin wrapper just imports and invokes it.

import { runBridge } from "./bridges/contract-mcp-bridge.js";

runBridge().catch((err) => {
  // Defensive: the bridge's own loop catches per-message errors. This
  // top-level handler exists only for unexpected startup failures (e.g.
  // process.stdin not readable).
  process.stderr.write(
    `[contract-bridge] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
