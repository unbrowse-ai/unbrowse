import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SKILL_PACKAGE_JSON = path.join(ROOT, "packages", "skill", "package.json");
const SKILL_WRAPPER = path.join(ROOT, "packages", "skill", "bin", "unbrowse-wrapper.mjs");
const CLIENT_SRC = path.join(ROOT, "src", "client", "index.ts");
const SKILL_POSTINSTALL = path.join(ROOT, "packages", "skill", "scripts", "postinstall.mjs");
const SKILL_PREPARE_PACK = path.join(ROOT, "packages", "skill", "scripts", "prepare-pack.mjs");

describe("standalone skill package runtime", () => {
  it("ships the binary download and fallback runtime files required by the packaged CLI", () => {
    const manifest = JSON.parse(readFileSync(SKILL_PACKAGE_JSON, "utf8")) as {
      files?: string[];
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(manifest.files).toContain("bin");
    expect(manifest.files).toContain("dist");
    expect(manifest.files).toContain("runtime-src");
    expect(manifest.files).toContain("vendor/kuri");
    expect(manifest.files).toContain("scripts/postinstall.mjs");
    expect(manifest.files).toContain("scripts/release-assets.mjs");
    expect(manifest.files).toContain("scripts/verify-release-assets.mjs");
    expect(manifest.scripts?.postinstall).toBe("node scripts/postinstall.mjs");
    expect(manifest.scripts?.prepack).toContain("node scripts/assert-kuri-vendor.mjs");
    expect(manifest.scripts?.prepublishOnly).toContain("node scripts/verify-release-assets.mjs");
    expect(manifest.dependencies?.bs58).toBeDefined();
    expect(manifest.dependencies?.["@cascade-fyi/splits-sdk"]).toBeDefined();
    expect(manifest.dependencies?.["@solana/kit"]).toBeDefined();
  });

  it("keeps the native-binary fast path and the source fallback diagnostics", () => {
    const wrapper = readFileSync(SKILL_WRAPPER, "utf8");

    expect(wrapper).toContain('const launcherPath = join(__dirname, "unbrowse.js");');
    expect(wrapper).toContain('const binaryPath = join(__dirname, "unbrowse");');
    expect(wrapper).toContain("KNOWN_BAD_FALLBACK_VERSIONS");
    expect(wrapper).toContain("Fallback runtime is missing required packages");
    expect(wrapper).toContain("npm uninstall -g unbrowse && npm install -g unbrowse@latest");
    expect(wrapper).toContain("spawnEntrypoint(binaryPath, process.argv.slice(2))");
    expect(wrapper).not.toContain('spawn("bun"');
  });

  it("downloads the packaged binary from versioned GitHub release assets and tolerates runtime fallback", () => {
    const postinstall = readFileSync(SKILL_POSTINSTALL, "utf8");

    expect(postinstall).toContain('const assetName = `unbrowse-${target}`;');
    expect(postinstall).toContain("const localBinaryPath = process.env.UNBROWSE_INSTALL_BINARY_PATH;");
    expect(postinstall).toContain("await download(url, binaryPath);");
    expect(postinstall).toContain("Falling back to source mode");
  });

  it("clears any stray local packaged binary before npm pack runs", () => {
    const preparePack = readFileSync(SKILL_PREPARE_PACK, "utf8");

    expect(preparePack).toContain('const packagedBinaryPath = path.join(packageRoot, "bin", "unbrowse");');
    expect(preparePack).toContain("rmSync(packagedBinaryPath, { force: true });");
  });

  it("does not ship duplicate analytics session exports that break packaged tsx runtime", () => {
    const clientSrc = readFileSync(CLIENT_SRC, "utf8");
    const matches = clientSrc.match(/export async function recordAnalyticsSession\s*\(/g) ?? [];

    expect(matches).toHaveLength(1);
  });
});
