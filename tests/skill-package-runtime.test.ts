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
  it("ships the readable runtime and explicit binary-injection support required by the packaged CLI", () => {
    const manifest = JSON.parse(readFileSync(SKILL_PACKAGE_JSON, "utf8")) as {
      files?: string[];
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(manifest.files).toContain("bin");
    expect(manifest.files).toContain("runtime");
    expect(manifest.files).toContain("dist-sdk");
    expect(manifest.files).toContain("vendor/kuri");
    expect(manifest.files).toContain("vendor/utls-proxy");
    expect(manifest.files).toContain("scripts/postinstall.mjs");
    expect(manifest.files).toContain("scripts/release-assets.mjs");
    expect(manifest.files).toContain("scripts/verify-release-assets.mjs");
    expect(manifest.scripts?.postinstall).toBe("node scripts/postinstall.mjs");
    expect(manifest.scripts?.prepack).toContain("node scripts/assert-kuri-vendor.mjs");
    expect(manifest.scripts?.prepublishOnly).toContain("node scripts/verify-release-assets.mjs");
    expect(manifest.dependencies?.bs58).toBeDefined();
    expect(manifest.dependencies?.fastify).toBeDefined();
    expect(manifest.dependencies?.ws).toBeDefined();
    expect(manifest.dependencies?.["@cascade-fyi/splits-sdk"]).toBeUndefined();
    expect(manifest.dependencies?.["@solana/kit"]).toBeUndefined();
  });

  it("keeps explicit native-binary injection and readable-runtime diagnostics", () => {
    const wrapper = readFileSync(SKILL_WRAPPER, "utf8");

    expect(wrapper).toContain('const launcherPath = join(__dirname, "unbrowse.js");');
    expect(wrapper).toContain("unbrowseBinaryName(process.platform)");
    expect(wrapper).toContain("UNBROWSE_INSTALL_BINARY_PATH opt-in");
    expect(wrapper).toContain("readable, unsigned runtime via the launcher");
    expect(wrapper).toContain("npm uninstall -g unbrowse && npm install -g unbrowse@latest");
    expect(wrapper).toContain("spawnEntrypoint(binaryPath, process.argv.slice(2))");
    expect(wrapper).toContain("spawnEntrypoint(process.execPath, [launcherPath, ...process.argv.slice(2)])");
    expect(wrapper).not.toContain('spawn("bun"');
  });

  it("does not auto-download release binaries; only explicit local binary injection is honored", () => {
    const postinstall = readFileSync(SKILL_POSTINSTALL, "utf8");

    expect(postinstall).toContain("const localBinaryPath = process.env.UNBROWSE_INSTALL_BINARY_PATH;");
    expect(postinstall).toContain("copyFileSync(localBinaryPath, binaryPath);");
    expect(postinstall).toContain("readable runtime missing (runtime/cli.js)");
    expect(postinstall).not.toContain("buildBinaryArchiveName(version, target)");
    expect(postinstall).not.toContain('execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);');
  });

  it("clears any stray local packaged binary before npm pack runs", () => {
    const preparePack = readFileSync(SKILL_PREPARE_PACK, "utf8");

    expect(preparePack).toContain('const packagedBinaryPath = path.join(packageRoot, "bin", "unbrowse");');
    expect(preparePack).toContain('execFileSync("bun", [path.join(repoRoot, "scripts", "build-release-manifest.ts")]');
    expect(preparePack).toContain("rmSync(packagedBinaryPath, { force: true });");
  });

  it("does not ship duplicate analytics session exports that break packaged tsx runtime", () => {
    const clientSrc = readFileSync(CLIENT_SRC, "utf8");
    const matches = clientSrc.match(/export async function recordAnalyticsSession\s*\(/g) ?? [];

    expect(matches).toHaveLength(1);
  });

  it("routes packaged mcp through the single-binary internal entrypoint instead of re-feeding /$bunfs paths into the cli parser", () => {
    const cliSrc = readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
    const singleBinarySrc = readFileSync(path.join(ROOT, "src", "single-binary.ts"), "utf8");

    expect(cliSrc).toContain('["mcp-serve"');
    expect(singleBinarySrc).toContain('args[0] === "mcp-serve"');
    expect(singleBinarySrc).toContain('await import("./mcp.js")');
  });
});
