/**
 * GATE: the api layer touches kuri only for the Chrome backend itself.
 *
 * `src/api/routes.ts` legitimately imports kuri as a VALUE — it still hosts the
 * Chrome backend, and that stays until Chrome support is dropped, which is a
 * product decision rather than a refactor. Everything else is accidental
 * coupling: a shared HAR shape and a broker-error helper that were only ever in
 * kuri's file by habit, and each one drags 2,543 lines of kuri into a module
 * that does not need a browser at all.
 *
 * So the boundary this pins is narrow and honest:
 *   - browse-session.ts and browse-index.ts import NOTHING from kuri
 *   - routes.ts keeps at most its single `* as kuri` value import
 *   - no file under src/api imports a kuri TYPE
 *
 * That is what makes kuri deletable-by-subtraction: when the last value import
 * goes, nothing is left holding it.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(import.meta.dirname, "..", "src", "api");
const read = (f: string) => readFileSync(join(API_DIR, f), "utf8");
const apiFiles = () => readdirSync(API_DIR).filter((f) => f.endsWith(".ts"));

/** Every `... from "<spec>"` import in a file, with whether it is type-only. */
function imports(text: string): Array<{ spec: string; typeOnly: boolean }> {
  return [...text.matchAll(/^\s*import\s+(type\s+)?([^;]*?)from\s+["']([^"']+)["']/gm)].map((m) => ({
    spec: m[3],
    // `import type {...}` or an inline `{ type X }` specifier
    typeOnly: Boolean(m[1]) || /\btype\s+[A-Za-z_]/.test(m[2] ?? ""),
  }));
}

const isKuri = (spec: string) => spec.includes("/kuri") || spec.endsWith("kuri/client.js");

describe("the api layer's kuri boundary", () => {
  test("browse-session.ts imports nothing from kuri", () => {
    const bad = imports(read("browse-session.ts")).filter((i) => isKuri(i.spec)).map((i) => i.spec);
    expect(bad, `browse-session.ts must not import kuri; found: ${bad.join(", ")}`).toEqual([]);
  });

  test("browse-index.ts imports nothing from kuri", () => {
    const bad = imports(read("browse-index.ts")).filter((i) => isKuri(i.spec)).map((i) => i.spec);
    expect(bad, `browse-index.ts must not import kuri; found: ${bad.join(", ")}`).toEqual([]);
  });

  test("NO file under src/api imports a kuri TYPE", () => {
    const offenders: string[] = [];
    for (const f of apiFiles()) {
      for (const i of imports(read(f))) {
        if (isKuri(i.spec) && i.typeOnly) offenders.push(`${f} -> ${i.spec}`);
      }
    }
    expect(
      offenders,
      `a kuri TYPE import pulls the whole kuri module into a file that needs no browser: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("routes.ts keeps at most its single value import (the Chrome backend)", () => {
    const kuriImports = imports(read("routes.ts")).filter((i) => isKuri(i.spec));
    expect(kuriImports.length).toBeLessThanOrEqual(1);
    if (kuriImports.length === 1) expect(kuriImports[0].typeOnly).toBe(false);
  });

  test("the scan actually reads the api layer (guards a vacuous pass)", () => {
    expect(apiFiles().length).toBeGreaterThan(3);
    expect(imports(read("routes.ts")).length).toBeGreaterThan(10);
  });
});
