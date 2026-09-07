// AC3 lane-04: when executeEndpoint sees response-schema drift on a
// previously successful capture, surface a `re_capture_after_drift`
// signal that tells the calling agent to invoke unbrowse_go in headful
// mode against the contextUrl so the substrate can re-learn the new
// shape. Headful is the LEARNING path, not the serving path.
//
// Pure-function tests over buildDriftRecaptureSignal. No mocks. The
// helper is called from src/execution/index.ts inside the existing
// detectSchemaDrift branch (line 3789-ish) after this fix lands.

import { describe, test, expect } from "bun:test";
import { buildDriftRecaptureSignal } from "../src/execution/drift-recapture-signal.ts";
import type { DriftResult } from "../src/types/skill.ts";

const STABLE_DRIFT: DriftResult = {
  drifted: false,
  added_fields: [],
  removed_fields: [],
  type_changes: [],
};

const TYPE_CHANGED: DriftResult = {
  drifted: true,
  added_fields: [],
  removed_fields: [],
  type_changes: [{ path: "items[].price", was: "number", now: "string" }],
};

const FIELDS_ADDED_REMOVED: DriftResult = {
  drifted: true,
  added_fields: ["items[].slug"],
  removed_fields: ["items[].deprecated_id"],
  type_changes: [],
};

const ENDPOINT_STUB = {
  endpoint_id: "test-ep",
  url_template: "https://example.com/api/items?q={q}",
  method: "GET",
} as const;

describe("buildDriftRecaptureSignal", () => {
  test("returns null when drift.drifted is false", () => {
    const result = buildDriftRecaptureSignal(STABLE_DRIFT, ENDPOINT_STUB, "https://example.com/items");
    expect(result).toBeNull();
  });

  test("returns a re_capture signal when type_changes is non-empty", () => {
    const result = buildDriftRecaptureSignal(TYPE_CHANGED, ENDPOINT_STUB, "https://example.com/items");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("re_capture_after_drift");
    expect(result?.reason).toBe("type_changes_detected");
    expect(result?.drift_summary.type_changes).toHaveLength(1);
  });

  test("returns a re_capture signal when fields added or removed", () => {
    const result = buildDriftRecaptureSignal(FIELDS_ADDED_REMOVED, ENDPOINT_STUB, "https://example.com/items");
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("fields_added_or_removed");
    expect(result?.drift_summary.added_fields).toEqual(["items[].slug"]);
    expect(result?.drift_summary.removed_fields).toEqual(["items[].deprecated_id"]);
  });

  test("next_action surfaces unbrowse_go with headless:false for the headful-as-learning semantic", () => {
    const result = buildDriftRecaptureSignal(TYPE_CHANGED, ENDPOINT_STUB, "https://example.com/items");
    expect(result?.next_action.tool).toBe("unbrowse_go");
    expect(result?.next_action.args.url).toBe("https://example.com/items");
    expect(result?.next_action.args.headless).toBe(false);
  });

  test("url defaults to endpoint url_template when contextUrl is missing", () => {
    const result = buildDriftRecaptureSignal(TYPE_CHANGED, ENDPOINT_STUB, undefined);
    expect(result?.url).toBe("https://example.com/api/items?q={q}");
  });

  test("url prefers contextUrl when both are present (substrate-respecting: caller's intent wins)", () => {
    const result = buildDriftRecaptureSignal(
      TYPE_CHANGED,
      ENDPOINT_STUB,
      "https://example.com/items?q=widget",
    );
    expect(result?.url).toBe("https://example.com/items?q=widget");
  });

  test("returns null when both contextUrl and url_template are absent (no actionable target)", () => {
    const result = buildDriftRecaptureSignal(
      TYPE_CHANGED,
      { endpoint_id: "x", method: "GET" } as Parameters<typeof buildDriftRecaptureSignal>[1],
      undefined,
    );
    expect(result).toBeNull();
  });
});
