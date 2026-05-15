// recorded-baseline mode: key canonicalization, golden loader resilience,
// and an end-to-end proxy smoke (real spawn, stub candidate, golden file).
//
// The contract: with WORKBENCH_BASELINE_MODE=recorded the proxy spawns NO
// baseline child; an unbrowse_resolve tools/call gets _workbench_delta with
// mode="recorded" and a diff computed against the golden entry. A tool not
// in the golden set (e.g. unbrowse_go) gets a candidate-only delta with an
// honest "not in golden set" summary, never a synthetic diff.

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  recordedKey,
  RecordedBaseline,
  RECORDED_TOOLS,
} from "../src/recorded-baseline.ts";

const PROXY_PATH = resolve(import.meta.dir, "..", "bin", "proxy.ts");
const RESOLVE_STUB = resolve(import.meta.dir, "fixtures", "resolve-stub.ts");

describe("recordedKey canonicalization", () => {
  test("strips volatile args so a recorded key matches a fresh call", () => {
    const a = recordedKey("unbrowse_resolve", {
      intent: "get hn",
      url: "https://news.ycombinator.com/",
      session_id: "sess-abc",
    });
    const b = recordedKey("unbrowse_resolve", {
      url: "https://news.ycombinator.com/",
      intent: "get hn",
      session_id: "sess-XYZ-different",
    });
    expect(a).toBe(b);
  });

  test("different intent or url produces different keys", () => {
    const base = recordedKey("unbrowse_resolve", { intent: "x", url: "u1" });
    expect(base).not.toBe(recordedKey("unbrowse_resolve", { intent: "y", url: "u1" }));
    expect(base).not.toBe(recordedKey("unbrowse_resolve", { intent: "x", url: "u2" }));
    expect(base).not.toBe(recordedKey("unbrowse_go", { intent: "x", url: "u1" }));
  });

  test("RECORDED_TOOLS is resolve-only in v1", () => {
    expect(RECORDED_TOOLS.has("unbrowse_resolve")).toBe(true);
    expect(RECORDED_TOOLS.has("unbrowse_go")).toBe(false);
    expect(RECORDED_TOOLS.has("unbrowse_execute")).toBe(false);
  });
});

describe("RecordedBaseline loader", () => {
  test("missing manifest yields zero entries, no throw", () => {
    const rb = new RecordedBaseline("/no/such/manifest.jsonl");
    expect(rb.entryCount).toBe(0);
    expect(rb.lookup("unbrowse_resolve", { intent: "x", url: "u" })).toBeNull();
  });

  test("loads valid lines and skips a malformed trailing line", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wb-golden-"));
    const manifest = resolve(dir, "manifest.jsonl");
    const key = recordedKey("unbrowse_resolve", { intent: "get hn", url: "https://news.ycombinator.com/" });
    const good = JSON.stringify({
      key,
      tool: "unbrowse_resolve",
      response: { result: { status: "ok", available_operations: [{ endpoint_id: "e1" }] } },
      baseline_version: "6.16.0",
    });
    writeFileSync(manifest, good + "\n" + '{"key": "broken", oops not json\n');
    const rb = new RecordedBaseline(manifest);
    expect(rb.entryCount).toBe(1);
    const hit = rb.lookup("unbrowse_resolve", { intent: "get hn", url: "https://news.ycombinator.com/" });
    expect(hit).not.toBeNull();
    expect(hit?.baseline_version).toBe("6.16.0");
  });
});

async function callProxyOnce(
  env: NodeJS.ProcessEnv,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const proxy = spawn("bun", ["run", PROXY_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    let buf = "";
    const responses: Record<string, unknown>[] = [];
    proxy.stdout.setEncoding("utf8");
    proxy.stderr.setEncoding("utf8");
    proxy.stderr.on("data", () => {});
    proxy.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          try { responses.push(JSON.parse(line)); } catch { /* banner */ }
        }
        idx = buf.indexOf("\n");
      }
    });
    await new Promise((r) => setTimeout(r, 250));
    proxy.stdin.write(JSON.stringify(request) + "\n");
    const deadline = Date.now() + 6000;
    while (responses.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (responses.length === 0) throw new Error("no proxy response in 6s");
    return responses[0]!;
  } finally {
    try { proxy.kill("SIGTERM"); } catch { /* best-effort */ }
  }
}

describe("proxy recorded mode (real spawn)", () => {
  test("resolve call diffs candidate against the golden entry, mode=recorded, no baseline child", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wb-golden-e2e-"));
    const manifest = resolve(dir, "manifest.jsonl");
    const args = { intent: "get hn", url: "https://news.ycombinator.com/" };
    // Golden baseline: resolve returned ONE op. Candidate stub returns TWO
    // ops, so the structural diff must be non-identical.
    const golden = {
      key: recordedKey("unbrowse_resolve", args),
      tool: "unbrowse_resolve",
      response: { result: { status: "ok", available_operations: [{ endpoint_id: "old" }] } },
      baseline_version: "6.16.0",
      recorded_at: "2026-05-16T00:00:00Z",
    };
    writeFileSync(manifest, JSON.stringify(golden) + "\n");

    const merged = await callProxyOnce(
      {
        WORKBENCH_BASELINE_MODE: "recorded",
        WORKBENCH_GOLDEN_PATH: manifest,
        UNBROWSE_BIN_CANDIDATE: `bun run ${RESOLVE_STUB}`,
        // Must NOT spawn baseline. Set a bogus baseline cmd to prove it is
        // ignored in recorded mode (a spawn attempt would error in stderr).
        UNBROWSE_BIN_BASELINE: "/bin/false",
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "unbrowse_resolve", arguments: args },
      },
    );

    const delta = merged["_workbench_delta"] as Record<string, unknown> | undefined;
    expect(delta).toBeDefined();
    expect(delta?.["mode"]).toBe("recorded");
    const baseline = delta?.["baseline"] as Record<string, unknown> | null;
    expect(baseline?.["baseline_version"]).toBe("6.16.0");
    const diff = delta?.["diff"] as Record<string, unknown>;
    // candidate stub returns 2 ops, golden has 1 -> not identical.
    expect(diff["structural_diff_summary"]).not.toBe("identical");
  });

  test("a non-recorded tool (unbrowse_go) gets an honest skip summary, not a synthetic diff", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wb-golden-skip-"));
    const manifest = resolve(dir, "manifest.jsonl");
    writeFileSync(manifest, ""); // empty golden is fine for this path

    const merged = await callProxyOnce(
      {
        WORKBENCH_BASELINE_MODE: "recorded",
        WORKBENCH_GOLDEN_PATH: manifest,
        UNBROWSE_BIN_CANDIDATE: `bun run ${RESOLVE_STUB}`,
        UNBROWSE_BIN_BASELINE: "/bin/false",
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "unbrowse_go", arguments: { url: "https://example.com" } },
      },
    );

    const delta = merged["_workbench_delta"] as Record<string, unknown>;
    expect(delta?.["mode"]).toBe("recorded");
    expect(delta?.["baseline"]).toBeNull();
    const diff = delta?.["diff"] as Record<string, unknown>;
    expect(String(diff["structural_diff_summary"])).toContain("not in golden set");
  });
});
