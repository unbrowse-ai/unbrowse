import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("release build-info ordering", () => {
  it("generates build-info before building the shipped npm runtime", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "skill", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const prepack = pkg.scripts.prepack;

    expect(prepack).toContain("build-release-manifest.ts");
    expect(prepack).toContain("npm run build:runtime");
    expect(prepack.indexOf("build-release-manifest.ts")).toBeLessThan(prepack.indexOf("npm run build:runtime"));
  });

  it("does not regenerate build-info after the runtime bundle has already been built", () => {
    const preparePack = readFileSync(join(ROOT, "packages", "skill", "scripts", "prepare-pack.mjs"), "utf8");

    expect(preparePack).not.toContain("build-release-manifest.ts");
  });
});
