import { describe, it, expect } from "bun:test";

/**
 * Regression test: HAR entries from Kuri may have undefined/null headers.
 * The capture code must guard `for (const h of entry.request.headers)` 
 * against non-iterable values.
 */

describe("HAR header iteration guard", () => {
  it("source code guards entry.request.headers iteration", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(
      require("node:path").join(__dirname, "../src/capture/index.ts"),
      "utf-8",
    );

    // Every `for (const h of entry.request.headers)` should be guarded
    const unguarded = source.match(
      /for\s*\(\s*const\s+\w+\s+of\s+entry\.request\.headers\s*\)/g,
    );
    expect(unguarded).toBeNull();

    // Same for response headers
    const unguardedResp = source.match(
      /for\s*\(\s*const\s+\w+\s+of\s+entry\.response\.headers\s*\)/g,
    );
    expect(unguardedResp).toBeNull();
  });
});
