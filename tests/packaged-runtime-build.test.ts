import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TESTS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(TESTS_DIR, "..");

describe("packaged runtime build", () => {
  it("bundles src/client/index.ts without duplicate export errors", async () => {
    const outdir = mkdtempSync(join(tmpdir(), "unbrowse-client-build-"));

    try {
      const result = await Bun.build({
        entrypoints: [join(ROOT, "src/client/index.ts")],
        outdir,
        target: "node",
        format: "esm",
        external: ["@cascade-fyi/splits-sdk", "@solana/kit", "bs58"],
      });

      expect(result.success).toBe(true);
      expect(result.logs).toHaveLength(0);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
