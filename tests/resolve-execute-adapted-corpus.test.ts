import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adaptResolveExecuteCsv } from "../scripts/adapt-resolve-execute-csv.js";
import { normalizeHarnessCases } from "../evals/codex-harness-lib.js";

const ROOT = join(import.meta.dir, "..");
const DETAILS = join(ROOT, "evals", "resolve_execute_details.csv");
const SUMMARY = join(ROOT, "evals", "resolve_execute_summary.csv");
const OUT = join(ROOT, "evals", "codex-cases.resolve-execute-adapted.json");

describe("resolve-execute adapted corpus", () => {
  it("stays regenerated from the checked-in telemetry csv", () => {
    const generated = adaptResolveExecuteCsv(DETAILS, SUMMARY);
    const checkedIn = JSON.parse(readFileSync(OUT, "utf-8"));

    expect(checkedIn.meta.counts).toEqual(generated.meta.counts);
    expect(checkedIn.cases).toEqual(generated.cases);
    expect(checkedIn.known_gaps).toEqual(generated.known_gaps);
  });

  it("keeps successful rows runnable and failed rows explicit", () => {
    const raw = JSON.parse(readFileSync(OUT, "utf-8"));
    const cases = normalizeHarnessCases(raw);
    const knownGaps = Array.isArray(raw.known_gaps) ? raw.known_gaps : [];

    expect(cases.length).toBe(13);
    expect(knownGaps.length).toBe(7);

    const ids = new Set<string>();
    for (const testCase of cases) {
      expect(ids.has(testCase.id)).toBe(false);
      ids.add(testCase.id);
      expect(testCase.url.startsWith("https://")).toBe(true);
      expect(testCase.expected_fields.length).toBeGreaterThan(0);
      expect(testCase.validate?.terminal_ok).toEqual(["pass"]);
      expect(testCase.validate?.retrieval?.any_of?.[0]?.endpoint_id).toBeTruthy();
      expect(testCase.validate?.selection?.any_of?.[0]?.endpoint_id).toBeTruthy();
    }

    for (const gap of knownGaps) {
      expect(gap.expected_terminal).toEqual(["fail", "blocked"]);
      expect(typeof gap.source?.scenario_id).toBe("string");
    }
  });
});
