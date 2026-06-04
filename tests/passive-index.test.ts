import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Filesystem isolation — each test gets its own ~/.unbrowse/config.json.
let dir: string;
let cfgPath: string;

async function clearCache() {
  const mod = await import("../src/config/contribution.js");
  mod._clearContributionCacheForTests();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "passive-index-"));
  cfgPath = join(dir, "config.json");
  process.env.UNBROWSE_CONFIG_PATH = cfgPath;
  await clearCache();
});

afterEach(async () => {
  delete process.env.UNBROWSE_CONFIG_PATH;
  await clearCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("passive_index setting (opt-out, default ON)", () => {
  it("defaults to true on a fresh install (no config file)", async () => {
    const { getContributionConfig } = await import("../src/config/contribution.js");
    expect(getContributionConfig().contribution.passive_index).toBe(true);
  });

  it("isPassiveIndexEnabled() is true by default", async () => {
    const { isPassiveIndexEnabled } = await import("../src/capture/passive-index.js");
    expect(isPassiveIndexEnabled()).toBe(true);
  });

  it("opt-out: setting passive_index=false persists and flips the switch", async () => {
    const { getContributionConfig, setContributionConfig } = await import("../src/config/contribution.js");
    setContributionConfig({ contribution: { passive_index: false } });
    expect(getContributionConfig().contribution.passive_index).toBe(false);
    const { isPassiveIndexEnabled } = await import("../src/capture/passive-index.js");
    expect(isPassiveIndexEnabled()).toBe(false);
  });

  it("round-trips through disk (false written → read back false)", async () => {
    writeFileSync(cfgPath, JSON.stringify({ contribution: { passive_index: false } }));
    await clearCache();
    const { getContributionConfig } = await import("../src/config/contribution.js");
    expect(getContributionConfig().contribution.passive_index).toBe(false);
  });

  it("an existing config without the field defaults to ON (migration-safe)", async () => {
    writeFileSync(cfgPath, JSON.stringify({ contribution: { share_pointers: true, auto_review: true } }));
    await clearCache();
    const { getContributionConfig } = await import("../src/config/contribution.js");
    expect(getContributionConfig().contribution.passive_index).toBe(true);
  });
});

describe("deferCapturePipeline — non-blocking background work", () => {
  it("returns immediately; work completes only after drain", async () => {
    const mod = await import("../src/capture/passive-index.js");
    let done = false;
    mod.deferCapturePipeline("test-work", async () => {
      await new Promise((r) => setTimeout(r, 25));
      done = true;
    });
    // Synchronous return: the work has NOT run yet (this is the "faster browse").
    expect(done).toBe(false);
    expect(mod.pendingCaptureWorkCount()).toBe(1);
    // Graceful drain awaits the in-flight pipeline.
    await mod.drainDeferredCaptureWork();
    expect(done).toBe(true);
    expect(mod.pendingCaptureWorkCount()).toBe(0);
  });

  it("a throwing pipeline never rejects the caller and still drains", async () => {
    const mod = await import("../src/capture/passive-index.js");
    let ran = false;
    // Must not throw synchronously or reject — a failed index can't crash a browse turn.
    expect(() =>
      mod.deferCapturePipeline("boom", async () => {
        ran = true;
        throw new Error("index blew up");
      }),
    ).not.toThrow();
    await mod.drainDeferredCaptureWork();
    expect(ran).toBe(true);
    expect(mod.pendingCaptureWorkCount()).toBe(0);
  });
});
