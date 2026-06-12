import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the live bug Lewis hit on 2026-05-13:
//   `unbrowse_execute` with {path, extract, limit} returned
//   "payload_exceeded_wire_budget_after_diet" with body_excerpt holding
//   the full un-projected response, forcing the agent to shell out to
//   the CLI.
//
// The smoke probe at /tmp/mcp-projection-smoke.mjs proved the source-side
// path is correct — projection fires end-to-end through stdio dispatch
// and the handler's maybePostProcessResult call. The live failure was
// a stale dist/mcp.js daemon, not a source bug.
//
// This file pins three contracts of the projection-vs-diet pipeline so
// future drift surfaces here, not in an agent transcript:
//
//   1. Happy path — projection fits under WIRE_BUDGET_CHARS. The agent
//      gets back an Array of projected rows.
//   2. Many small items, projected array still > budget — the diet's
//      capOversizeArrays (src/mcp.ts:766-785) trims the array to
//      ARRAY_MAX_ELEMENTS and appends its existing
//      `{truncated: N, unit: "items"}` sentinel. The agent still gets
//      an Array, just shorter, with the sentinel as the LAST element.
//   3. Few items, each item too large to fit even after string-truncate —
//      the diet falls back to the wrapper shape
//      `{truncated: true, reason, budget_chars, original_chars,
//      body_excerpt}` with a non-empty body_excerpt. This is the
//      degenerate case; we assert body_excerpt is not the empty-string
//      safety-net branch.
//
// These shapes are what `maybePostProcessResult` + `dietIfOversize`
// produce TODAY (verified empirically by /tmp/probe-fat-projection.mjs
// on 2026-05-13). Do NOT invent new sentinel keys or envelope shapes
// in the source to make this test green — the test pins existing
// behavior so source can't silently drift.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MCP_ENTRY = path.join(REPO, "src", "mcp.ts");

function happyBody(n: number) {
  return {
    trace: { trace_id: "stub", success: true, status_code: 200 },
    result: {
      code: 0,
      message: "OK",
      data: {
        total_count: n,
        list: Array.from({ length: n }, (_, i) => ({
          bid: 100000 + i,
          name: `Restaurant ${i}`,
          cover_image: "/img.png".repeat(50),
          area: "Singapore",
          ratings: "4.5",
          slots: Array.from({ length: 10 }, (_, j) => ({
            discount: 50 - j,
            slot: `${j}:00`,
          })),
        })),
      },
    },
  };
}

function manySmallItemsBody(n: number, nameLen: number) {
  return {
    trace: { trace_id: "stub", success: true, status_code: 200 },
    result: {
      code: 0,
      message: "OK",
      data: {
        total_count: n,
        list: Array.from({ length: n }, (_, i) => ({
          bid: 100000 + i,
          name: `R${i}-`.padEnd(nameLen, "x"),
          area: "Singapore",
        })),
      },
    },
  };
}

function fewLargeItemsBody(n: number, nameLen: number) {
  return {
    trace: { trace_id: "stub", success: true, status_code: 200 },
    result: {
      code: 0,
      message: "OK",
      data: {
        total_count: n,
        list: Array.from({ length: n }, (_, i) => ({
          bid: 100000 + i,
          name: `R${i}-`.padEnd(nameLen, "x"),
          area: "Singapore",
        })),
      },
    },
  };
}

type Rpc = { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown };

async function startStub(port: number, executeBody: () => unknown) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/skills/") && req.url.endsWith("/execute")) {
        res.end(JSON.stringify(executeBody()));
        return;
      }
      if (req.url?.includes("/v1/intent/resolve")) {
        res.end(JSON.stringify({ result: { message: "stub" } }));
        return;
      }
      if (req.url?.includes("/v1/health")) {
        res.end(JSON.stringify({ ok: true, version: "stub" }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(port, () => r()));
  return server;
}

async function callMcp(stubPort: number, args: Record<string, unknown>): Promise<{ rpc: Rpc; wireSize: number }> {
  const env = {
    ...process.env,
    UNBROWSE_URL: `http://127.0.0.1:${stubPort}`,
    UNBROWSE_API_URL: `http://127.0.0.1:${stubPort}`,
    UNBROWSE_BACKEND_URL: `http://127.0.0.1:${stubPort}`,
    UNBROWSE_MCP_HTTP_BACKEND: "1",
    UNBROWSE_NO_AUTO_START: "1",
    UNBROWSE_TEST_FAIL_FAST: "0",
  };

  const proc = spawn("bun", [MCP_ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdoutBuffer = "";
  const responses: Rpc[] = [];
  proc.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let nl: number;
    while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      try { responses.push(JSON.parse(line)); } catch { /* skip */ }
    }
  });
  proc.stderr.on("data", () => {});

  function send(id: number, method: string, params: unknown) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }
  function waitFor(id: number, timeoutMs = 10_000): Promise<Rpc> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const r = responses.find((r) => r.id === id);
        if (r) return resolve(r);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout for id ${id}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  try {
    await new Promise((r) => setTimeout(r, 200));
    send(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "regression", version: "0" },
    });
    await waitFor(1);
    send(2, "tools/call", { name: "unbrowse_execute", arguments: args });
    const rpc = await waitFor(2);
    const wireSize = JSON.stringify(rpc).length;
    return { rpc, wireSize };
  } finally {
    proc.kill();
  }
}

const WIRE_BUDGET_CHARS = 25_000;

describe("unbrowse_execute projection survives stdio dispatch", () => {
  // Allocate a fresh port per test to avoid races.
  function nextPort() {
    return 17000 + Math.floor(Math.random() * 800);
  }

  test("happy path: path + extract + limit returns a projected Array under budget", async () => {
    const port = nextPort();
    const stub = await startStub(port, () => happyBody(20));
    try {
      const { rpc, wireSize } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: { filter_regionid: "27" },
        path: "data.list[]",
        extract: "name,area",
        limit: 10,
      });

      const result = rpc.result as { structuredContent?: { result?: unknown }; result?: unknown };
      const structured = result?.structuredContent ?? (result as Record<string, unknown>);
      const inner = (structured as { result?: unknown })?.result;

      expect(Array.isArray(inner), "structuredContent.result must be an Array after path+extract+limit").toBe(true);
      const arr = inner as Array<Record<string, unknown>>;
      expect(arr.length, "projection limit must be honored").toBe(10);
      const keys = Object.keys(arr[0] ?? {}).sort();
      expect(keys, "extract keys must reach the wire").toEqual(["area", "name"]);
      expect(wireSize, `wire response must stay under ${WIRE_BUDGET_CHARS} chars`).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);
    } finally {
      stub.close();
    }
  }, 30_000);

  test("many small items overshooting budget: capOversizeArrays sentinel survives at the tail", async () => {
    // 500 × 50-char names → projected array > 25K. The diet's
    // capOversizeArrays (src/mcp.ts:766-785) caps to ARRAY_MAX_ELEMENTS=50
    // and appends its existing `{truncated: N, unit: "items"}` sentinel.
    // The agent still gets an Array — just shorter — with the sentinel
    // as the last element.
    const port = nextPort();
    const stub = await startStub(port, () => manySmallItemsBody(500, 50));
    try {
      const { rpc, wireSize } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: {},
        path: "data.list[]",
        extract: "name",
      });

      const result = rpc.result as { structuredContent?: { result?: unknown } };
      const structured = result?.structuredContent;
      const inner = structured?.result;

      expect(Array.isArray(inner), "result must remain an Array after diet cap").toBe(true);
      const arr = inner as Array<Record<string, unknown>>;
      const sentinel = arr[arr.length - 1] as Record<string, unknown>;
      expect(
        sentinel,
        "last element must be the existing capOversizeArrays sentinel {truncated, unit:'items'}",
      ).toEqual({ truncated: 450, unit: "items" });
      expect(arr.length, "array must be capped at ARRAY_MAX_ELEMENTS+1 (50 items + sentinel)").toBe(51);
      expect(wireSize, `wire response must stay under ${WIRE_BUDGET_CHARS} chars`).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);
    } finally {
      stub.close();
    }
  }, 30_000);

  test("few items, each too large: diet falls back to wrapper with non-empty body_excerpt", async () => {
    // 200 × 1000-char names → even after Pass 1 string-truncate + Pass 2
    // array-cap, the JSON still overshoots budget, so dietIfOversize
    // falls back to its wrapper shape. The body_excerpt must NOT be the
    // empty-string safety-net branch — that branch represents total data
    // loss for the agent.
    const port = nextPort();
    const stub = await startStub(port, () => fewLargeItemsBody(200, 1000));
    try {
      const { rpc, wireSize } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: {},
        path: "data.list[]",
        extract: "name",
      });

      const result = rpc.result as { structuredContent?: Record<string, unknown> };
      const structured = result?.structuredContent ?? {};
      expect(structured.truncated, "wrapper must mark truncated:true on diet fallback").toBe(true);
      expect(typeof structured.reason, "wrapper must include a reason string").toBe("string");
      expect(typeof structured.body_excerpt, "body_excerpt must be a string on fallback").toBe("string");
      expect(
        (structured.body_excerpt as string).length,
        "body_excerpt must NOT be the empty-string safety-net branch — agent loses everything otherwise",
      ).toBeGreaterThan(0);
      expect(wireSize, `wire response must stay under ${WIRE_BUDGET_CHARS} chars`).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);
    } finally {
      stub.close();
    }
  }, 30_000);
});
