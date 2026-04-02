import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SKILL_PACKAGE_JSON = path.join(ROOT, "packages", "skill", "package.json");
const SKILL_WRAPPER = path.join(ROOT, "packages", "skill", "bin", "unbrowse-wrapper.mjs");

describe("standalone skill package runtime", () => {
  it("ships the payment/runtime dependencies required by the packaged CLI", () => {
    const manifest = JSON.parse(readFileSync(SKILL_PACKAGE_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.bs58).toBeDefined();
    expect(manifest.dependencies?.["@cascade-fyi/splits-sdk"]).toBeDefined();
    expect(manifest.dependencies?.["@solana/kit"]).toBeDefined();
  });

  it("delegates wrapper fallback through the node launcher", () => {
    const wrapper = readFileSync(SKILL_WRAPPER, "utf8");

    expect(wrapper).toContain('const launcherPath = join(__dirname, "unbrowse.js");');
    expect(wrapper).toContain("spawn(process.execPath, [launcherPath, ...process.argv.slice(2)]");
    expect(wrapper).not.toContain('spawn("bun"');
  });
});
