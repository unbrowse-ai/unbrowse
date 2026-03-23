import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const configPath = path.join(ROOT, ".release-it.json");

describe("release config", () => {
  test("disables release-it npm plugin when bumper owns version writes", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.npm).toBe(false);
    expect(config.plugins["@release-it/bumper"].out).toEqual([
      "package.json",
      "packages/skill/package.json",
      "version.json",
    ]);
  });
});
