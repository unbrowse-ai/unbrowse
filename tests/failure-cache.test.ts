/**
 * failure-cache.test — the negative-resolution-layer witness: failures classify by class,
 * cool down by class-TTL (structural slow, transient fast), key by egress (a proxy change
 * re-probes), and are a HINT that expires (never a permanent blacklist).
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFailure, recordFailure, recordOutcome, peekFailure, FAILURE_TTL_MS,
} from "../src/values/failure-cache.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "failcache-")); });

describe("classifyFailure", () => {
  it("maps NO_AVAILABLE_KEYS body → structural (even with a 503 status)", () => {
    expect(classifyFailure({ status: 503, body: '{"error":"No available keys","code":"NO_AVAILABLE_KEYS"}' })).toBe("structural");
  });
  it("404 / 410 → structural", () => {
    expect(classifyFailure({ status: 404 })).toBe("structural");
    expect(classifyFailure({ status: 410 })).toBe("structural");
  });
  it("403 / DataDome / captcha → antibot", () => {
    expect(classifyFailure({ status: 403 })).toBe("antibot");
    expect(classifyFailure({ status: 200, body: "datadome challenge" })).toBe("antibot");
    expect(classifyFailure({ body: "Just a moment ..." })).toBe("antibot");
  });
  it("503 / 429 / timeout → transient", () => {
    expect(classifyFailure({ status: 503 })).toBe("transient");
    expect(classifyFailure({ status: 429 })).toBe("transient");
    expect(classifyFailure({ errorCode: "cli_timeout" })).toBe("transient");
  });
  it("2xx → null (not a failure)", () => {
    expect(classifyFailure({ status: 200, body: "real data" })).toBeNull();
  });
});

describe("peekFailure cooldown by class", () => {
  it("structural suppresses within 24h, re-probes after", () => {
    const t0 = 1_000_000;
    recordFailure("https://proxykingdom.cn2.ai", "structural", "proxy", dir, t0);
    expect(peekFailure("https://proxykingdom.cn2.ai", "proxy", dir, t0 + 60_000)).toBe("structural");
    expect(peekFailure("https://proxykingdom.cn2.ai", "proxy", dir, t0 + FAILURE_TTL_MS.structural + 1)).toBeNull();
  });
  it("transient expires fast (10min)", () => {
    const t0 = 2_000_000;
    recordFailure("https://x.com/y", "transient", "direct", dir, t0);
    expect(peekFailure("https://x.com/y", "direct", dir, t0 + 5 * 60_000)).toBe("transient");
    expect(peekFailure("https://x.com/y", "direct", dir, t0 + 11 * 60_000)).toBeNull();
  });
});

describe("egress keying + hint semantics", () => {
  it("a different egress re-probes (not inherited)", () => {
    const t0 = 3_000_000;
    recordFailure("https://zillow.com/", "antibot", "iproyal", dir, t0);
    expect(peekFailure("https://zillow.com/", "iproyal", dir, t0 + 1000)).toBe("antibot");
    expect(peekFailure("https://zillow.com/", "proxykingdom", dir, t0 + 1000)).toBeNull(); // fresh egress → re-probe
  });
  it("path digits templatize (per-item URLs collapse to one route key)", () => {
    const t0 = 4_000_000;
    recordFailure("https://site.com/jobs/12345", "antibot", "direct", dir, t0);
    expect(peekFailure("https://site.com/jobs/99999", "direct", dir, t0 + 1000)).toBe("antibot");
  });
  it("recordOutcome only records real failures, returns the class", () => {
    const t0 = 5_000_000;
    expect(recordOutcome("https://ok.com/", { status: 200, body: "data" }, "direct", dir, t0)).toBeNull();
    expect(peekFailure("https://ok.com/", "direct", dir, t0 + 1000)).toBeNull();
    expect(recordOutcome("https://blocked.com/", { status: 403 }, "direct", dir, t0)).toBe("antibot");
    expect(peekFailure("https://blocked.com/", "direct", dir, t0 + 1000)).toBe("antibot");
  });
});
