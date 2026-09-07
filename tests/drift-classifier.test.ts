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

import { test, expect, beforeEach, afterEach } from "bun:test";
import { classifyDrift, detectGraphqlErrorEnvelope } from "../src/transform/drift-classifier.js";
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

// --- detectGraphqlErrorEnvelope ---
// Regression: bench-gate 010_anchor 2026-05-19 dockerhub
// api.scout.docker.com/v1/graphql returned {errors: [{message: "..."}]} with
// no data — schema_drift fired and hid the actual GraphQL error from the agent.

test("envelope: errors[] populated and data absent is an envelope, messages extracted", () => {
  const result = detectGraphqlErrorEnvelope({
    errors: [{ message: "unauthorized" }, { message: "missing input" }],
  });
  expect(result.is_envelope).toBe(true);
  expect(result.messages).toEqual(["unauthorized", "missing input"]);
});

test("envelope: errors[] populated and data null is still an envelope (graphql nulls data on full error)", () => {
  const result = detectGraphqlErrorEnvelope({
    errors: [{ message: "query rejected" }],
    data: null,
  });
  expect(result.is_envelope).toBe(true);
  expect(result.messages).toEqual(["query rejected"]);
});

test("envelope: data populated rules out envelope even when errors[] also present (partial-success graphql)", () => {
  const result = detectGraphqlErrorEnvelope({
    data: { user: { id: 1 } },
    errors: [{ message: "deprecated field used" }],
  });
  expect(result.is_envelope).toBe(false);
  expect(result.messages).toEqual([]);
});

test("envelope: errors must be a non-empty array", () => {
  expect(detectGraphqlErrorEnvelope({ errors: [] }).is_envelope).toBe(false);
  expect(detectGraphqlErrorEnvelope({ errors: "string-not-array" }).is_envelope).toBe(false);
  expect(detectGraphqlErrorEnvelope({}).is_envelope).toBe(false);
});

test("envelope: rejects non-object inputs (string, null, array)", () => {
  expect(detectGraphqlErrorEnvelope(null).is_envelope).toBe(false);
  expect(detectGraphqlErrorEnvelope(undefined).is_envelope).toBe(false);
  expect(detectGraphqlErrorEnvelope("error string").is_envelope).toBe(false);
  expect(detectGraphqlErrorEnvelope([{ message: "x" }]).is_envelope).toBe(false);
});

test("envelope: error objects without message field are skipped from extraction", () => {
  const result = detectGraphqlErrorEnvelope({
    errors: [
      { message: "good msg" },
      { code: "no_message_here" },
      "plain string instead of object",
    ],
  });
  expect(result.is_envelope).toBe(true);
  expect(result.messages).toEqual(["good msg"]);
});

// --- recordStaleEndpoint feedback loop for graphql_error_envelope ---
// Regression: bench-gate 010_anchor 2026-05-19 dockerhub kept ranking the
// known-broken graphql GET endpoint at score 36.6 across runs because the
// envelope failure was not fed back into the stale-endpoints store. The
// existing 401/403 path already records to stale-endpoints (see
// staleEndpointResult); the envelope path now does the same with a distinct
// reason so the agent can tell why the endpoint was hidden.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordStaleEndpoint, isEndpointStale, listStaleEndpoints, type StaleReason } from "../src/auth/stale-endpoints.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "stale-test-"));
  process.env.UNBROWSE_STALE_ENDPOINTS_PATH = join(tmp, "stale-endpoints.json");
});

afterEach(() => {
  delete process.env.UNBROWSE_STALE_ENDPOINTS_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

test("stale-record: graphql_error_envelope is an allowed reason and round-trips", () => {
  recordStaleEndpoint("hub.docker.com", "2dDqJBfd8VsJ4nB8BPB0J", 200, "unknown", undefined, "graphql_error_envelope");
  expect(isEndpointStale("hub.docker.com", "2dDqJBfd8VsJ4nB8BPB0J")).toBe(true);
  const all = listStaleEndpoints("hub.docker.com");
  expect(all.length).toBe(1);
  expect(all[0]?.reason).toBe<StaleReason>("graphql_error_envelope");
  expect(all[0]?.status).toBe(200);
});
