import { describe, it } from "bun:test";

// Day 3 (Land) seed test for Unbrowse MCP audit Phase 0a.
//
// Mustard-seed: every case below is `it.todo(...)`. Todos always pass and
// report as pending. Day 5 (Luminaries) flips these to real failing tests
// against the canonical alias-dispatch contract.
//
// Contract (Phase 0a):
//   `unbrowse_run` is a deprecated alias for `unbrowse_resolve`. Calling it
//   over MCP stdio dispatches to the resolve handler, returns the resolve
//   body verbatim, and tags the envelope with `deprecated: true` and
//   `renamed_to: "unbrowse_resolve"`. Unknown tool names like
//   `unbrowse_fetch` return a structured JSON-RPC error envelope whose `id`
//   matches the inbound request id, never crash the server.

describe("MCP alias dispatch (Phase 0a)", () => {
  it.todo(
    "unbrowse_run dispatches to unbrowse_resolve handler and result carries deprecated:true + renamed_to:\"unbrowse_resolve\"",
  );
  it.todo(
    "unbrowse_run result body matches unbrowse_resolve result body for same args",
  );
  it.todo(
    "unbrowse_fetch returns a JSON-RPC error envelope (not process death)",
  );
  it.todo(
    "unbrowse_fetch error envelope id matches the in-flight request id",
  );
});
