/**
 * Signals over the obscura capture seam — the checks that were missing.
 *
 * Of every check in this repo, not one caught "vendored, wired, and never once
 * run". The binaries were on disk, the dispatch existed at execution/index.ts,
 * the path helpers had unit tests — and obscura capture had never produced a
 * route on this machine, because the vendor candidate path was one directory
 * short and resolution fell through to a bare PATH lookup.
 *
 * Day-3's tests are pure path arithmetic against synthetic strings: they pass
 * identically on a machine with no binary at all. That is a house that looks
 * founded until it rains. These are the signals that would have failed.
 *
 * They sit ON the seam, not inside either engine:
 *   1. environment  — when a vendor tree exists, resolution must REACH it
 *   2. boundary     — capture/index.ts must stay engine-pure
 *   3. drift        — engine selection must not sprawl silently
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveObscuraBin, capturedNothing } from "../src/capture/obscura-capture.js";
import { isOriginUnreachableError } from "../src/values/origin-health.js";
import { codeLinesOnly } from "./_source-scan.js";

const ROOT = join(import.meta.dirname, "..");
const vendorDir = join(ROOT, "vendor", "obscura");
const vendorPresent = existsSync(vendorDir);

describe("environment: a vendored binary must be REACHABLE, not merely present", () => {
  test.skipIf(!vendorPresent)(
    "resolveObscuraBin lands on a real file when vendor/obscura exists",
    () => {
      // The exact failure this repo shipped: 81MB on disk, resolver returning a
      // bare name, capture dying with "Executable not found in $PATH".
      // Presence is not reachability, and only this assertion knows the
      // difference.
      const resolved = resolveObscuraBin("obscura-capture");
      expect(resolved).toBeTruthy();
      expect({ resolved, exists: existsSync(String(resolved)) })
        .toEqual({ resolved, exists: true });
    },
  );

  test.skipIf(!vendorPresent)("every vendored binary is executable, not a stub", () => {
    for (const target of readdirSync(vendorDir)) {
      const dir = join(vendorDir, target);
      for (const bin of readdirSync(dir)) {
        const { size, mode } = require("node:fs").statSync(join(dir, bin));
        // A truncated / LFS-pointer download is the other way "present" lies.
        expect({ bin, big: size > 1_000_000 }).toEqual({ bin, big: true });
        expect({ bin, executable: (mode & 0o111) !== 0 }).toEqual({ bin, executable: true });
      }
    }
  });
});

describe("boundary: the CDP engine stays engine-pure", () => {
  test("capture/index.ts contains NO obscura branch", () => {
    //  as an assertion. capture/index.ts is ~3,000 lines of
    // Chrome/CDP; branching obscura INSIDE it makes every future change pay for
    // both engines. Selection belongs above, on the seam. If this ever fails,
    // someone poured new wine into the old bottle.
    const src = readFileSync(join(ROOT, "src/capture/index.ts"), "utf8");
    expect(src.toLowerCase().includes("obscura")).toBe(false);
  });

  test("the obscura engine does not import the CDP engine's capture entrypoint", () => {
    // Symmetry: neither water reaches over the firmament. Sharing the RawRequest
    // TYPE is the intended contract and stays allowed.
    const src = readFileSync(join(ROOT, "src/capture/obscura-index.ts"), "utf8");
    expect(src.includes("captureSession(")).toBe(false);
  });
});

describe("drift: engine selection must not sprawl unnoticed", () => {
  test("obscuraBackendSelected is read only at known dispatch sites", () => {
    // Frozen inventory. Growth is not forbidden — it must be DELIBERATE, because
    // a second silent selection site is how one caller ends up on a different
    // engine than its neighbour, which is exactly the state this task began in
    // (execution/index.ts gated, five captureSession callers not).
    const known = new Set([
      "src/api/routes.ts",
      // The firmament itself — the ONE site that exists to select an engine.
      // Every caller crossing it inherits the choice instead of re-deciding.
      "src/capture/engine.ts",
      "src/execution/index.ts",
      "src/cli-v7/breath/go.ts",
      "src/cli-v7/breath/auth-capture.ts",
      "src/cli-v7/breath/proxy-rotate.ts",
      "src/cli-v7/breath/session-restore.ts",
    ]);
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith(".ts")) continue;
        // Ignore prose. The first version matched a doc comment in
        // src/obscura/readers.ts ("the handlers select it via
        // obscuraBackendSelected()") — a drift signal that counts documentation
        // gets muted. The SECOND version stripped block comments by regex,
        // which is unsound: a `/*` inside a string literal eats everything to
        // the next close, measured at 28% of src/orchestrator/index.ts. This
        // check saw all 7 of its sites anyway, but by luck of where the hole
        // fell. codeLinesOnly cannot open an unterminated region.
        const src = codeLinesOnly(readFileSync(p, "utf8"));
        if (/\bobscuraBackendSelected\(\)/.test(src) && !/export function obscuraBackendSelected/.test(src)) {
          found.add(p.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(ROOT, "src"));
    expect([...found].filter((f) => !known.has(f)).sort()).toEqual([]);
  });
});

describe("behaviour: a dead origin must not look like a boring page", () => {
  test("nothing received is recognised, and a real page never is", () => {
    // Both were `routes: 0` before this rule existed, so a caller could not tell
    // a POINTLESS retry (host gone) from a FRUITLESS one (static page) — the
    // same false-success class as the exa `origin_down` fix.
    expect(capturedNothing(0, 0)).toBe(true);      // swapi.dev: no DNS record
    expect(capturedNothing(1, 544)).toBe(false);   // example.com: live
  });

  test("a static page brings at least its own document, so this cannot misfire", () => {
    expect(capturedNothing(1, 0)).toBe(false);     // document only, empty body
    expect(capturedNothing(0, 120)).toBe(false);   // bytes but no recorded request
    expect(capturedNothing(60, 40_000)).toBe(false);
  });

  test("the token is the SHARED one, classified with no new vocabulary", () => {
    expect(isOriginUnreachableError("origin_down")).toBe(true);
    expect(isOriginUnreachableError(null)).toBe(false);
  });
});
