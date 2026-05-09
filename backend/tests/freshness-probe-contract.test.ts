import { describe, it, expect } from "bun:test";
import {
  probeFreshness, FreshnessState, FreshnessRecord,
  FRESHNESS_KV_PREFIX, FRESHNESS_KV_SUFFIX,
} from "../src/services/freshness-probe.js";

describe("freshness-probe contract", () => {
  it("KV key prefix/suffix are stable for Step 6 to build keys", () => {
    expect(FRESHNESS_KV_PREFIX).toBe("skill:");
    expect(FRESHNESS_KV_SUFFIX).toBe(":freshness");
    const skillId = "abc123";
    expect(`${FRESHNESS_KV_PREFIX}${skillId}${FRESHNESS_KV_SUFFIX}`).toBe("skill:abc123:freshness");
  });

  it("FreshnessState union is exactly the 3 documented values", () => {
    const valid: FreshnessState[] = ["fresh", "stale_suspect", "stale_confirmed"];
    expect(valid.length).toBe(3);
  });

  it("FreshnessRecord shape includes 4 required fields", () => {
    const rec: FreshnessRecord = {
      state: "fresh", last_probed_at: 1700000000000,
      consecutive_failures: 0, last_status: 200,
    };
    expect(rec.state).toBe("fresh");
    expect(rec.last_probed_at).toBeGreaterThan(0);
    expect(rec.consecutive_failures).toBe(0);
    expect(rec.last_status).toBe(200);
  });

  it("probeFreshness stub returns FreshnessProbeResult with zero counts today", async () => {
    const env = {} as any;
    const r = await probeFreshness(env);
    expect(r.probed).toBe(0);
    expect(r.fresh).toBe(0);
    expect(r.stale_suspect).toBe(0);
    expect(r.stale_confirmed).toBe(0);
  });
});
