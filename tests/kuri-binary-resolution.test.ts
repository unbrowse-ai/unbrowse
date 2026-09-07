/**
 * Kuri binary resolution — honest lookup over a SYNTHETIC filesystem.
 *
 * Every case below builds its own temp home / package root and injects them
 * through `KuriBinaryLookup`. Nothing here reads the developer's real
 * `~/.unbrowse`, real `$PATH`, or real `process.env` — a green run on a machine
 * with kuri installed must mean the same thing as a green run on a machine
 * without it.
 *
 * The defect under test: `findKuriBinary()` used to end in `?? candidates[0]`,
 * so when nothing existed it returned a path it had just proved absent. Callers
 * then "found" an unspawnable binary and the failure surfaced downstream as a
 * misleading "no endpoints discovered; site may need authentication or
 * different intent". The sharpest test here is
 * "nothing present -> never returns a non-existent path".
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KuriBinaryNotFoundError } from "../src/kuri/resolve-paths.js";
import { KURI_BINARY_ENV_VARS, findKuriBinary, getInstalledKuriBinaryPath, getKuriBinaryCandidates, requireKuriBinary, type KuriBinaryLookup } from "../src/kuri/resolve-paths.js";

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Write an executable stand-in for the kuri binary at `target`. */
function fakeBinary(target: string): string {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "#!/bin/sh\nexit 0\n");
  chmodSync(target, 0o755);
  return target;
}

/**
 * A lookup pinned entirely to synthetic roots.
 *
 * `env: {}` (not process.env) means an ambient UNBROWSE_KURI_BIN/KURI_BIN on the
 * developer's machine cannot influence the result, and `lookupOnPath: () => null`
 * means a system-wide `kuri` on $PATH cannot either. `exists` stays the real
 * `existsSync` so the fixtures are genuine files on disk, not a stubbed fs.
 */
function syntheticLookup(overrides: Partial<KuriBinaryLookup> = {}): KuriBinaryLookup {
  return {
    env: {},
    home: tmpDir("kuri-res-home-"),
    packageRoot: tmpDir("kuri-res-pkg-"),
    platform: "linux",
    arch: "x64",
    lookupOnPath: () => null,
    ...overrides,
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("kuri binary resolution", () => {
  describe("finds the binary where the installer actually puts it", () => {
    it("resolves ~/.unbrowse/bin/kuri — the path single-binary.ts extracts to", () => {
      const home = tmpDir("kuri-res-home-");
      const lookup = syntheticLookup({ home });

      // Mirrors src/single-binary.ts: KURI_CACHE = join(homedir(), ".unbrowse", "bin", kuriBinaryName())
      const installed = fakeBinary(path.join(home, ".unbrowse", "bin", "kuri"));

      expect(getInstalledKuriBinaryPath(lookup)).toBe(installed);
      expect(getKuriBinaryCandidates(lookup)).toContain(installed);
      expect(requireKuriBinary(lookup)).toBe(installed);
      expect(findKuriBinary(lookup)).toBe(installed);
    });

    it("uses kuri.exe under the installer path on win32", () => {
      const home = tmpDir("kuri-res-home-");
      const lookup = syntheticLookup({ home, platform: "win32" });
      const installed = fakeBinary(path.join(home, ".unbrowse", "bin", "kuri.exe"));

      expect(getInstalledKuriBinaryPath(lookup)).toBe(installed);
      expect(requireKuriBinary(lookup)).toBe(installed);
    });

    it("still prefers a version-matched vendored binary over the shared install", () => {
      const home = tmpDir("kuri-res-home-");
      const packageRoot = tmpDir("kuri-res-pkg-");
      const lookup = syntheticLookup({ home, packageRoot });

      const vendored = fakeBinary(path.join(packageRoot, "vendor", "kuri", "linux-x64", "kuri"));
      const installed = fakeBinary(path.join(home, ".unbrowse", "bin", "kuri"));

      expect(existsSync(installed)).toBe(true); // both exist; ordering decides
      expect(requireKuriBinary(lookup)).toBe(vendored);
    });
  });

  describe("explicit overrides", () => {
    it("KURI_BIN wins over an installed binary", () => {
      const home = tmpDir("kuri-res-home-");
      fakeBinary(path.join(home, ".unbrowse", "bin", "kuri"));
      const pinned = fakeBinary(path.join(tmpDir("kuri-res-pin-"), "kuri"));

      const lookup = syntheticLookup({ home, env: { KURI_BIN: pinned } });
      expect(requireKuriBinary(lookup)).toBe(pinned);
    });

    it("UNBROWSE_KURI_BIN wins over an installed binary", () => {
      const home = tmpDir("kuri-res-home-");
      fakeBinary(path.join(home, ".unbrowse", "bin", "kuri"));
      const pinned = fakeBinary(path.join(tmpDir("kuri-res-pin-"), "kuri"));

      const lookup = syntheticLookup({ home, env: { UNBROWSE_KURI_BIN: pinned } });
      expect(requireKuriBinary(lookup)).toBe(pinned);
    });

    it("UNBROWSE_KURI_BIN outranks KURI_BIN, matching cli.ts and kuri/spawn.ts", () => {
      const preferred = fakeBinary(path.join(tmpDir("kuri-res-pref-"), "kuri"));
      const secondary = fakeBinary(path.join(tmpDir("kuri-res-sec-"), "kuri"));

      const lookup = syntheticLookup({
        env: { UNBROWSE_KURI_BIN: preferred, KURI_BIN: secondary },
      });
      expect(requireKuriBinary(lookup)).toBe(preferred);
      expect(KURI_BINARY_ENV_VARS[0]).toBe("UNBROWSE_KURI_BIN");
    });

    it("a pinned-but-missing override fails naming the var; it never silently substitutes another binary", () => {
      const home = tmpDir("kuri-res-home-");
      const installed = fakeBinary(path.join(home, ".unbrowse", "bin", "kuri"));
      const missing = path.join(tmpDir("kuri-res-gone-"), "kuri");

      const lookup = syntheticLookup({ home, env: { KURI_BIN: missing } });

      expect(findKuriBinary(lookup)).toBeNull();
      expect(() => requireKuriBinary(lookup)).toThrow(KuriBinaryNotFoundError);

      let message = "";
      try { requireKuriBinary(lookup); } catch (err) { message = (err as Error).message; }
      expect(message).toContain("Kuri binary not found");
      expect(message).toContain(missing);
      expect(message).toContain("KURI_BIN");
      // The installed binary is present but was NOT what the caller asked for.
      expect(message).not.toContain(`(from ${installed})`);
    });
  });

  describe("nothing present", () => {
    /**
     * THE BUG. `findKuriBinary()` promises a found binary in its name; the old
     * body ended in `?? candidates[0]` and so, on a miss, returned a path it had
     * just proved absent. Whatever it hands back must be real.
     */
    it("never returns a path that does not exist", () => {
      const lookup = syntheticLookup();

      const candidates = getKuriBinaryCandidates(lookup);
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) expect(existsSync(candidate)).toBe(false);

      let returned: string | null = null;
      let threw = false;
      try {
        returned = findKuriBinary(lookup);
      } catch {
        threw = true;
      }

      // The invariant: a non-null return is ALWAYS a path on disk. The old
      // `?? candidates[0]` returned candidates[0], which is not.
      expect(returned === null || existsSync(returned)).toBe(true);
      expect(returned).not.toBe(candidates[0]);
      // Signalling a miss by throwing would also be honest; returning a
      // fictional path is the one thing that is not.
      expect(threw || returned === null || existsSync(returned!)).toBe(true);
      expect(returned).toBeNull();
    });

    it("requireKuriBinary refuses to invent a path and throws instead", () => {
      const lookup = syntheticLookup();
      const candidates = getKuriBinaryCandidates(lookup);

      let returned: string | null = null;
      let threw = false;
      try {
        returned = requireKuriBinary(lookup);
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      expect(returned).not.toBe(candidates[0]);
      expect(returned === null || existsSync(returned)).toBe(true);
    });

    it("findKuriBinary returns null rather than a guess", () => {
      expect(findKuriBinary(syntheticLookup())).toBeNull();
    });

    it("the error names every searched path and the override variable", () => {
      const lookup = syntheticLookup();
      const candidates = getKuriBinaryCandidates(lookup);

      let error: KuriBinaryNotFoundError | null = null;
      try { requireKuriBinary(lookup); } catch (err) { error = err as KuriBinaryNotFoundError; }

      expect(error).toBeInstanceOf(KuriBinaryNotFoundError);
      const message = error!.message;

      // Actionable: the user learns where we looked...
      for (const candidate of candidates) expect(message).toContain(candidate);
      // ...and how to override it.
      expect(message).toContain("UNBROWSE_KURI_BIN");
      // Preserves the phrasing startOn and tests/kuri-client.test.ts match on.
      expect(message).toContain("Kuri binary not found");
      expect(error!.searched).toEqual(candidates);
      expect(error!.overrideVar).toBeNull();
    });

    it("reports the installer path among the searched paths, so the fix is discoverable", () => {
      const home = tmpDir("kuri-res-home-");
      const lookup = syntheticLookup({ home });

      let message = "";
      try { requireKuriBinary(lookup); } catch (err) { message = (err as Error).message; }
      expect(message).toContain(path.join(home, ".unbrowse", "bin", "kuri"));
    });
  });

  describe("candidate list shape", () => {
    it("is free of duplicates and never empty", () => {
      const candidates = getKuriBinaryCandidates(syntheticLookup());
      expect(candidates.length).toBeGreaterThan(0);
      expect(new Set(candidates).size).toBe(candidates.length);
    });

    it("keeps probing the vendored trees one level above the bundled runtime dir", () => {
      const pkg = tmpDir("kuri-res-bundle-");
      const runtimeRoot = path.join(pkg, "runtime");
      mkdirSync(runtimeRoot, { recursive: true });
      const lookup = syntheticLookup({ packageRoot: runtimeRoot });

      const vendored = fakeBinary(path.join(pkg, "vendor", "kuri", "linux-x64", "kuri"));
      expect(getKuriBinaryCandidates(lookup)).toContain(vendored);
      expect(requireKuriBinary(lookup)).toBe(vendored);
    });
  });
});
