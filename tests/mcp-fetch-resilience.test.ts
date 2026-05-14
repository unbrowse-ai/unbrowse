import { describe, it } from "bun:test";

// Day 3 (Land) seed test for Unbrowse MCP audit Phase 0c.
//
// Mustard-seed: every case below is `it.todo(...)`. Todos always pass and
// report as pending. Day 5 (Luminaries) flips these to real failing tests
// against the stdio-resilience contract.
//
// Contract (Phase 0c):
//   When a tool handler throws (synchronously or via uncaughtException), the
//   MCP stdio server emits a JSON-RPC error envelope with code -32603 and
//   the inbound request id, then stays alive. Subsequent `tools/list` and
//   `unbrowse_health` calls succeed on the same stdio session. No call ever
//   takes down the broker.

describe("MCP stdio resilience (Phase 0c)", () => {
  it.todo(
    "triggering uncaughtException in a handler emits a JSON-RPC error envelope code -32603",
  );
  it.todo(
    "error envelope id matches the request id of the crashing call, not null",
  );
  it.todo(
    "subsequent tools/list on same stdio after crash returns the tool registry",
  );
  it.todo(
    "subsequent unbrowse_health call returns status:\"ok\" after crash",
  );
});
