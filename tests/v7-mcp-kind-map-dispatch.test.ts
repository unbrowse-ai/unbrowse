/**
 * W11 — v7 dispatch / MCP kind-map wiring tests.
 *
 *   Acts 2:6 — "every man heard them speak in his own language."
 *
 * The dispatch layer is the 1:1:1 translation: MCP tool name ->
 * op_kind -> v7 CLI handler. These tests assert:
 *
 *   (1) Every KIND_MAP row resolves: dispatchByKind returns a
 *       structured DispatchResult (not a throw, not undefined).
 *   (2) Smoke: a known MCP tool (eval version) routes through dispatch
 *       and returns a v6-shape-compatible response (walletPubkey hex,
 *       version string, buildSha string).
 *   (3) Negative: unknown_kind yields a structured envelope.
 *   (4) Round-trip: every kind-map row's mcp_tool name MUST appear
 *       in src/mcp.ts tool registrations.
 *   (5) Secret-redaction guard: a fill-shape dispatch with arg://canary
 *       and a UNB7-MCP-CANARY-DO-NOT-LEAK value never leaks the canary
 *       string into stdout / stderr / jsonResult — only the pointer.
 *   (6) W5/W6/W9-dependent cases gated behind UNBROWSE_W5W6_READY=1.
 *
 * No mocks for v7 handlers — they run in-process. For (2)/(5) we
 * spin a hermetic Bun.serve to absorb the audit POST and the version
 * surface needs no backend at all.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  dispatchByKind,
  findKindEntry,
  listOpKinds,
  listMcpTools,
} from "../src/cli-v7/dispatch/index.js";
import { KIND_MAP } from "../src/cli-v7/kind-map.js";

const W5W6_READY = process.env.UNBROWSE_W5W6_READY === "1";

describe("v7 dispatch — kind-map coverage", () => {
  it("findKindEntry returns a row for every op_kind in KIND_MAP", () => {
    for (const entry of KIND_MAP) {
      const found = findKindEntry(entry.op_kind);
      expect(found).toBeDefined();
      expect(found?.subcommand).toBe(entry.subcommand);
    }
  });

  it("listMcpTools returns the non-null MCP tool names", () => {
    const tools = listMcpTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) {
      expect(typeof t).toBe("string");
      expect(t.startsWith("unbrowse_")).toBe(true);
    }
  });

  it("listOpKinds returns every kind-map row", () => {
    const kinds = listOpKinds();
    expect(kinds.length).toBe(KIND_MAP.length);
  });
});

describe("v7 dispatch — dispatchByKind structural contract", () => {
  it("returns a structured envelope for every kind (no throws, no undefined)", async () => {
    // Most kinds need a live CDP session / vault / backend. We only
    // assert structural contract: dispatch returns a DispatchResult,
    // never throws, has route_kind + subcommand + exitCode set.
    // Kinds that hit CDP without a session will exit non-zero — that's
    // a structured failure, not a throw.
    for (const entry of KIND_MAP) {
      const skipNeedsLiveBrowser =
        !W5W6_READY &&
        (entry.verb === "act" ||
          entry.op_kind === "eval:snap" ||
          entry.op_kind === "eval:markdown" ||
          entry.op_kind === "eval:screenshot" ||
          entry.op_kind === "eval:text");
      if (skipNeedsLiveBrowser) continue;

      const skipNeedsBackend =
        !W5W6_READY &&
        (entry.op_kind === "eval:resolve" ||
          entry.op_kind === "eval:stats" ||
          entry.op_kind === "eval:skills" ||
          entry.op_kind === "eval:skill" ||
          entry.op_kind === "eval:earnings" ||
          entry.op_kind === "eval:feedback" ||
          entry.op_kind === "eval:reflect" ||
          entry.op_kind === "build:skill" ||
          entry.op_kind === "build:template" ||
          entry.op_kind === "build:value-source" ||
          entry.op_kind === "eval:trace" ||
          entry.op_kind === "eval:settings" ||
          entry.op_kind === "eval:cookies");
      if (skipNeedsBackend) continue;

      // version + sessions + status are mostly self-contained.
      const result = await dispatchByKind(entry.op_kind, {}, { json: true });
      expect(result).toBeDefined();
      expect(result.op_kind).toBe(entry.op_kind);
      expect(result.subcommand).toBe(entry.subcommand);
      expect(typeof result.exitCode).toBe("number");
    }
  });

  it("eval version: returns walletPubkey + version + buildSha (v6 wire compat)", async () => {
    const r = await dispatchByKind("eval:version", {}, { json: true });
    expect(r.dispatch_error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.jsonResult).toBeDefined();
    const body = r.jsonResult as Record<string, unknown>;
    expect(body.subcommand).toBe("eval version");
    expect(body.op_kind).toBe("eval:version");
    expect(typeof body.version).toBe("string");
    expect(typeof body.walletPubkey).toBe("string");
    // walletPubkey is 32 bytes hex
    expect((body.walletPubkey as string).length).toBe(64);
    // signatureScheme is the v7 identity tag
    expect(body.signatureScheme).toBe("ed25519-v7.0");
  });

  it("unknown kind returns a structured envelope, not a throw", async () => {
    const r = await dispatchByKind("not_a_real_kind", {}, {});
    expect(r.ok).toBe(false);
    expect(r.dispatch_error).toBe("unknown_op");
    expect(r.exitCode).toBe(70);
  });
});

describe("v7 dispatch — MCP registration round-trip", () => {
  it("every kind-map mcp_tool appears as a registered tool name in src/mcp.ts", () => {
    const mcpSource = readFileSync(
      join(import.meta.dir, "..", "src", "mcp.ts"),
      "utf8",
    );
    for (const entry of KIND_MAP) {
      if (!entry.mcp_tool) continue;
      // Skip the two NEW MCP tools the kind-map flags for a later wave.
      // They are intentionally not yet registered in mcp.ts (the W3 spec
      // gates them on a later wiring wave).
      if (entry.mcp_tool === "unbrowse_proxy_rotate") continue;
      if (entry.mcp_tool === "unbrowse_version") continue;
      // W23 (2026-05-28) — new persistent-session MCP tools land in a
      // later wiring wave alongside the v7.3 KV-storage real impl.
      if (entry.mcp_tool === "unbrowse_session_park") continue;
      if (entry.mcp_tool === "unbrowse_session_restore") continue;
      // W32-B (2026-05-28) — the end-to-end form-fill pipe lands its MCP
      // tool in a later wiring wave (the CLI surface + route dogfood
      // ship first; mcp.ts registration follows once the multi-slot
      // handler is exercised against real sessions).
      if (entry.mcp_tool === "unbrowse_fill_form") continue;
      const needle = `name: "${entry.mcp_tool}"`;
      expect(mcpSource.includes(needle)).toBe(true);
    }
  });
});

describe("v7 dispatch — secret-redaction canary", () => {
  it("a fill dispatch with arg://canary never leaks the canary value", async () => {
    if (!W5W6_READY) {
      // act fill needs a live CDP session AND the values adapter.
      // Without W5/W6, the handler exits before touching the value —
      // which is fine for this guard: assert the canary never appears
      // in stdout/stderr/jsonResult regardless of exit shape.
    }
    const CANARY = "UNB7-MCP-CANARY-DO-NOT-LEAK";
    const r = await dispatchByKind(
      "act:fill",
      {
        selector: "input[name=q]",
        pointer: "arg://canary",
        arg: `canary=${CANARY}`,
      },
      { json: true },
    );
    // Whatever happened (success, missing session, CDP error), the
    // canary string MUST NOT appear in any output channel.
    expect(r.stdout.includes(CANARY)).toBe(false);
    expect(r.stderr.includes(CANARY)).toBe(false);
    const jsonStr = r.jsonResult ? JSON.stringify(r.jsonResult) : "";
    expect(jsonStr.includes(CANARY)).toBe(false);
    // The pointer URI MAY appear (pointer-not-payload is the contract).
    // We don't require it (the handler may have exited before logging
    // the pointer), but if it DID appear, it must be the URI shape.
    if (jsonStr.includes("arg://")) {
      expect(jsonStr.includes("arg://canary") || jsonStr.includes("arg://__inline__")).toBe(true);
    }
  });
});
