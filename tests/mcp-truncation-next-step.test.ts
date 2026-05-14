import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Day 4 Luminaries — AC3 signal (the lost sheep from docs/mcp-issues-2026-05-13.md).
//
// When projection params are supplied AND the projected result still overshoots
// WIRE_BUDGET_CHARS even after pass-2 array-cap, dietIfOversize falls back to its
// wrapper shape {truncated, reason, body_excerpt}. The existing test
// (mcp-projection-stdio.test.ts:260-290) pins that body_excerpt is non-empty.
//
// Today the wrapper has NO actionable hint: the agent loses the array entirely
// and gets a 24KB string blob. The doc's Suggested Fix #3 calls for adding
// `next_step` + `suggested_limit` fields so the agent can re-call with a
// smaller limit instead of going to the CLI.
//
// This test FAILS against current source. Day 4's implementation step makes
// it pass. Other tests must continue to pass (back-compat).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MCP_ENTRY = path.join(REPO, "src", "mcp.ts");
const WIRE_BUDGET_CHARS = 25_000;

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
      clientInfo: { name: "next-step-test", version: "0" },
    });
    await waitFor(1);
    send(2, "tools/call", { name: "unbrowse_execute", arguments: args });
    const rpc = await waitFor(2);
    return { rpc, wireSize: JSON.stringify(rpc).length };
  } finally {
    proc.kill();
  }
}

describe("AC3 — body_excerpt wrapper surfaces actionable next_step when projection supplied", () => {
  function nextPort() {
    return 18100 + Math.floor(Math.random() * 200);
  }

  // ─── Day 5 Creatures: edges + adversarial swarm around the AC3 lamp ──────
  test("projection-supplied + diet-fallback case adds suggested_limit + next_step", async () => {
    // 200 × 1000-char names — pathological: even after pass-2 cap (50 items
    // × ~1000 chars per name = ~50KB) overshoots the 25KB budget, so diet
    // falls back to the wrapper. With projection supplied, the wrapper
    // must now carry actionable recovery hints.
    const port = nextPort();
    const stub = await startStub(port, () => fewLargeItemsBody(200, 1000));
    try {
      const { rpc, wireSize } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: {},
        path: "data.list[]",
        extract: "name",
        limit: 200,
      });

      const result = rpc.result as { structuredContent?: Record<string, unknown> };
      const structured = result?.structuredContent ?? {};

      // Existing contract preserved (back-compat with mcp-projection-stdio.test.ts:260-290)
      expect(structured.truncated, "back-compat: wrapper still marks truncated:true").toBe(true);
      expect(typeof structured.reason, "back-compat: wrapper still has reason string").toBe("string");
      expect(typeof structured.body_excerpt, "back-compat: body_excerpt still a string").toBe("string");
      expect(
        (structured.body_excerpt as string).length,
        "back-compat: body_excerpt still non-empty",
      ).toBeGreaterThan(0);

      // AC3 new contract — actionable recovery hints
      expect(
        typeof structured.suggested_limit,
        "AC3: wrapper must include suggested_limit (number) when projection supplied",
      ).toBe("number");
      expect(
        structured.suggested_limit as number,
        "AC3: suggested_limit must be a positive integer < caller's limit (200)",
      ).toBeGreaterThan(0);
      expect(
        structured.suggested_limit as number,
        "AC3: suggested_limit must be strictly less than caller-supplied limit",
      ).toBeLessThan(200);

      expect(
        typeof structured.next_step,
        "AC3: wrapper must include next_step (string)",
      ).toBe("string");
      expect(
        (structured.next_step as string).toLowerCase(),
        "AC3: next_step must mention 'limit' so agent knows how to recover",
      ).toContain("limit");

      expect(
        wireSize,
        `wire response must stay under ${WIRE_BUDGET_CHARS} chars even with new fields`,
      ).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);
    } finally {
      stub.close();
    }
  }, 30_000);


  test("EDGE: caller limit=0 — projection branch returns empty Array, no wrapper", async () => {
    const port = nextPort();
    const stub = await startStub(port, () => fewLargeItemsBody(200, 1000));
    try {
      const { rpc } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: {},
        path: "data.list[]",
        extract: "name",
        limit: 0,
      });

      const result = rpc.result as { structuredContent?: Record<string, unknown> };
      const structured = result?.structuredContent ?? {};
      const inner = (structured as { result?: unknown }).result;

      expect(
        Array.isArray(inner),
        "limit=0 must return an empty Array, not a wrapper",
      ).toBe(true);
      expect(
        (inner as unknown[]).length,
        "limit=0 array must be empty",
      ).toBe(0);
      expect(
        (structured as { truncated?: unknown }).truncated,
        "limit=0 must not trigger truncation wrapper",
      ).not.toBe(true);
    } finally {
      stub.close();
    }
  }, 30_000);

  test("EDGE: only path supplied (no extract, no limit) — projection-aware hints still fire", async () => {
    // projection branch is gated by ANY of path/extract/limit. With only `path`,
    // hints.has_projection should be true and caller_limit undefined, so
    // suggested_limit falls back to ARRAY_MAX_ELEMENTS-based heuristic.
    const port = nextPort();
    const stub = await startStub(port, () => fewLargeItemsBody(200, 1000));
    try {
      const { rpc } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: {},
        path: "data.list[]",
      });

      const result = rpc.result as { structuredContent?: Record<string, unknown> };
      const structured = result?.structuredContent ?? {};

      if (structured.truncated === true) {
        expect(
          typeof structured.suggested_limit,
          "even without limit, projection-supplied path must surface suggested_limit",
        ).toBe("number");
        expect(
          structured.suggested_limit as number,
          "suggested_limit must be positive",
        ).toBeGreaterThan(0);
        expect(
          typeof structured.next_step,
          "even without limit, projection-supplied path must surface next_step",
        ).toBe("string");
      }
    } finally {
      stub.close();
    }
  }, 30_000);

  test("ADVERSARIAL: very small caller limit (1) — suggested_limit must stay >=1, never 0", async () => {
    // Pathological: caller asks for 1 row, response is so large that
    // even 1 row blows budget. suggested = max(1, floor(1 * ratio * 0.8)).
    // Must never collapse to 0 — that would be useless advice.
    const port = nextPort();
    const stub = await startStub(port, () => fewLargeItemsBody(200, 1000));
    try {
      const { rpc } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: {},
        path: "data.list[]",
        extract: "name",
        limit: 1,
      });

      const result = rpc.result as { structuredContent?: Record<string, unknown> };
      const structured = result?.structuredContent ?? {};

      if (structured.truncated === true) {
        expect(
          structured.suggested_limit as number,
          "suggested_limit floor must be 1 — never 0",
        ).toBeGreaterThanOrEqual(1);
      }
    } finally {
      stub.close();
    }
  }, 30_000);

  test("ADVERSARIAL: massively oversized response — suggested_limit must compute, not throw", async () => {
    // 1000 × 5000-char names = ~5MB. Forces the diet to do its math
    // against a huge initial.length. ratio approaches 0; suggested
    // calculation must not produce NaN, Infinity, or negative.
    const port = nextPort();
    const stub = await startStub(port, () => fewLargeItemsBody(1000, 5000));
    try {
      const { rpc, wireSize } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: {},
        path: "data.list[]",
        extract: "name",
        limit: 10000,
      });

      const result = rpc.result as { structuredContent?: Record<string, unknown> };
      const structured = result?.structuredContent ?? {};

      // Either projection produced a sane Array+sentinel, OR the wrapper has
      // sane projection-aware hints. Either way, no NaN/Infinity/<=0 in the
      // suggested_limit on the wrapper path.
      if (structured.truncated === true) {
        const s = structured.suggested_limit as number;
        expect(Number.isFinite(s), "suggested_limit must be finite").toBe(true);
        expect(s, "suggested_limit must be a positive integer").toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(s), "suggested_limit must be an integer").toBe(true);
      }
      expect(wireSize, `wire still under ${WIRE_BUDGET_CHARS}`).toBeLessThanOrEqual(WIRE_BUDGET_CHARS);
    } finally {
      stub.close();
    }
  }, 30_000);

  test("no-projection diet-fallback case does NOT add next_step (out-of-scope)", async () => {
    // When caller did NOT supply path/extract/limit, the diet fallback is
    // the generic safety net and should keep its existing shape — no
    // projection-aware hints. This pins NON-GOAL #3 from the plan
    // (resolve / generic responses untouched).
    const port = nextPort();
    const stub = await startStub(port, () => fewLargeItemsBody(200, 1000));
    try {
      const { rpc } = await callMcp(port, {
        skill: "stub-skill",
        endpoint: "stub-endpoint",
        params: {},
      });

      const result = rpc.result as { structuredContent?: Record<string, unknown> };
      const structured = result?.structuredContent ?? {};

      // Wrapper may or may not fire here depending on raw body shape — what we
      // pin is: IF it fires, no projection-aware hints are present.
      if (structured.truncated === true && typeof structured.body_excerpt === "string") {
        expect(
          structured.suggested_limit,
          "no-projection branch must NOT inject suggested_limit",
        ).toBeUndefined();
        expect(
          structured.next_step,
          "no-projection branch must NOT inject next_step",
        ).toBeUndefined();
      }
    } finally {
      stub.close();
    }
  }, 30_000);
});
