import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("eval command contract", () => {
  it("exposes one canonical public stack and one fuller auth stack", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};

    expect(scripts["eval:core"]).toBe(
      "npm run eval:retrieval && npm run eval:codex:product-success && npm run eval:codex:webarena && npm run eval:webarena:verified:stable",
    );
    expect(scripts["eval:full"]).toBe(
      "npm run eval:core && npm run eval:codex:auth",
    );
    expect(scripts["eval:codex:product-success"]).toBe(
      "UNBROWSE_FORCE_CAPTURE=0 bun evals/codex-autonomous-harness.ts --cases evals/codex-cases.product-success.json --restart-server",
    );
    expect(scripts["eval:codex:webarena"]).toBe(
      "UNBROWSE_FORCE_CAPTURE=0 bun evals/codex-auth-runner.ts --cases evals/codex-cases.webarena.json --benchmark --restart-server",
    );
    expect(scripts["eval:webarena:verified:stable"]).toBe(
      "bun scripts/eval-webarena-verified.ts --task-ids 11,15,21,25,28,29",
    );
    expect(scripts["eval:codex:auth"]).toBe(
      "bun evals/codex-auth-runner.ts --restart-server",
    );
    expect(scripts["eval:release:public"]).toBe("npm run eval:core");
    expect(scripts["eval:release:full"]).toBe("npm run eval:full");
  });
});
