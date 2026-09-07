/**
 * Day-4 (Luminaries) falsifiable signal for backend/scripts/mirror-prod-to-staging.ts.
 *
 * Asserts the backfill script is structurally one-way (prod -> staging). Fails red
 * if a future edit adds a --direction flag, env-driven namespace swap, or rewrites
 * the namespace constants such that prod could be written to. Also asserts the
 * script refuses to run without both API keys and exits cleanly (no stack trace).
 *
 * No mocks: real readFileSync + real Bun.spawn subprocess.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT_PATH = resolve(import.meta.dir, "..", "scripts", "mirror-prod-to-staging.ts");
const SRC_RAW = readFileSync(SCRIPT_PATH, "utf8");

// Strip /* block comments */ and // line comments so docstring prose like
// "There is no --direction flag" doesn't trip structural checks. We assert
// on EXECUTABLE source, not on the script's own documentation.
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove // line comments while sparing `http://` and `https://`.
  return noBlocks
    .split("\n")
    .map((line) => {
      // find first // not preceded by ":" (covers URL schemes) and not inside a string
      // simple heuristic: only strip if "//" is not immediately preceded by ":"
      const idx = line.search(/(^|[^:])\/\//);
      if (idx === -1) return line;
      // Re-find exact position of //
      const offset = line.indexOf("//", idx);
      if (offset === -1) return line;
      // Don't strip if preceded by ":"
      if (line[offset - 1] === ":") return line;
      return line.slice(0, offset);
    })
    .join("\n");
}

const SRC = stripComments(SRC_RAW);

describe("mirror-prod-to-staging: structural one-way invariant", () => {
  test("declares PROD_NAMESPACE exactly once with literal value 'skills-v2'", () => {
    const matches = SRC.match(/const\s+PROD_NAMESPACE\s*=\s*"([^"]+)"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe('const PROD_NAMESPACE = "skills-v2"');
  });

  test("declares STAGING_NAMESPACE exactly once with literal value 'staging-skills-v3'", () => {
    const matches = SRC.match(/const\s+STAGING_NAMESPACE\s*=\s*"([^"]+)"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe('const STAGING_NAMESPACE = "staging-skills-v3"');
  });

  test("no env override of namespace direction", () => {
    expect(SRC).not.toMatch(/process\.env\.PROD_NAMESPACE/);
    expect(SRC).not.toMatch(/process\.env\.STAGING_NAMESPACE/);
    expect(SRC).not.toMatch(/process\.env\s*\[\s*["']PROD_NAMESPACE["']\s*\]/);
    expect(SRC).not.toMatch(/process\.env\s*\[\s*["']STAGING_NAMESPACE["']\s*\]/);
  });

  test("no --direction / --reverse / --source / --dest CLI flag parsing in code", () => {
    // After comment-stripping, these flag tokens must not appear in executable source.
    expect(SRC).not.toMatch(/--direction\b/);
    expect(SRC).not.toMatch(/--reverse\b/);
    expect(SRC).not.toMatch(/--source\b/);
    expect(SRC).not.toMatch(/--dest\b/);
  });

  test("PROD namespace is never the destination of a write", () => {
    // The one-way invariant: PROD_KEY and PROD_NAMESPACE are never passed to a set/write.
    expect(SRC).not.toMatch(/edbSet\s*\(\s*PROD_KEY/);
    expect(SRC).not.toMatch(/edbSet\s*\([^)]*PROD_NAMESPACE/);
    // The literal "skills-v2" (PROD) must not co-occur on any line with a write token.
    const lines = SRC.split("\n");
    for (const line of lines) {
      const hasProd = /(?<!staging-)skills-v2/.test(line);
      if (!hasProd) continue;
      expect(line).not.toMatch(/\bedbSet\b|\/qdkv\/set\b|\/qdkv\/put\b/);
    }
  });

  test("staging is the only target of qdkv/set", () => {
    const setCalls = SRC.match(/\/qdkv\/set\b/g) ?? [];
    expect(setCalls.length).toBe(1);
    expect(SRC).toMatch(/edbSet\s*\(\s*STAGING_KEY!?\s*,\s*STAGING_NAMESPACE/);
  });

  test("retains updated_at idempotency anchor", () => {
    expect(SRC).toMatch(/updated_at/);
    expect(SRC).toMatch(/stagingUpd\s*>\s*prodUpd/);
  });
});

describe("mirror-prod-to-staging: dry-run env refusal", () => {
  test("exits 1 with refusal message when EMERGENTDB_PROD_API_KEY is unset", async () => {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "EMERGENTDB_PROD_API_KEY" || k === "EMERGENTDB_STAGING_API_KEY") continue;
      if (typeof v === "string") cleanEnv[k] = v;
    }

    const proc = Bun.spawn({
      cmd: ["bun", SCRIPT_PATH, "--dry-run"],
      env: cleanEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const combined = `${stdout}\n${stderr}`;

    expect(exitCode).toBe(1);
    expect(combined).toContain("EMERGENTDB_PROD_API_KEY");
    expect(combined).toContain("not set");

    // No stack trace from an uncaught throw: no `    at ...` frames, no "FATAL:".
    expect(combined).not.toMatch(/^\s{2,}at\s/m);
    expect(combined).not.toContain("FATAL:");
  });
});
