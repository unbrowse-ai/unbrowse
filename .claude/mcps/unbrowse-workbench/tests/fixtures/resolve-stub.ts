#!/usr/bin/env bun
// Candidate stub for recorded-baseline.test.ts. Answers initialize and
// echoes a 2-op resolve result for any tools/call. Used to prove the proxy
// diffs candidate (2 ops) against a golden baseline (1 op) in recorded mode
// without spawning a live baseline child.

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
        if (req.id === undefined || req.id === null) {
          // notification (e.g. notifications/initialized): no response
          idx = buf.indexOf("\n");
          continue;
        }
        const result =
          req.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "resolve-stub", version: "1" } }
            : {
                status: "ok",
                available_operations: [
                  { endpoint_id: "cand-1", url: "https://news.ycombinator.com/" },
                  { endpoint_id: "cand-2", url: "https://news.ycombinator.com/newest" },
                ],
              };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
      } catch (e) {
        process.stderr.write(`stub-parse-err: ${(e as Error).message}\n`);
      }
    }
    idx = buf.indexOf("\n");
  }
});

process.stdin.on("end", () => process.exit(0));
