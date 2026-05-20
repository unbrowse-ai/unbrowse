// When a page-artifact endpoint (dom_extraction set) hits HTTP 0
// (network_failure / browser fetch blocked by anti-bot), execute should
// fall through to the SSR fastpath (libcurl-impersonate via Kuri sandbox)
// the same way 5xx/429/404 do. Probe 010 (hub.docker.com/_/nginx/tags)
// surfaced this gap deterministically: W4 promotion picked the
// page-artifact at score 380, browser fetch returned status 0, and the
// previous condition at src/execution/index.ts:L3787 caught only
// `status === 404 || status === 429 || status >= 500`, so status 0
// fell through to the stale-endpoint return path without trying the
// SSR fastpath that DOES bypass anti-bot.
//
// Structural test: the source must declare the extended condition and
// gate the SSR fastpath on `status === 0 && endpoint.dom_extraction`.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src/execution/index.ts"), "utf8");

describe("execute page-artifact HTTP 0 SSR-fastpath fallback", () => {
  it("entry condition includes status === 0 alongside the other recoverable statuses", () => {
    expect(SRC).toMatch(/!trace\.success && \(status === 0 \|\| status === 401 \|\| status === 403 \|\| status === 404 \|\| status === 429 \|\| status >= 500\)/);
  });

  it("status 0 only triggers the fastpath when endpoint has dom_extraction (page-artifact)", () => {
    expect(SRC).toMatch(/const isStatusZeroPageArtifact = status === 0 && !!endpoint\.dom_extraction/);
    expect(SRC).toMatch(/\(status >= 500 \|\| isStatusZeroPageArtifact\) && !isPageFetchEndpoint\(endpoint\)/);
  });

  it("comment cites the specific probe and intent of the fix", () => {
    expect(SRC).toMatch(/hub\.docker\.com/);
    expect(SRC).toMatch(/anti-bot rejected the headless tab|libcurl-impersonate/);
  });
});
