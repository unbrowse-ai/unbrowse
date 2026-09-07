import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Day 4 Luminaries — promote the .harness-out probe to a real test.
// Regression-pins the eatigo-shape scenario from docs/mcp-issues-2026-05-13.md:
// the 297-row × 4-field-extract case that Lewis hit on 2026-05-13.
// Under the parent fix (commit 421c5387) projection produces an Array of
// 50 projected rows + a {truncated:N,unit:"items"} tail sentinel —
// NOT a body_excerpt wrap. This test exists so a future regression
// (silently re-introducing the body_excerpt wrap on a moderate-size
// list) surfaces here, not in an agent transcript.
//
// See also: .harness-out/projection-bench.mjs (gitignored local dev tool)
// for a 5-scenario swarm probe maintained by /unbrowse-local-verify-loop.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MCP_ENTRY = path.join(REPO, "src", "mcp.ts");
const WIRE_BUDGET_CHARS = 25_000;

function eatigoShape(n: number) {
  return {
    trace: { trace_id: "stub", success: true, status_code: 200 },
    result: {
      code: 0,
      message: "OK",
      data: {
        total_count: n,
        list: Array.from({ length: n }, (_, i) => ({
          bid: 3373799975297 + i,
          name: `Restaurant ${i} @ Singapore Marriott Tang Plaza Hotel`,
          cover_image: `/imgs/branch/cover/restaurant_${i}_long_image_path.png`,
          category_id: 0,
          ratings: "4.3",
          lat: 1.2840 + i * 0.0001,
          lng: 103.8438 + i * 0.0001,
          area: "Singapore",
          distance: "",
          reservations: `${10 + i}.${i % 10}k`,
          avg_price_range: 3,
          is_hot: i % 3 === 0,
        })),
      },
    },
  };
}

type Rpc = { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown };

async function startStub(port: number) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/skills/") && req.url.endsWith("/execute")) {
        res.end(JSON.stringify(eatigoShape(297)));
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

async function callMcp(port: number, args: Record<string, unknown>): Promise<{ rpc: Rpc; wireSize: number }> {
  const env = {
    ...process.env,
    UNBROWSE_URL: `http://127.0.0.1:${port}`,
    UNBROWSE_API_URL: `http://127.0.0.1:${port}`,
    UNBROWSE_NO_AUTO_START: "1",
    UNBROWSE_TEST_FAIL_FAST: "0",
  };
  const proc = spawn("bun", [MCP_ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const responses: Rpc[] = [];
  proc.stdout.on("data", (c) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { responses.push(JSON.parse(line)); } catch { /* skip */ }
    }
  });
  proc.stderr.on("data", () => {});

  function send(id: number, method: string, params: unknown) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }
  function waitFor(id: number, timeoutMs = 15_000): Promise<Rpc> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const r = responses.find((r) => r.id === id);
        if (r) return resolve(r);
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout id ${id}`));
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
      clientInfo: { name: "eatigo-shape", version: "0" },
    });
    await waitFor(1);
    send(2, "tools/call", { name: "unbrowse_execute", arguments: args });
    const rpc = await waitFor(2);
    return { rpc, wireSize: JSON.stringify(rpc).length };
  } finally {
    proc.kill();
  }
}

describe("unbrowse_execute eatigo-shape regression (doc reproducer 2026-05-13)", () => {
  function nextPort() {
    return 17800 + Math.floor(Math.random() * 200);
  }

  test("297 rows × 4-field extract — agent receives Array, not body_excerpt wrap", async () => {
    const port = nextPort();
    const stub = await startStub(port);
    try {
      const { rpc, wireSize } = await callMcp(port, {
        skill: "stub-eatigo",
        endpoint: "stub-restaurants",
        params: { filter_regionid: 27, size: 297, start: 0, sortby: "popular" },
        path: "data.list[]",
        extract: "name,area,lat,lng",
        limit: 297,
      });

      const result = rpc.result as { structuredContent?: Record<string, unknown> };
      const structured = result?.structuredContent ?? {};
      const inner = (structured as { result?: unknown }).result;

      expect(
        Array.isArray(inner),
        "doc reproducer: agent must get an Array of projected rows, NOT a body_excerpt wrap",
      ).toBe(true);
      expect(
        (structured as { truncated?: unknown }).truncated,
        "no top-level truncated flag — wrap path must not fire on the projected array",
      ).not.toBe(true);
      const arr = inner as Array<Record<string, unknown>>;
      expect(arr.length, "capOversizeArrays caps to 50 items + 1 sentinel = 51").toBe(51);

      const tail = arr[arr.length - 1] as Record<string, unknown>;
      expect(tail, "tail must be the existing {truncated:N,unit:'items'} sentinel").toEqual({
        truncated: 247,
        unit: "items",
      });

      const firstRow = arr[0] as Record<string, unknown>;
      expect(Object.keys(firstRow).sort(), "extract keys reached the wire").toEqual([
        "area",
        "lat",
        "lng",
        "name",
      ]);

      expect(
        wireSize,
        `wire response must stay under ${WIRE_BUDGET_CHARS} chars`,
      ).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);
    } finally {
      stub.close();
    }
  }, 30_000);
});
