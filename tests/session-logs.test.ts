import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentSessionsForDomain } from "../src/session-logs.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("listRecentSessionsForDomain", () => {
  it("returns recent local resolve/execution traces for a domain", () => {
    const tracesDir = mkdtempSync(join(tmpdir(), "unbrowse-sessions-"));
    tempDirs.push(tracesDir);

    writeFileSync(join(tracesDir, "2026-03-08T13-00-00-000Z-resolve-abc123.json"), JSON.stringify({
      intent: "get feed posts",
      context: { url: "https://www.linkedin.com/feed/" },
      skill_id: "skill-1",
      selected_endpoint_id: "endpoint-1",
      outcome: "autoexec_success",
    }));

    writeFileSync(join(tracesDir, "trace-2.json"), JSON.stringify({
      trace_id: "trace-2",
      skill_id: "skill-2",
      endpoint_id: "endpoint-2",
      started_at: "2026-03-08T13:05:00.000Z",
      completed_at: "2026-03-08T13:05:02.000Z",
      success: false,
      error: "timed out on https://www.linkedin.com/feed/",
    }));

    writeFileSync(join(tracesDir, "other.json"), JSON.stringify({
      trace_id: "trace-3",
      started_at: "2026-03-08T13:06:00.000Z",
      success: true,
      result: { url: "https://example.com" },
    }));

    const sessions = listRecentSessionsForDomain(tracesDir, "www.linkedin.com", 10);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.file).toBe("trace-2.json");
    expect(sessions[0]?.success).toBe(false);
    expect(sessions[1]?.kind).toBe("resolve");
    expect(sessions[1]?.url).toBe("https://www.linkedin.com/feed/");
  });
});
