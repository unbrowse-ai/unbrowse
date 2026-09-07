/**
 * Classify a DriftResult as BREAKING vs INFORMATIONAL.
 *
 * Background: detectSchemaDrift reports ANY change between two
 * response-schema snapshots (added / removed / type-changed fields).
 * The original execute path treated all drift as a fatal signal
 * (`schema_drift_recapture_required`) and flipped `trace.success` to
 * false, even when the change was additive (a new optional field) or
 * a benign JSON-typing refinement (number → integer, both fit in JS's
 * Number primitive).
 *
 * The MCP-bench-gate run on 2026-05-17 surfaced three real-world
 * misfires:
 *   - #017 Stack Exchange API: number → integer on view_count,
 *     answer_count etc. plus added fields. The body was real and
 *     usable; success was flipped anyway.
 *   - #022 x.com HomeTimeline: the response added
 *     grok_translated_post_with_availability and article_results
 *     (forward-compat). The contracted fields all still served real
 *     data. success was flipped anyway.
 *   - #030 PubMed: server added title and url fields to the search
 *     row record. Again forward-compat; success was flipped anyway.
 *
 * This module is the policy layer that sits between detectSchemaDrift
 * (pure structural primitive) and the execute path (which flips
 * success). The principle is the classic API-evolution contract:
 *
 *   - REMOVING a field the agent's learned shape contained breaks
 *     downstream code that depends on that field. BREAKING.
 *   - CHANGING a field's type to an incompatible JSON type (string
 *     → array, object → string, array → object) breaks downstream
 *     code that parsed the old type. BREAKING.
 *   - ADDING a field the agent didn't see before is forward-compat;
 *     the learned shape stays a valid subset. INFORMATIONAL.
 *   - REFINING a type within the same JS runtime category
 *     (number ↔ integer, the only pair the inferSchema vocabulary
 *     produces that differs in name but not in JS handling) is JSON
 *     Schema's natural refinement. INFORMATIONAL.
 *   - NULL ↔ non-null on the same path is normal sample variance
 *     (the field is nullable; one sample was null, another had a
 *     value). INFORMATIONAL.
 *
 * No mocks, no heuristics over field names, no per-domain rules —
 * just the structural type vocabulary inferSchema already produces
 * (object, array, string, number, integer, boolean, null).
 */

import type { DriftResult } from "../types/index.js";

/** Pairs the JS runtime treats as the same primitive even though
 *  JSON Schema names them differently. */
const COMPATIBLE_TYPE_PAIRS = new Set<string>([
  "number|integer",
  "integer|number",
]);

/** Sample-variance pairs: a field is nullable; one sample saw null,
 *  another saw a real value. Not a contract break. */
function isNullableVariance(was: string, now: string): boolean {
  if (was === "null" && now !== "null") return true;
  if (now === "null" && was !== "null") return true;
  return false;
}

function isCompatibleTypeChange(was: string, now: string): boolean {
  if (was === now) return true;
  if (isNullableVariance(was, now)) return true;
  if (COMPATIBLE_TYPE_PAIRS.has(`${was}|${now}`)) return true;
  return false;
}

export interface DriftClassification {
  /** True only when the drift breaks the contract the agent learned. */
  is_breaking: boolean;
  /** All breaking changes the agent should know about; may be empty
   *  when is_breaking is false. */
  breaking_changes: {
    removed_fields: string[];
    incompatible_type_changes: Array<{ path: string; was: string; now: string }>;
  };
  /** Non-breaking drift — surface as info, never as failure. */
  additive_changes: {
    added_fields: string[];
    compatible_type_changes: Array<{ path: string; was: string; now: string }>;
  };
}

/**
 * Classify a DriftResult into breaking vs additive changes.
 * Pure function over the drift result; no side effects, no I/O.
 */
export function classifyDrift(drift: DriftResult): DriftClassification {
  const incompatible_type_changes = drift.type_changes.filter(
    (tc) => !isCompatibleTypeChange(tc.was, tc.now),
  );
  const compatible_type_changes = drift.type_changes.filter(
    (tc) => isCompatibleTypeChange(tc.was, tc.now),
  );
  const is_breaking =
    drift.removed_fields.length > 0 || incompatible_type_changes.length > 0;
  return {
    is_breaking,
    breaking_changes: {
      removed_fields: drift.removed_fields.slice(),
      incompatible_type_changes,
    },
    additive_changes: {
      added_fields: drift.added_fields.slice(),
      compatible_type_changes,
    },
  };
}

/**
 * Detect the GraphQL error-envelope response shape: `{ errors: [{message: "..."}], ... }`
 * with `data` absent or null. The captured schema for a GraphQL endpoint typically
 * has `data.<query>` populated from a successful capture; when the same endpoint
 * later returns an error envelope (auth gone, query no longer valid, server-side
 * failure), schema drift fires with `errors` / `errors[].message` added and the
 * `data` subtree removed — masking the actual GraphQL error behind a generic
 * "schema_drift_recapture_required". Real-world friction: bench-gate 010_anchor
 * 2026-05-19 dockerhub api.scout.docker.com/v1/graphql (status 200, body
 * `{ errors: [{message: ...}] }`) surfaced the drift error and hid the actual
 * server message. This helper lets the execute path surface the GraphQL error
 * message inline so the agent sees what the server actually said.
 *
 * Pure function. No I/O, no per-domain rules. Detects the structural pattern
 * any GraphQL server can produce.
 */
export function detectGraphqlErrorEnvelope(data: unknown): { is_envelope: boolean; messages: string[] } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { is_envelope: false, messages: [] };
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.errors) || obj.errors.length === 0) return { is_envelope: false, messages: [] };
  const hasData = "data" in obj && obj.data !== null && obj.data !== undefined;
  if (hasData) return { is_envelope: false, messages: [] };
  const messages = obj.errors
    .map((e) => (typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).message === "string"
      ? ((e as Record<string, unknown>).message as string)
      : null))
    .filter((m): m is string => !!m);
  return { is_envelope: true, messages };
}
