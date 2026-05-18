/**
 * Tests for the breaking-vs-additive drift classifier.
 *
 * Pinned cases come from the MCP bench-gate run 2026-05-17:
 *   - #017 Stack Exchange API: number → integer + added fields. Was
 *     flipping success:false; should now stay success:true with
 *     classification.is_breaking === false.
 *   - #022 x.com HomeTimeline: added grok_translated_post_with_availability,
 *     article_results. Forward-compat. Should NOT be breaking.
 *   - #030 PubMed: added title + url. Forward-compat. NOT breaking.
 *
 * Real BREAKING cases that the gate MUST still catch:
 *   - Removed field the agent depended on
 *   - Incompatible type change (string → array, etc.)
 *
 * No mocks. Pure-function unit tests against the real classifier.
 */

import { test, expect } from "bun:test";
import { classifyDrift } from "../src/transform/drift-classifier.js";
import type { DriftResult } from "../src/types/index.js";

function drift(input: Partial<DriftResult>): DriftResult {
  return {
    drifted: true,
    added_fields: input.added_fields ?? [],
    removed_fields: input.removed_fields ?? [],
    type_changes: input.type_changes ?? [],
  };
}

test("classify: added fields only is INFORMATIONAL (#022 x.com case)", () => {
  const c = classifyDrift(
    drift({ added_fields: ["grok_translated_post_with_availability", "article_results"] }),
  );
  expect(c.is_breaking).toBe(false);
  expect(c.additive_changes.added_fields.length).toBe(2);
  expect(c.breaking_changes.removed_fields.length).toBe(0);
});

test("classify: number → integer is INFORMATIONAL (#017 SO case)", () => {
  const c = classifyDrift(
    drift({
      type_changes: [
        { path: "view_count", was: "number", now: "integer" },
        { path: "answer_count", was: "number", now: "integer" },
      ],
    }),
  );
  expect(c.is_breaking).toBe(false);
  expect(c.additive_changes.compatible_type_changes.length).toBe(2);
  expect(c.breaking_changes.incompatible_type_changes.length).toBe(0);
});

test("classify: integer → number is INFORMATIONAL (same JS primitive)", () => {
  const c = classifyDrift(
    drift({ type_changes: [{ path: "rank", was: "integer", now: "number" }] }),
  );
  expect(c.is_breaking).toBe(false);
});

test("classify: null ↔ value is INFORMATIONAL (nullable sample variance)", () => {
  const c = classifyDrift(
    drift({
      type_changes: [
        { path: "optional_field", was: "null", now: "string" },
        { path: "another", was: "object", now: "null" },
      ],
    }),
  );
  expect(c.is_breaking).toBe(false);
  expect(c.additive_changes.compatible_type_changes.length).toBe(2);
});

test("classify: SO-style real drift (added + integer refinement) NOT breaking", () => {
  // The exact shape that flipped success:false on #017 SO.
  const c = classifyDrift(
    drift({
      added_fields: ["bounty_amount", "closed_date"],
      type_changes: [
        { path: "view_count", was: "number", now: "integer" },
        { path: "score", was: "number", now: "integer" },
      ],
    }),
  );
  expect(c.is_breaking).toBe(false);
});

test("classify: removed field IS breaking", () => {
  const c = classifyDrift(drift({ removed_fields: ["price"] }));
  expect(c.is_breaking).toBe(true);
  expect(c.breaking_changes.removed_fields).toEqual(["price"]);
});

test("classify: string → array IS breaking (incompatible JSON types)", () => {
  const c = classifyDrift(
    drift({ type_changes: [{ path: "tags", was: "string", now: "array" }] }),
  );
  expect(c.is_breaking).toBe(true);
  expect(c.breaking_changes.incompatible_type_changes.length).toBe(1);
});

test("classify: object → string IS breaking", () => {
  const c = classifyDrift(
    drift({ type_changes: [{ path: "metadata", was: "object", now: "string" }] }),
  );
  expect(c.is_breaking).toBe(true);
});

test("classify: array → object IS breaking", () => {
  const c = classifyDrift(
    drift({ type_changes: [{ path: "items", was: "array", now: "object" }] }),
  );
  expect(c.is_breaking).toBe(true);
});

test("classify: mixed breaking + additive surfaces both buckets", () => {
  const c = classifyDrift(
    drift({
      added_fields: ["new_field"],
      removed_fields: ["legacy_field"],
      type_changes: [
        { path: "count", was: "number", now: "integer" },
        { path: "tags", was: "array", now: "string" },
      ],
    }),
  );
  expect(c.is_breaking).toBe(true);
  expect(c.breaking_changes.removed_fields).toEqual(["legacy_field"]);
  expect(c.breaking_changes.incompatible_type_changes.length).toBe(1);
  expect(c.breaking_changes.incompatible_type_changes[0]?.path).toBe("tags");
  expect(c.additive_changes.added_fields).toEqual(["new_field"]);
  expect(c.additive_changes.compatible_type_changes.length).toBe(1);
});

test("classify: drifted but only additive returns is_breaking=false (#030 pubmed)", () => {
  const c = classifyDrift(
    drift({ added_fields: ["title", "url"] }),
  );
  expect(c.is_breaking).toBe(false);
});
