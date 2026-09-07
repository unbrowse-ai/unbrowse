import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let cfgPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "unbrowse-setup-"));
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

describe("promptContributionMode — setup flow choices", () => {
  it("[1] Private — sets share_pointers=false, opted_in=false", async () => {
    const { promptContributionMode } = await import("../src/cli-setup.js");
    const choice = await promptContributionMode({
      readChoice: async () => 1,
      log: () => {},
    });
    expect(choice).toBe(1);
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.contribution.share_pointers).toBe(false);
    expect(onDisk.contribution.set_via).toBe("setup-prompt");
    expect(onDisk.rev_share.opted_in).toBe(false);
  });

  it("[2] Share — sets share_pointers=true, opted_in=false", async () => {
    const { promptContributionMode } = await import("../src/cli-setup.js");
    const choice = await promptContributionMode({
      readChoice: async () => 2,
      log: () => {},
    });
    expect(choice).toBe(2);
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.contribution.share_pointers).toBe(true);
    expect(onDisk.contribution.set_via).toBe("setup-prompt");
    expect(onDisk.rev_share.opted_in).toBe(false);
  });

  it("[3] Share + earn — sets share_pointers=true, opted_in=true", async () => {
    const { promptContributionMode } = await import("../src/cli-setup.js");
    const choice = await promptContributionMode({
      readChoice: async () => 3,
      log: () => {},
    });
    expect(choice).toBe(3);
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.contribution.share_pointers).toBe(true);
    expect(onDisk.contribution.set_via).toBe("setup-prompt");
    expect(onDisk.rev_share.opted_in).toBe(true);
  });

  it("does NOT re-prompt if user already chose (force=false default)", async () => {
    const { promptContributionMode } = await import("../src/cli-setup.js");
    await promptContributionMode({ readChoice: async () => 2, log: () => {} });
    let calls = 0;
    const second = await promptContributionMode({
      readChoice: async () => { calls++; return 1; },
      log: () => {},
    });
    expect(second).toBeNull();
    expect(calls).toBe(0);
    // First choice preserved
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.contribution.share_pointers).toBe(true);
  });

  it("force=true re-prompts and stamps set_via=mode-command", async () => {
    const { promptContributionMode } = await import("../src/cli-setup.js");
    await promptContributionMode({ readChoice: async () => 2, log: () => {} });
    const second = await promptContributionMode({
      force: true,
      readChoice: async () => 1,
      log: () => {},
    });
    expect(second).toBe(1);
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(onDisk.contribution.share_pointers).toBe(false);
    expect(onDisk.contribution.set_via).toBe("mode-command");
  });

  it("non-interactive setup does not print or persist a default choice", async () => {
    const { promptContributionMode } = await import("../src/cli-setup.js");
    const previous = process.env.UNBROWSE_NON_INTERACTIVE;
    process.env.UNBROWSE_NON_INTERACTIVE = "1";
    const logs: string[] = [];
    try {
      const choice = await promptContributionMode({ log: (msg) => logs.push(msg) });
      expect(choice).toBeNull();
      expect(logs).toEqual([]);
      expect(() => readFileSync(cfgPath, "utf-8")).toThrow();
    } finally {
      if (previous == null) delete process.env.UNBROWSE_NON_INTERACTIVE;
      else process.env.UNBROWSE_NON_INTERACTIVE = previous;
    }
  });
});

describe("maybeShowContributionNotice — existing-user notice", () => {
  it("prints notice and decrements counter when set_via=default + count>0", async () => {
    // Trigger the migration path so notice_shown_count = 5
    writeFileSync(cfgPath, JSON.stringify({ agent_id: "old-user" }));

    const { maybeShowContributionNotice } = await import("../src/cli-setup.js");
    const { getContributionConfig } = await import("../src/config/contribution.js");

    // Capture stderr writes
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { writes.push(s); return true; };

    try {
      const shown = maybeShowContributionNotice();
      expect(shown).toBe(true);
      expect(writes.join("")).toContain("private` by default");
      expect(writes.join("")).toContain("unbrowse mode");
      // Counter decremented from 5 → 4
      expect(getContributionConfig().notice_shown_count).toBe(4);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("does NOT print when user has explicitly chosen a mode", async () => {
    const { promptContributionMode, maybeShowContributionNotice } = await import("../src/cli-setup.js");
    await promptContributionMode({ readChoice: async () => 1, log: () => {} });

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { writes.push(s); return true; };
    try {
      const shown = maybeShowContributionNotice();
      expect(shown).toBe(false);
      expect(writes).toEqual([]);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("does NOT print on a brand-new install (count=0)", async () => {
    const { maybeShowContributionNotice } = await import("../src/cli-setup.js");
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { writes.push(s); return true; };
    try {
      const shown = maybeShowContributionNotice();
      expect(shown).toBe(false);
      expect(writes).toEqual([]);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("stops printing after the counter reaches 0 (5-shot cap)", async () => {
    writeFileSync(cfgPath, JSON.stringify({ agent_id: "old-user" }));
    const { maybeShowContributionNotice } = await import("../src/cli-setup.js");
    const { getContributionConfig } = await import("../src/config/contribution.js");

    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      for (let i = 0; i < 5; i++) {
        expect(maybeShowContributionNotice()).toBe(true);
      }
      expect(getContributionConfig().notice_shown_count).toBe(0);
      expect(maybeShowContributionNotice()).toBe(false);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
