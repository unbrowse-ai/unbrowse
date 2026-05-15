// Day-4 Luminaries: falsifiable signal over Day-3 fanout.ts.
// Real-runtime: spawn two actual `bun -e` child processes as stub upstreams
// that echo JSON-RPC responses. No mocks.

import { describe, test, expect, afterAll } from "bun:test";
import { Fanout } from "../src/fanout.ts";
import { spawnChild, type ChildHandle } from "../src/spawn.ts";

// Stub upstream: reads JSON-RPC requests from stdin, echoes a response with
// the same id and a side-marker field. Real bun child process, real pipes.
const STUB = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx = buf.indexOf("\\n");
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      try {
        const req = JSON.parse(line);
        const resp = {
          jsonrpc: "2.0",
          id: req.id,
          result: { side: process.env.WB_SIDE, method: req.method, payload_size: ${0} },
        };
        process.stdout.write(JSON.stringify(resp) + "\\n");
      } catch (e) {
        process.stderr.write("stub-parse-err " + e.message + "\\n");
      }
    }
    idx = buf.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let cand: ChildHandle | null = null;
let base: ChildHandle | null = null;

afterAll(() => {
  cand?.kill();
  base?.kill();
});

describe("Fanout", () => {
  test("both sides receive the request and the live response carries the live side marker", async () => {
    cand = spawnChild("bun", ["-e", STUB], { WB_SIDE: "candidate" }, "candidate");
    base = spawnChild("bun", ["-e", STUB], { WB_SIDE: "baseline" }, "baseline");
    const fan = new Fanout(cand, base);

    const result = await fan.fanout(
      { jsonrpc: "2.0", id: 42, method: "tools/list", params: {} },
      "candidate",
    );

    expect(result.liveResponse).toBeDefined();
    const live = result.liveResponse as { result?: { side?: string } };
    expect(live.result?.side).toBe("candidate");
    expect(result.candidate.bytes).toBeGreaterThan(0);
    expect(result.baseline.bytes).toBeGreaterThan(0);
    expect(result.candidateResponse).not.toBeNull();
    expect(result.baselineResponse).not.toBeNull();
  });

  test("liveSide=baseline returns the baseline payload", async () => {
    if (!cand || !base) throw new Error("test setup did not run");
    const fan = new Fanout(cand, base);
    const result = await fan.fanout(
      { jsonrpc: "2.0", id: 43, method: "tools/list", params: {} },
      "baseline",
    );
    const live = result.liveResponse as { result?: { side?: string } };
    expect(live.result?.side).toBe("baseline");
  });

  test("concurrent ids do not cross-resolve", async () => {
    if (!cand || !base) throw new Error("test setup did not run");
    const fan = new Fanout(cand, base);
    const promises = [101, 102, 103, 104].map((id) =>
      fan.fanout({ jsonrpc: "2.0", id, method: "tools/list", params: {} }, "candidate"),
    );
    const results = await Promise.all(promises);
    const liveIds = results.map(
      (r) => (r.liveResponse as { id?: number }).id,
    );
    expect(liveIds).toEqual([101, 102, 103, 104]);
  });

  test("fanout requires a request id", async () => {
    if (!cand) throw new Error("test setup did not run");
    const fan = new Fanout(cand, null);
    await expect(
      fan.fanout({ jsonrpc: "2.0", method: "tools/list" } as Record<string, unknown>, "candidate"),
    ).rejects.toThrow("fanout requires a request with an id");
  });

  test("baseline=null returns liveResponse from candidate with empty baseline meta", async () => {
    if (!cand) throw new Error("test setup did not run");
    const fan = new Fanout(cand, null);
    const result = await fan.fanout(
      { jsonrpc: "2.0", id: 200, method: "tools/list", params: {} },
      "candidate",
    );
    const live = result.liveResponse as { result?: { side?: string } };
    expect(live.result?.side).toBe("candidate");
    expect(result.baseline.bytes).toBe(0);
    expect(result.baselineResponse).toBeNull();
  });
});
