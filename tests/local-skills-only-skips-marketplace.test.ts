// FALSIFIER for the local_skills_only flag that lets the 404-recovery
// path skip the 2500ms marketplace round-trip.
//
// Pre-fix: every recovery resolveAndExecute waited up to 2500ms for the
// marketplace search whose result it would ignore (it already had the
// failed skill object in hand). 2.5s of pure latency tax on every
// stale-404 retry.
// Post-fix: ExecutionOptions.local_skills_only short-circuits the
// marketplace branch in the orchestrator. The recovery caller in
// api/routes.ts opts in by passing the flag.
//
// Structural tests — the full integration would require booting the
// orchestrator + a mock marketplace backend. The shape is what we
// pin here; the timing claim is implied by the source-level skip.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("local_skills_only flag end-to-end", () => {
  test("ExecutionOptions declares local_skills_only as an optional boolean", () => {
    const src = readFileSync(join(repoRoot, "src", "types", "skill.ts"), "utf8");
    expect(src).toMatch(/local_skills_only\?\:\s*boolean/);
    // Documented with why ("recovery", "marketplace", or "latency tax")
    const idx = src.indexOf("local_skills_only");
    const context = src.slice(Math.max(0, idx - 600), idx);
    expect(context).toMatch(/recovery|marketplace|2500ms|latency/i);
  });

  test("orchestrator's marketplace branch is gated on !options?.local_skills_only", () => {
    const src = readFileSync(join(repoRoot, "src", "orchestrator", "index.ts"), "utf8");
    // The forceCapture gate has been widened to also accept the new
    // flag — the marketplace race only runs when BOTH are false.
    expect(src).toMatch(/!forceCapture\s*&&\s*!options\?\.local_skills_only/);
  });

  test("404-recovery in api/routes.ts passes local_skills_only: true", () => {
    const src = readFileSync(join(repoRoot, "src", "api", "routes.ts"), "utf8");
    // Carve out the stale-endpoint recovery block by its marker.
    const start = src.indexOf("Auto-recovery: if endpoint returned 404");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 3500);
    expect(block).toContain("local_skills_only: true");
  });

  test("orchestrator marketplace timeout is still env-tunable (UNBROWSE_RESOLVE_SEARCH_TIMEOUT_MS)", () => {
    // Sanity: the flag short-circuits the timed race; for non-recovery
    // callers the existing env knob remains the documented escape hatch.
    const src = readFileSync(join(repoRoot, "src", "orchestrator", "index.ts"), "utf8");
    expect(src).toContain("UNBROWSE_RESOLVE_SEARCH_TIMEOUT_MS");
  });
});
