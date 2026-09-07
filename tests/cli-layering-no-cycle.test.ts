/**
 * The CLI layering must point ONE way: cli.ts -> cli-v7, never back.
 *
 * Today it points both:
 *
 *   src/cli.ts        4,999 lines   flat public surface + 29 cmd* implementations
 *   src/cli-v7/      19,928 lines   94 files: kind-map, dispatch, _shared runtime,
 *                                   verb handlers — 29 of which import a cmd*
 *                                   body back out of cli.ts
 *
 * That is a dependency cycle, and it is why neither file can be deleted or
 * understood alone: the dispatch moved into cli-v7 and the bodies never
 * followed. `cli.ts` is what a user types (CLAUDE.md: "flat commands ARE the
 * public surface"); `cli-v7` is what the MCP tool names map to. Both are
 * load-bearing, so the fix is direction, not deletion.
 *
 * This guard is deliberately written BEFORE the move and is EXPECTED TO FAIL
 * until it lands. A refactor whose only witness is "the tests still pass" has
 * no witness at all — the tests passed before it started. This one is red now,
 * green when the cycle is gone, and red again the day someone adds a verb by
 * reaching back into cli.ts.
 *
 * It reads source as text through the sound scanner (tests/_source-scan.ts),
 * NOT a regex comment-strip: that strip once ate 28% of orchestrator/index.ts
 * and made a signal confidently report a hole as clean.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codeLinesOnly } from "./_source-scan.js";

const REPO = join(import.meta.dirname, "..");

/** Every .ts file under src/cli-v7, recursively. */
function v7Files(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) out.push(p);
    }
  };
  walk(join(REPO, "src", "cli-v7"));
  return out;
}

/** Files under src/cli-v7 that import from src/cli.ts, with the symbols pulled. */
function backImports(): Array<{ file: string; symbols: string[] }> {
  const hits: Array<{ file: string; symbols: string[] }> = [];
  for (const p of v7Files()) {
    const src = codeLinesOnly(readFileSync(p, "utf8"));
    // ../cli.js or ../../cli.js — the only ways up to src/cli.ts from cli-v7.
    const re = /import\s*\{([^}]*)\}\s*from\s*"(?:\.\.\/)+cli\.js"/g;
    const symbols: string[] = [];
    for (const m of src.matchAll(re)) {
      for (const s of m[1]!.split(",")) {
        const name = s.trim().replace(/^type\s+/, "");
        if (name) symbols.push(name);
      }
    }
    if (symbols.length > 0) hits.push({ file: p.slice(REPO.length + 1), symbols });
  }
  return hits;
}

describe("layering: cli-v7 never reaches back into cli.ts", () => {
  test("no file under src/cli-v7 imports from src/cli.ts", () => {
    const hits = backImports();
    // The failure message must name the work, not just assert a number — this
    // test's whole job is to be a checklist while the move is in progress.
    const detail = hits.map((h) => `${h.file} <- ${h.symbols.join(",")}`);
    expect({ files: hits.length, detail }).toEqual({ files: 0, detail: [] });
  });

  test("the forward direction is intact — cli.ts still drives cli-v7", () => {
    // Guards the opposite mistake: "breaking the cycle" by severing the layer
    // rather than reversing one edge would leave the flat surface dispatching
    // nothing. C.map-agree in scripts/surface-gate.ts covers the contract; this
    // covers the import that makes it reachable at all.
    const cli = codeLinesOnly(readFileSync(join(REPO, "src/cli.ts"), "utf8"));
    expect(cli).toContain('from "./cli-v7/dispatch/index.js"');
    expect(cli).toContain('from "./cli-v7/kind-map.js"');
  });
});

describe("the guard itself can fail", () => {
  test("the scanner finds a back-import when one exists", () => {
    // A guard that cannot fire is a green tick over an unchecked thing — the
    // exact defect that let "U-3 is closed" ship while 24 files escaped. Prove
    // the matcher works on a synthetic line rather than trusting it.
    const sample = 'import { cmdRun } from "../../cli.js";\nimport { x } from "./other.js";';
    const re = /import\s*\{([^}]*)\}\s*from\s*"(?:\.\.\/)+cli\.js"/g;
    const found = [...codeLinesOnly(sample).matchAll(re)].map((m) => m[1]!.trim());
    expect(found).toEqual(["cmdRun"]);
  });

  test("it does not match unrelated cli-ish imports", () => {
    const sample = [
      'import { a } from "./cli-runtime.js";',
      'import { b } from "../kind-map.js";',
      'import { c } from "./cli-v7/dispatch/index.js";',
    ].join("\n");
    const re = /import\s*\{([^}]*)\}\s*from\s*"(?:\.\.\/)+cli\.js"/g;
    expect([...codeLinesOnly(sample).matchAll(re)]).toEqual([]);
  });
});
