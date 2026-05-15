#!/usr/bin/env bun
// Upstream stub that echoes its UNBROWSE_URL env var back in the response.
// Used by tests/per-side-url.test.ts to assert proxy.ts passes per-side
// UNBROWSE_URL to candidate vs baseline children.

const url = process.env.UNBROWSE_URL || "no-url";

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
          result: { url, method: req.method },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
      } catch (e) {
        process.stderr.write(`stub-parse-err: ${(e as Error).message}\n`);
      }
    }
    idx = buf.indexOf("\n");
  }
});

process.stdin.on("end", () => process.exit(0));
