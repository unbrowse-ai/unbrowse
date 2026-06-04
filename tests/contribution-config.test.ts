import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Filesystem isolation — every test gets its own ~/.unbrowse via UNBROWSE_CONFIG_PATH.
let workDir: string;
let cfgPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "unbrowse-contrib-"));
  cfgPath = join(workDir, "config.json");
  process.env.UNBROWSE_CONFIG_PATH = cfgPath;
  const mod = await import("../src/config/contribution.js");
  mod._clearContributionCacheForTests();
});

afterEach(async () => {
  delete process.env.UNBROWSE_CONFIG_PATH;
  const mod = await import("../src/config/contribution.js");
  mod._clearContributionCacheForTests();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("contribution config — defaults + read/write", () => {
  it("returns DEFAULT (public, opt-out) on fresh install (no config file)", async () => {
    const { getContributionConfig } = await import("../src/config/contribution.js");
    const cfg = getContributionConfig();
    // Default is opt-out: share_pointers=true. Review-gate is what holds back
    // unreviewed captures from the public marketplace, not this flag.
    expect(cfg.contribution.share_pointers).toBe(true);
    expect(cfg.contribution.set_via).toBe("default");
    expect(cfg.rev_share.opted_in).toBe(false);
    expect(cfg.rev_share.wallet_address).toBeUndefined();
    expect(cfg.notice_shown_count).toBe(0);
    // Brand-new install: no config file should be written by a read-only get.
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("set + read round-trip persists the new value and updates cache", async () => {
    const { getContributionConfig, setContributionConfig } = await import("../src/config/contribution.js");
    setContributionConfig({
      contribution: { share_pointers: true, set_via: "setup-prompt" },
    });
    const cfg = getContributionConfig();
    expect(cfg.contribution.share_pointers).toBe(true);
    expect(cfg.contribution.set_via).toBe("setup-prompt");
    expect(cfg.contribution.set_at).toBeDefined();
    // On disk too
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.contribution.share_pointers).toBe(true);
  });

  it("preserves unrelated keys already present in config.json", async () => {
    writeFileSync(cfgPath, JSON.stringify({ agent_id: "agent-123", api_key: "k_xyz" }));
    const { setContributionConfig, _clearContributionCacheForTests } = await import("../src/config/contribution.js");
    _clearContributionCacheForTests();
    setContributionConfig({ contribution: { share_pointers: true, set_via: "setup-prompt" } });
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.agent_id).toBe("agent-123");
    expect(onDisk.api_key).toBe("k_xyz");
    expect(onDisk.contribution.share_pointers).toBe(true);
  });
});

describe("contribution config — existing-user migration", () => {
  it("sets notice_shown_count=5 when config exists but has no contribution block", async () => {
    writeFileSync(cfgPath, JSON.stringify({ agent_id: "agent-old", some_other: "data" }));
    const { getContributionConfig } = await import("../src/config/contribution.js");
    const cfg = getContributionConfig();
    // Migrated users inherit the new opt-out default (public). The 5-stderr-
    // notice window is their cue to flip to private via `unbrowse mode private`.
    expect(cfg.contribution.share_pointers).toBe(true);
    expect(cfg.contribution.set_via).toBe("default");
    expect(cfg.notice_shown_count).toBe(5);
    // Should have persisted the migration
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.notice_shown_count).toBe(5);
    expect(onDisk.agent_id).toBe("agent-old");
  });

  it("does NOT trigger migration on a brand-new install (no config file)", async () => {
    const { getContributionConfig } = await import("../src/config/contribution.js");
    const cfg = getContributionConfig();
    expect(cfg.notice_shown_count).toBe(0);
  });

  it("does NOT re-migrate if the file already has a notice_shown_count", async () => {
    writeFileSync(cfgPath, JSON.stringify({ agent_id: "x", notice_shown_count: 2 }));
    const { getContributionConfig } = await import("../src/config/contribution.js");
    const cfg = getContributionConfig();
    expect(cfg.notice_shown_count).toBe(2);
  });
});

describe("contribution config — decrementNoticeCounter", () => {
  it("decrements by 1 and clamps at 0", async () => {
    writeFileSync(cfgPath, JSON.stringify({ agent_id: "x" })); // triggers migration → 5
    const { getContributionConfig, decrementNoticeCounter } = await import("../src/config/contribution.js");
    expect(getContributionConfig().notice_shown_count).toBe(5);

    expect(decrementNoticeCounter()).toBe(4);
    expect(decrementNoticeCounter()).toBe(3);
    expect(decrementNoticeCounter()).toBe(2);
    expect(decrementNoticeCounter()).toBe(1);
    expect(decrementNoticeCounter()).toBe(0);
    // Clamped — never goes negative
    expect(decrementNoticeCounter()).toBe(0);
    expect(getContributionConfig().notice_shown_count).toBe(0);

    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.notice_shown_count).toBe(0);
  });
});

describe("contribution config — auto_review default + migration", () => {
  it("auto_review defaults to true on a fresh install", async () => {
    const { getContributionConfig } = await import("../src/config/contribution.js");
    const cfg = getContributionConfig();
    expect(cfg.contribution.auto_review).toBe(true);
  });

  it("auto_review defaults to true for existing users without the field in config.json", async () => {
    // Old config had `contribution` block but no `auto_review` key.
    writeFileSync(
      cfgPath,
      JSON.stringify({
        contribution: { share_pointers: true, set_via: "setup-prompt" },
        rev_share: { opted_in: false },
      }),
    );
    const { getContributionConfig } = await import("../src/config/contribution.js");
    const cfg = getContributionConfig();
    // Missing field falls back to DEFAULT (true) — keeps the flywheel on for existing users too.
    expect(cfg.contribution.auto_review).toBe(true);
    expect(cfg.contribution.share_pointers).toBe(true);
  });

  it("setContributionConfig accepts a partial contribution update (auto_review only)", async () => {
    const { getContributionConfig, setContributionConfig } = await import("../src/config/contribution.js");
    // Flip auto_review without re-stating share_pointers
    setContributionConfig({ contribution: { auto_review: false } });
    const cfg = getContributionConfig();
    expect(cfg.contribution.auto_review).toBe(false);
    // share_pointers stays at its default (true)
    expect(cfg.contribution.share_pointers).toBe(true);
  });

  it("explicit auto_review=false persists to disk and survives a re-read", async () => {
    const { setContributionConfig, _clearContributionCacheForTests, getContributionConfig } = await import("../src/config/contribution.js");
    setContributionConfig({ contribution: { auto_review: false, set_via: "mode-command" } });
    _clearContributionCacheForTests();
    const cfg = getContributionConfig();
    expect(cfg.contribution.auto_review).toBe(false);
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.contribution.auto_review).toBe(false);
  });
});
