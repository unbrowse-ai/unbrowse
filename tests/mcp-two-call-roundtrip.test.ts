import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Day 6 Dominion — end-to-end integration: the two-call round-trip.
//
//  — dominion across the whole surface. The AC3 `suggested_limit`
// + `next_step` fields are only valuable if an agent that reads them can
// successfully re-call and get clean data. This test exercises that loop:
//
//   call 1:  unbrowse_execute(limit=200) → wrapper {truncated:true, suggested_limit:N, next_step:"...limit=N..."}
//   call 2:  unbrowse_execute(limit=N)   → clean Array of projected rows + tail sentinel
//
// If call 2 fails the hint is mere prose. Day 6 demands the hint be a path.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MCP_ENTRY = path.join(REPO, "src", "mcp.ts");
const WIRE_BUDGET_CHARS = 25_000;

function bigRows(n: number, nameLen: number) {
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
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/skills/") && req.url.endsWith("/execute")) {
        res.end(JSON.stringify(executeBody()));
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

async function spawnAndCallTwice(
  port: number,
  args1: Record<string, unknown>,
  buildArgs2: (rpc1: Rpc) => Record<string, unknown>,
): Promise<{ rpc1: Rpc; rpc2: Rpc }> {
  const env = {
    ...process.env,
    UNBROWSE_URL: `http://127.0.0.1:${port}`,
    UNBROWSE_API_URL: `http://127.0.0.1:${port}`,
    UNBROWSE_MCP_HTTP_BACKEND: "1",
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
      clientInfo: { name: "roundtrip", version: "0" },
    });
    await waitFor(1);

    send(2, "tools/call", { name: "unbrowse_execute", arguments: args1 });
    const rpc1 = await waitFor(2);

    const args2 = buildArgs2(rpc1);

    send(3, "tools/call", { name: "unbrowse_execute", arguments: args2 });
    const rpc2 = await waitFor(3);

    return { rpc1, rpc2 };
  } finally {
    proc.kill();
  }
}

describe("two-call round-trip — agent reads suggested_limit, re-calls, gets clean data", () => {
  test("call 1 overshoots → wrapper with hint; call 2 with suggested_limit returns clean Array", async () => {
    const port = 18301 + Math.floor(Math.random() * 200);
    const stub = await startStub(port, () => bigRows(200, 1000));
    try {
      const { rpc1, rpc2 } = await spawnAndCallTwice(
        port,
        {
          skill: "stub-skill",
          endpoint: "stub-endpoint",
          params: {},
          path: "data.list[]",
          extract: "name",
          limit: 200,
        },
        (rpc) => {
          const structured = (rpc.result as { structuredContent?: Record<string, unknown> })?.structuredContent ?? {};
          if (typeof structured.suggested_limit !== "number") {
            throw new Error(
              `call 1 did not surface suggested_limit; got: ${JSON.stringify(structured).slice(0, 200)}`,
            );
          }
          return {
            skill: "stub-skill",
            endpoint: "stub-endpoint",
            params: {},
            path: "data.list[]",
            extract: "name",
            limit: structured.suggested_limit,
          };
        },
      );

      // Call 1 — agent received the actionable hint
      const s1 = (rpc1.result as { structuredContent?: Record<string, unknown> })?.structuredContent ?? {};
      expect(s1.truncated, "call 1: must hit the wrapper").toBe(true);
      expect(typeof s1.suggested_limit, "call 1: suggested_limit must be a number").toBe("number");
      expect(typeof s1.next_step, "call 1: next_step must be a string").toBe("string");
      const suggested = s1.suggested_limit as number;
      expect(suggested, "call 1: suggested_limit must be < caller's 200").toBeLessThan(200);

      // Call 2 — agent's follow-up succeeded: clean Array, no wrapper
      const s2 = (rpc2.result as { structuredContent?: Record<string, unknown> })?.structuredContent ?? {};
      const inner2 = (s2 as { result?: unknown }).result;
      expect(
        s2.truncated,
        "call 2 (with suggested_limit): must NOT trigger the wrapper",
      ).not.toBe(true);
      expect(
        Array.isArray(inner2),
        "call 2: agent must receive an Array of projected rows",
      ).toBe(true);

      // Wire-budget assertion is on structuredContent (what dietIfOversize
      // gates), not full JSON-RPC envelope — the latter doubles the payload
      // across content[0].text (preview channel) and structuredContent.
      const sc1Size = JSON.stringify(s1).length;
      const sc2Size = JSON.stringify(s2).length;
      expect(sc1Size, `call 1 structuredContent under ${WIRE_BUDGET_CHARS}`).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);
      expect(sc2Size, `call 2 structuredContent under ${WIRE_BUDGET_CHARS}`).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);

      // Real data in call 2 — first non-sentinel row has the extracted key
      const arr2 = inner2 as Array<Record<string, unknown>>;
      const firstNonSentinel = arr2.find(
        (row) => !(typeof row === "object" && row !== null && "truncated" in row && "unit" in row),
      );
      expect(firstNonSentinel, "call 2: at least one real row must be present").toBeTruthy();
      expect(
        typeof (firstNonSentinel as Record<string, unknown>).name,
        "call 2: extracted 'name' key must reach the wire",
      ).toBe("string");
    } finally {
      stub.close();
    }
  }, 60_000);
});
