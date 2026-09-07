/**
 * GATE: the E2E harness reads the fields the binary actually emits.
 *
 * `tests/e2e/install-matrix.ts` judges a shipped binary by parsing its JSON. A
 * cell that reads a field the payload does not carry does not fail — it reads
 * `undefined`, quietly concludes "nothing happened", and reports a green or an
 * UNSTAMPED that was never earned. That is the worst failure mode available to a
 * test harness, because it looks exactly like success.
 *
 * It had already happened twice, and both were found by dumping a real payload
 * rather than by reading the harness:
 *
 *   1. `decision_trace` is a TOP-LEVEL array on the result. Three cells read
 *      `out.trace.decision_trace`, which does not exist, so the browser-fallback
 *      step count was 0 on every run no matter what the binary did — including
 *      during the double-open the cell exists to catch.
 *
 *   2. `browser_opened` lives at `timing.browser_opened`; only one orchestrator
 *      exit path hoists it to the top level. Cells reading only the top level
 *      compared `undefined` against `true` and could not distinguish "no browser
 *      opened" from "this shape does not carry the field".
 *
 * Observed top-level keys of a real `deferral` response:
 *   decision_trace, impact, intent_verdict, result, run_plan, source, timing, trace
 *
 * So: read through the shape-tolerant helpers, never the raw nested path.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HARNESS = join(import.meta.dirname, "e2e", "install-matrix.ts");
const src = readFileSync(HARNESS, "utf8");

/** The helper bodies legitimately mention both paths — judge the cells, not them. */
function cellBodies(text: string): string {
  const start = text.indexOf("const CELLS: Cell[]");
  expect(start, "CELLS array not found in the harness").toBeGreaterThan(0);
  return text.slice(start);
}

describe("the harness never reads a field the payload does not carry", () => {
  const cells = cellBodies(src);

  test("no cell reads the non-existent `trace.decision_trace`", () => {
    // The real field is top-level. This exact expression is what made the
    // never-twice guard unfalsifiable.
    expect(cells).not.toContain("trace).decision_trace");
    expect(cells).not.toContain("trace.decision_trace");
  });

  test("no cell reads `browser_opened` off the top level directly", () => {
    // `timing.browser_opened` is the orchestrator's own field; the top-level
    // copy exists on only one exit path. Going through the helper reads both.
    for (const wrong of ["out.browser_opened", "c.browser_opened", "w.browser_opened"]) {
      expect(cells, `${wrong} bypasses the shape-tolerant reader`).not.toContain(wrong);
    }
  });

  test("both shape-tolerant readers exist and consult BOTH locations", () => {
    // A helper that checks only one location is the original bug wearing a
    // helper's name, so assert on what it reads, not merely that it exists.
    const bo = src.slice(src.indexOf("const browserOpened ="), src.indexOf("const decisionTrace ="));
    expect(bo).toContain("out.browser_opened");
    expect(bo).toContain("timing");
    // Third location, and the one that matters most: the browse/capture shape
    // carries NEITHER boolean while genuinely driving a browser, so the reader
    // must also recognise a live browse session structurally.
    expect(bo).toContain("out.browse");
    expect(bo).toContain("tab_id");
    expect(bo).toContain("chrome_debug_url");

    const dt = src.slice(src.indexOf("const decisionTrace ="));
    const body = dt.slice(0, dt.indexOf("};") + 2);
    expect(body).toContain("out.decision_trace");
    expect(body).toContain("trace");
  });

  test("the cells that judge browser behaviour actually call the reader", () => {
    // Guards the reverse mistake: helpers added, cells never rewired.
    const calls = (cells.match(/browserOpened\(/g) ?? []).length;
    expect(calls, "expected several cells to read browser_opened via the helper").toBeGreaterThanOrEqual(4);
    expect(cells).toContain("decisionTrace(out)");
  });
});

describe("the harness cannot launder an unavailable check into a pass", () => {
  test("UNSTAMPED keeps the run non-zero", () => {
    // The doctrine's load-bearing line. If this exit condition is ever relaxed
    // to `failed.length > 0`, every unexercised invariant becomes silent green.
    expect(src).toContain("failed.length > 0 || unstamped.length > 0 ? 1 : 0");
  });

  test("a blocked install reports cells rather than throwing", () => {
    // It used to throw out of the module: a Bun stack trace, no cell list, no
    // evidence file — a run that said nothing about what was in question.
    expect(src).toContain("installBlocker");
    expect(src).toContain("no installed binary to judge");
  });
});
