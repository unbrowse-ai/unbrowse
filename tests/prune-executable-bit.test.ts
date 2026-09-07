/**
 * prune-executable-bit.test — the npm postinstall MUST restore +x on this host's
 * vendored kuri/utls binaries. CI ships the linux-x64 kuri mode 0644, so without
 * this `spawn(kuri)` throws EACCES and the unhandled 'error' event crashes the CLI
 * on the next browse/fetch. The chmod runs even under UNBROWSE_NO_PRUNE.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PRUNE = join(import.meta.dir, "..", "packages", "skill", "scripts", "prune-foreign-binaries.mjs");

// This host's vendor layout (mirror prune-foreign-binaries.mjs).
const platform = process.platform;
const arch = process.arch;
const goarch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch;
const hostKuriDir = platform === "win32" && arch === "x64" ? "win-x64" : `${platform}-${arch}`;
const kuriName = platform === "win32" ? "kuri.exe" : "kuri";
const utlsName = `utls-proxy-${platform}-${goarch}`;

let tmp: string;
function seed(): { kuri: string; utls: string } {
  tmp = mkdtempSync(join(tmpdir(), "ubx-prune-"));
  mkdirSync(join(tmp, "vendor", "kuri", hostKuriDir), { recursive: true });
  mkdirSync(join(tmp, "vendor", "utls-proxy"), { recursive: true });
  const kuri = join(tmp, "vendor", "kuri", hostKuriDir, kuriName);
  const utls = join(tmp, "vendor", "utls-proxy", utlsName);
  writeFileSync(kuri, "fake"); chmodSync(kuri, 0o644);
  writeFileSync(utls, "fake"); chmodSync(utls, 0o644);
  return { kuri, utls };
}
const mode = (p: string) => statSync(p).mode & 0o777;

afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("prune restores the executable bit on host vendor binaries", () => {
  it("0644 → 0755 for kuri and utls", () => {
    const { kuri, utls } = seed();
    expect(mode(kuri)).toBe(0o644);
    spawnSync("node", [PRUNE, "--root", tmp], { encoding: "utf8" });
    expect(mode(kuri) & 0o111).not.toBe(0); // executable bits set
    expect(mode(utls) & 0o111).not.toBe(0);
  });

  it("chmods even when UNBROWSE_NO_PRUNE=1 (the +x is not optional)", () => {
    const { kuri } = seed();
    spawnSync("node", [PRUNE, "--root", tmp], { encoding: "utf8", env: { ...process.env, UNBROWSE_NO_PRUNE: "1" } });
    expect(mode(kuri) & 0o111).not.toBe(0);
  });

  it("does not delete foreign Kuri assets from a source checkout", () => {
    tmp = mkdtempSync(join(tmpdir(), "ubx-prune-source-"));
    const packageRoot = join(tmp, "packages", "skill");
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "single-binary.ts"), "// source checkout marker\n");

    const foreignKuriDir = hostKuriDir === "darwin-arm64" ? "linux-x64" : "darwin-arm64";
    const foreignUtlsName = utlsName === "utls-proxy-linux-amd64" ? "utls-proxy-darwin-amd64" : "utls-proxy-linux-amd64";
    mkdirSync(join(packageRoot, "vendor", "kuri", hostKuriDir), { recursive: true });
    mkdirSync(join(packageRoot, "vendor", "kuri", foreignKuriDir), { recursive: true });
    mkdirSync(join(packageRoot, "vendor", "utls-proxy"), { recursive: true });
    const hostKuri = join(packageRoot, "vendor", "kuri", hostKuriDir, kuriName);
    const foreignKuri = join(packageRoot, "vendor", "kuri", foreignKuriDir, "kuri");
    const hostUtls = join(packageRoot, "vendor", "utls-proxy", utlsName);
    const foreignUtls = join(packageRoot, "vendor", "utls-proxy", foreignUtlsName);
    writeFileSync(hostKuri, "host"); chmodSync(hostKuri, 0o644);
    writeFileSync(foreignKuri, "foreign"); chmodSync(foreignKuri, 0o755);
    writeFileSync(hostUtls, "host"); chmodSync(hostUtls, 0o644);
    writeFileSync(foreignUtls, "foreign"); chmodSync(foreignUtls, 0o755);

    const res = spawnSync("node", [PRUNE, "--root", packageRoot], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(mode(hostKuri) & 0o111).not.toBe(0);
    expect(mode(hostUtls) & 0o111).not.toBe(0);
    expect(existsSync(foreignKuri)).toBe(true);
    expect(existsSync(foreignUtls)).toBe(true);
  });
});
