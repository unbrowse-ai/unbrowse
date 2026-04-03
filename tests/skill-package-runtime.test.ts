import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SKILL_PACKAGE_JSON = path.join(ROOT, "packages", "skill", "package.json");
const SKILL_WRAPPER = path.join(ROOT, "packages", "skill", "bin", "unbrowse-wrapper.mjs");
const CLIENT_SRC = path.join(ROOT, "src", "client", "index.ts");
const SKILL_POSTINSTALL = path.join(ROOT, "packages", "skill", "scripts", "postinstall.mjs");

describe("standalone skill package runtime", () => {
  it("ships the binary-only installer scripts required by the packaged CLI", () => {
    const manifest = JSON.parse(readFileSync(SKILL_PACKAGE_JSON, "utf8")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(manifest.files).toContain("bin/unbrowse-wrapper.mjs");
    expect(manifest.files).toContain("scripts/postinstall.mjs");
    expect(manifest.files).toContain("scripts/release-assets.mjs");
    expect(manifest.files).toContain("scripts/verify-release-assets.mjs");
    expect(manifest.files).not.toContain("runtime-src");
    expect(manifest.files).not.toContain("dist");
    expect(manifest.scripts?.postinstall).toBe("node scripts/postinstall.mjs");
    expect(manifest.scripts?.prepublishOnly).toContain("node scripts/verify-release-assets.mjs");
  });

  it("hard-fails when the native binary is missing", () => {
    const wrapper = readFileSync(SKILL_WRAPPER, "utf8");

    expect(wrapper).toContain('const binaryPath = join(__dirname, "unbrowse");');
    expect(wrapper).toContain("spawn(binaryPath, process.argv.slice(2)");
    expect(wrapper).toContain("Native CLI binary is missing.");
    expect(wrapper).not.toContain("unbrowse.js");
    expect(wrapper).not.toContain('spawn("bun"');
  });

  it("downloads the packaged binary from versioned GitHub release tarballs", () => {
    const postinstall = readFileSync(SKILL_POSTINSTALL, "utf8");

    expect(postinstall).toContain('const assetName = `unbrowse-${target}`;');
    expect(postinstall).toContain("const localBinaryPath = process.env.UNBROWSE_INSTALL_BINARY_PATH;");
    expect(postinstall).toContain("await download(url, binaryPath);");
    expect(postinstall).toContain("process.exit(1);");
  });

  it("does not ship duplicate analytics session exports that break packaged tsx runtime", () => {
    const clientSrc = readFileSync(CLIENT_SRC, "utf8");
    const matches = clientSrc.match(/export async function recordAnalyticsSession\s*\(/g) ?? [];

    expect(matches).toHaveLength(1);
  });
});
