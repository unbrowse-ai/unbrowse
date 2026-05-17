import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRequest } from "../src/mcp.js";

// Spec for plan acceptance #1, #2, #3, #4 of mcp-ux-fix Phase 2:
//   - initialize MUST report tools.listChanged: true (and prompts.listChanged: true)
//   - tools/list SHOULD partition session-only tools out when no session is open

type Frame = { jsonrpc: "2.0" } & Record<string, unknown>;
let captured: Frame[] = [];
let origWrite: typeof process.stdout.write;

beforeEach(() => {
  captured = [];
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try { captured.push(JSON.parse(trimmed)); } catch { /* not JSON */ }
    }
    return true;
  }) as any;
});

afterEach(() => {
  (process.stdout as any).write = origWrite;
});

async function call(method: string, params?: Record<string, unknown>): Promise<Frame> {
  captured = [];
  await handleRequest({ jsonrpc: "2.0", id: 1, method, params } as any);
  const reply = captured.find((f) => f.id === 1);
  if (!reply) throw new Error(`no reply for ${method}; captured=${JSON.stringify(captured)}`);
  return reply;
}

describe("initialize capabilities (Phase 2)", () => {
  test("tools.listChanged is true", async () => {
    const r = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const result = r.result as Record<string, any>;
    expect(result.capabilities.tools.listChanged).toBe(true);
  });

  test("prompts.listChanged is true", async () => {
    const r = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const result = r.result as Record<string, any>;
    expect(result.capabilities.prompts.listChanged).toBe(true);
  });
});

describe("tools/list always exposes the full tool set (session tools never hidden)", () => {
  test("with NO browse session, SESSION_TOOL_NAMES are still present", async () => {
    // Phase 2's hide-until-session reveal made session tools unreachable to
    // any client whose tool catalog is frozen before a session exists (a
    // spawned sub-agent: the post-go list_changed reaches only the parent).
    // The substrate must surface what exists and let the tool error
    // truthfully when called with no session, not hide the tool.
    const { SESSION_TOOL_NAMES } = await import("../src/mcp.js");
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const r = await call("tools/list");
    const tools = (r.result as any).tools as Array<{ name: string }>;
    const names = new Set(tools.map((t) => t.name));

    for (const t of ["unbrowse_resolve", "unbrowse_execute", "unbrowse_go", "unbrowse_health"]) {
      expect(names.has(t), `${t} must be visible`).toBe(true);
    }
    // Session-scoped tools are now ALWAYS discoverable, even with no session.
    for (const t of SESSION_TOOL_NAMES as Set<string>) {
      expect(names.has(t), `${t} must be discoverable without a session`).toBe(true);
    }
  });

  test("a session tool called with NO open session returns a clean error result (not a thrown -32603)", async () => {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
    const r = await call("tools/call", { name: "unbrowse_snap", arguments: {} });
    // Handled envelope, not a JSON-RPC throw: always-visible is only safe
    // if the handler errors truthfully with no session.
    expect(r.result, "no-session session-tool call must return a result envelope").toBeDefined();
    expect(r.error, "must not be a JSON-RPC -32603 throw").toBeUndefined();
  });

  test("tools/list returns full 33 when a session is open", async () => {
    // Phase 2 will expose setBrowseSessionOpen for tests; this expectation
    // documents the GREEN behavior we'll need.
    const { setBrowseSessionOpen } = await import("../src/mcp.js");
    setBrowseSessionOpen(true);
    try {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0" } });
      const r = await call("tools/list");
      const tools = (r.result as any).tools as Array<{ name: string }>;
      // Shape assertion (no hardcoded count — adding a tool shouldn't rot this test).
      expect(tools.length).toBeGreaterThanOrEqual(33);
      const names = new Set(tools.map((t) => t.name));
      expect(names.has("unbrowse_snap")).toBe(true);
      expect(names.has("unbrowse_close")).toBe(true);
    } finally {
      setBrowseSessionOpen(false);
    }
  });

  test("setBrowseSessionOpen emits notifications/tools/list_changed on transition", async () => {
    const { setBrowseSessionOpen } = await import("../src/mcp.js");
    // Ensure we start closed (idempotent — no notification fires)
    captured = [];
    setBrowseSessionOpen(false);
    expect(captured.filter((f) => f.method === "notifications/tools/list_changed").length).toBe(0);

    // Open → notification fires once
    captured = [];
    setBrowseSessionOpen(true);
    const opens = captured.filter((f) => f.method === "notifications/tools/list_changed");
    expect(opens.length).toBe(1);

    // Close → notification fires again
    captured = [];
    setBrowseSessionOpen(false);
    const closes = captured.filter((f) => f.method === "notifications/tools/list_changed");
    expect(closes.length).toBe(1);
  });
});

// ─── Edges (Step 5) ─────────────────────────────────────────────────────────

describe("setBrowseSessionOpen idempotence (Step 5 edge)", () => {
  test("open→open does not emit a second notification (changed=false guard)", async () => {
    const { setBrowseSessionOpen } = await import("../src/mcp.js");
    // start closed
    captured = [];
    setBrowseSessionOpen(false);
    setBrowseSessionOpen(false);
    expect(captured.filter((f) => f.method === "notifications/tools/list_changed").length).toBe(0);

    // open once → one notification
    captured = [];
    setBrowseSessionOpen(true);
    expect(captured.filter((f) => f.method === "notifications/tools/list_changed").length).toBe(1);

    // open again (already open) → no additional notification
    captured = [];
    setBrowseSessionOpen(true);
    expect(captured.filter((f) => f.method === "notifications/tools/list_changed").length).toBe(0);

    // cleanup
    setBrowseSessionOpen(false);
  });
});
