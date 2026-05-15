#!/usr/bin/env bun
// Upstream stub: reads JSON-RPC requests from stdin, echoes a response
// with the same id and a "side" field passed as argv[1].
// Used by tests/swap.test.ts to simulate CANDIDATE and BASELINE upstreams
// without needing to spawn real unbrowse MCP processes.
//
// Usage: bun run upstream-stub.ts <side-label>

const sideLabel = process.argv[2] || "unknown";

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx = buf.indexOf("\n");
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      try {
        const req = JSON.parse(line) as { id?: number | string; method?: string };
        const resp = {
          jsonrpc: "2.0",
          id: req.id,
          result: { side: sideLabel, method: req.method },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
      } catch (e) {
        process.stderr.write(`stub-parse-err: ${(e as Error).message}\n`);
      }
    }
    idx = buf.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
