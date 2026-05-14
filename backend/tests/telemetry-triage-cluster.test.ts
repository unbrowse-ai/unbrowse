import { describe, expect, test } from "bun:test";
import { buildClustersFromRows, type TriageClusterSummary } from "../src/jobs/triage-telemetry.js";

// Pure cluster-building check. Real D1 + real Linear integration are covered
// by the deployed worker; here we pin the clustering algorithm so future
// changes can't silently shift session→cluster grouping.

function makeRow(opts: {
  id: string;
  host: string;
  path: string;
  tools: string[];
  err?: string;
  refl?: string;
  ts?: number;
}) {
  const events: Array<Record<string, unknown>> = [
    { event: "session_start", ts: new Date(opts.ts ?? Date.now()).toISOString() },
  ];
  for (let i = 0; i < opts.tools.length; i++) {
    const tool = opts.tools[i];
    events.push({
      event: "tool_start",
      ts: new Date(Date.now() + i).toISOString(),
      call_id: `c${i}`,
      tool,
      args_fingerprint: { url: { host: opts.host, path_template: opts.path } },
    });
    events.push({
      event: "tool_end",
      ts: new Date(Date.now() + i + 1).toISOString(),
      call_id: `c${i}`,
      tool,
      duration_ms: 100,
      success: !opts.err,
      ...(opts.err && i === opts.tools.length - 1 ? { error_code: opts.err } : {}),
    });
  }
  return {
    session_id: opts.id,
    events_json: JSON.stringify(events),
    reflection_status: opts.refl ?? "missing",
    received_at: opts.ts ?? Date.now(),
  };
}

describe("triage-telemetry buildClustersFromRows", () => {
  test("groups identical (host, sequence, error, reflection) into one cluster", async () => {
    const rows = [
      makeRow({ id: "s1", host: "x.com", path: "/search", tools: ["unbrowse_resolve", "unbrowse_execute"], err: "auth_required", refl: "failed" }),
      makeRow({ id: "s2", host: "x.com", path: "/search", tools: ["unbrowse_resolve", "unbrowse_execute"], err: "auth_required", refl: "failed" }),
      makeRow({ id: "s3", host: "x.com", path: "/search", tools: ["unbrowse_resolve", "unbrowse_execute"], err: "auth_required", refl: "failed" }),
    ];
    const clusters = await buildClustersFromRows(rows);
    expect(clusters.length).toBe(1);
    expect(clusters[0].session_count).toBe(3);
    expect(clusters[0].representative_sessions).toEqual(["s1", "s2", "s3"]);
    expect(clusters[0].terminal_error_code).toBe("auth_required");
    expect(clusters[0].reflection_status).toBe("failed");
  });

  test("different hosts → different clusters", async () => {
    const rows = [
      makeRow({ id: "s1", host: "a.com", path: "/x", tools: ["unbrowse_resolve"] }),
      makeRow({ id: "s2", host: "b.com", path: "/x", tools: ["unbrowse_resolve"] }),
    ];
    const clusters = await buildClustersFromRows(rows);
    expect(clusters.length).toBe(2);
  });

  test("different terminal error codes → different clusters", async () => {
    const rows = [
      makeRow({ id: "s1", host: "x.com", path: "/", tools: ["a", "b"], err: "auth_required" }),
      makeRow({ id: "s2", host: "x.com", path: "/", tools: ["a", "b"], err: "rate_limited" }),
    ];
    const clusters = await buildClustersFromRows(rows);
    expect(clusters.length).toBe(2);
  });

  test("representative_sessions caps at 5", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      makeRow({ id: `s${i}`, host: "x.com", path: "/q", tools: ["unbrowse_resolve"], refl: "missing" }),
    );
    const clusters = await buildClustersFromRows(rows);
    expect(clusters[0].session_count).toBe(12);
    expect(clusters[0].representative_sessions.length).toBe(5);
  });

  test("cluster_key is deterministic (rerun → same key)", async () => {
    const row = makeRow({ id: "s1", host: "x.com", path: "/search", tools: ["a", "b"], err: "auth_required", refl: "failed" });
    const a = await buildClustersFromRows([row]);
    const b = await buildClustersFromRows([row]);
    expect(a[0].cluster_key).toBe(b[0].cluster_key);
    expect(a[0].cluster_key.length).toBe(16);
  });

  test("session with no tool_start events is skipped", async () => {
    const row = {
      session_id: "empty",
      events_json: JSON.stringify([{ event: "session_start", ts: new Date().toISOString() }]),
      reflection_status: "missing",
      received_at: Date.now(),
    };
    const clusters = await buildClustersFromRows([row]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].host_template).toBe("<unknown>");
    expect(clusters[0].tool_sequence).toEqual([]);
  });
});

describe("triage-telemetry: hardcoding guards", () => {
  test("no SLOW_THRESHOLD constants in worker source", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "src", "jobs", "triage-telemetry.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/SLOW_THRESHOLD_MS\s*=/);
    expect(src).not.toMatch(/BAD_PATTERN/);
    expect(src).not.toMatch(/BUG_KEYWORD/);
  });

  test("no per-host registry in worker source", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "src", "jobs", "triage-telemetry.ts"),
      "utf8",
    );
    // matches `if (host === "..."` or `host === "x.com"` etc.
    expect(src).not.toMatch(/host\s*===\s*"[a-z]+\./);
  });
});
