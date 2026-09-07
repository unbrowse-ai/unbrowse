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
    // The injected foreign binary genuinely cannot be imported, so it stays a spawn.
    expect(wrapper).toContain("spawnEntrypoint(binaryPath, process.argv.slice(2))");
    expect(wrapper).not.toContain('spawn("bun"');
  });

  // Chain-collapse regression. One logical `unbrowse mcp` used to be FOUR node
  // processes (wrapper → bin/unbrowse.js → runtime/cli.js → runtime/mcp.js), and
  // not one hop forwarded a signal, so a client SIGTERM killed only the process it
  // launched and orphaned the other three (~176MB RSS each, observed at 189 leaked
  // trees on one host). Each assertion below pins one collapsed hop.
  it("collapses the launch chain: the default path imports in-process instead of spawning a node per hop", () => {
    const wrapper = readFileSync(SKILL_WRAPPER, "utf8");
    const launcher = readFileSync(path.join(ROOT, "packages", "skill", "bin", "unbrowse.js"), "utf8");
    const cliSrc = readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");

    // Hop 1: wrapper runs the launcher in-process, not via a second interpreter.
    expect(wrapper).toContain("await runLauncherInProcess()");
    expect(wrapper).not.toContain("spawnEntrypoint(process.execPath, [launcherPath");

    // Hop 2: the launcher imports the runtime. spawnSync here was load-bearing —
    // it blocks the event loop for the child's whole life, so a signal handler
    // could never have run. Forwarding was structurally impossible, not omitted.
    // Pin the absent IMPORT, not the name: the name survives in the comment that
    // explains why it had to go, and no child_process import is a strictly
    // stronger guarantee — this file cannot spawn anything at all.
    expect(launcher).not.toContain('from "node:child_process"');
    expect(launcher).toContain("await import(pathToFileURL(runtime).href)");

    // Hop 3: cmdMcp runs the stdio server in this process.
    expect(cliSrc).toContain('await import("./mcp.js")');

    // Both in-process hops must restage argv[1] as the spawn did, or isMainModule()
    // fails to match and the runtime starts up and silently does nothing.
    expect(wrapper).toContain("process.argv = [process.execPath, launcherPath, ...process.argv.slice(2)]");
    expect(launcher).toContain("process.argv = [process.execPath, runtime, ...process.argv.slice(2)]");
  });

  it("keeps the one surviving spawn hop signal-transparent", () => {
    const wrapper = readFileSync(SKILL_WRAPPER, "utf8");

    // The injected-binary spawn is the only child left anywhere in the chain.
    // Node's default signal action would terminate the parent without touching
    // it, so it must forward explicitly and reap on parent exit.
    expect(wrapper).toContain('const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]');
    expect(wrapper).toContain("process.on(signal, handler)");
    expect(wrapper).toContain('child.kill("SIGKILL")');
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
    const manifest = JSON.parse(readFileSync(SKILL_PACKAGE_JSON, "utf8")) as { scripts?: Record<string, string> };

    expect(preparePack).toContain('const packagedBinaryPath = path.join(packageRoot, "bin", "unbrowse");');
    expect(manifest.scripts?.prepack).toContain("../../scripts/build-release-manifest.ts");
    expect(preparePack).toContain("rmSync(packagedBinaryPath, { force: true });");
  });

  it("does not ship duplicate analytics session exports that break packaged tsx runtime", () => {
    const clientSrc = readFileSync(CLIENT_SRC, "utf8");
    const matches = clientSrc.match(/export async function recordAnalyticsSession\s*\(/g) ?? [];

    expect(matches).toHaveLength(1);
  });

  it("never re-feeds /$bunfs paths into the cli parser to start mcp", () => {
    const cliSrc = readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
    const singleBinarySrc = readFileSync(path.join(ROOT, "src", "single-binary.ts"), "utf8");

    // cmdMcp used to branch on isBundledVirtualEntrypoint and re-invoke the
    // packaged binary as `<self> mcp-serve` to dodge the /$bunfs path. It now
    // imports the server directly, which dodges it for every install shape at
    // once and spawns nothing — so the branch, and its argv, are gone.
    expect(cliSrc).toContain('await import("./mcp.js")');
    expect(cliSrc).not.toContain('["mcp-serve"');
    // The branch itself is gone (the identifier survives only in the comment
    // explaining why the import was dropped, so pin the CALL, not the name).
    expect(cliSrc).not.toContain("isBundledVirtualEntrypoint(");

    // The binary's own `unbrowse mcp-serve` entry still exists for direct
    // invocation, and has always used the same in-process import.
    expect(singleBinarySrc).toContain('args[0] === "mcp-serve"');
    expect(singleBinarySrc).toContain('await import("./mcp.js")');
  });
});
