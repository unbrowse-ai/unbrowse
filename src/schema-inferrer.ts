/**
 * Schema Inferrer — Extract type shapes from JSON request/response bodies.
 *
 * Recursively walks JSON payloads to infer field names and types,
 * producing compact schema summaries for skill documentation.
 *
 * Based on patterns from gigahard's utils/schema.ts and
 * unbrowse-index's schema-compressor.ts.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface InferredSchema {
  /** Flat map of field → type for documentation (e.g. { "id": "string", "count": "number" }) */
  fields: Record<string, string>;
  /** Compact shape summary (e.g. "object{id,name,email}" or "array[object{id,title}]") */
  summary: string;
  /** Whether the top-level is an array */
  isArray: boolean;
  /** Number of items if array */
  arrayLength?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_SCHEMA_DEPTH = 3;
const MAX_FIELDS_PER_LEVEL = 10;
const MAX_SUMMARY_KEYS = 6;

// Fields to prioritize when truncating (these are most informative)
const PRIORITY_FIELDS = ["id", "name", "title", "type", "status", "email", "url", "key", "value", "data", "message", "error", "result", "results", "items", "total", "count"];

// ── Schema inference ──────────────────────────────────────────────────────

/**
 * Infer the type of a JSON value as a string.
 */
function inferType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array";
    const itemType = inferType(value[0]);
    return `array<${itemType}>`;
  }
  if (typeof value === "object") return "object";
  return typeof value; // "string", "number", "boolean"
}

/**
 * Recursively extract field → type mappings from a JSON object.
 * Limits depth and field count to keep schemas compact.
 */
function extractFields(
  obj: unknown,
  prefix: string,
  depth: number,
  result: Record<string, string>,
): void {
  if (depth > MAX_SCHEMA_DEPTH) return;
  if (obj === null || obj === undefined) return;

  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === "object" && obj[0] !== null) {
      extractFields(obj[0], prefix ? `${prefix}[]` : "[]", depth + 1, result);
    }
    return;
  }

  if (typeof obj !== "object") return;

  const entries = Object.entries(obj as Record<string, unknown>);

  // Prioritize important fields, then take the rest
  const sorted = entries.sort(([a], [b]) => {
    const aPriority = PRIORITY_FIELDS.indexOf(a.toLowerCase());
    const bPriority = PRIORITY_FIELDS.indexOf(b.toLowerCase());
    if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
    if (aPriority !== -1) return -1;
    if (bPriority !== -1) return 1;
    return 0;
  });

  let count = 0;
  for (const [key, value] of sorted) {
    if (count >= MAX_FIELDS_PER_LEVEL) break;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const type = inferType(value);
    result[fullKey] = type;
    count++;

    // Recurse into nested objects (not arrays — we already handle those above)
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      extractFields(value, fullKey, depth + 1, result);
    }
  }
}

/**
 * Generate a compact summary string for a JSON value.
 *
 * @example
 * summarize({id: 1, name: "foo", email: "bar"})
 * // → "object{id,name,email}"
 *
 * summarize([{id: 1}, {id: 2}])
 * // → "array[2]<object{id}>"
 */
function summarize(value: unknown): string {
  if (value === null || value === undefined) return "null";

  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]";
    const itemSummary = summarize(value[0]);
    return `array[${value.length}]<${itemSummary}>`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "object{}";

    // Prioritize important keys
    const sorted = keys.sort((a, b) => {
      const aPriority = PRIORITY_FIELDS.indexOf(a.toLowerCase());
      const bPriority = PRIORITY_FIELDS.indexOf(b.toLowerCase());
      if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
      if (aPriority !== -1) return -1;
      if (bPriority !== -1) return 1;
      return 0;
    });

    const shown = sorted.slice(0, MAX_SUMMARY_KEYS);
    const suffix = keys.length > MAX_SUMMARY_KEYS ? `,+${keys.length - MAX_SUMMARY_KEYS}` : "";
    return `object{${shown.join(",")}}${suffix}`;
  }

  return typeof value;
}

/**
 * Infer a schema from a JSON payload.
 * Works for both request bodies and response bodies.
 *
 * @param json - The parsed JSON value
 * @returns Inferred schema with fields, summary, and array info
 */
export function inferSchema(json: unknown): InferredSchema {
  const fields: Record<string, string> = {};
  const isArray = Array.isArray(json);

  extractFields(json, "", 0, fields);

  return {
    fields,
    summary: summarize(json),
    isArray,
    arrayLength: isArray ? (json as unknown[]).length : undefined,
  };
}

/**
 * Safely parse a JSON string, returning null on failure.
 * Handles common edge cases (empty strings, HTML, etc.)
 */
export function safeParseJson(text: string | undefined | null): unknown | null {
  if (!text || text.length === 0) return null;

  // Skip obvious non-JSON (HTML, XML)
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html") || trimmed.startsWith("<?xml")) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Get top-level field names and types from a JSON object/array.
 * Returns a flat Record<string, string> suitable for documentation.
 *
 * For arrays, returns the fields of the first element.
 * Limits to MAX_FIELDS_PER_LEVEL entries.
 */
export function getTopLevelSchema(json: unknown): Record<string, string> | null {
  if (json === null || json === undefined) return null;

  let target = json;
  if (Array.isArray(json)) {
    if (json.length === 0) return null;
    target = json[0];
  }

  if (typeof target !== "object" || target === null) return null;

  const result: Record<string, string> = {};
  const entries = Object.entries(target as Record<string, unknown>);

  const sorted = entries.sort(([a], [b]) => {
    const aPriority = PRIORITY_FIELDS.indexOf(a.toLowerCase());
    const bPriority = PRIORITY_FIELDS.indexOf(b.toLowerCase());
    if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
    if (aPriority !== -1) return -1;
    if (bPriority !== -1) return 1;
    return 0;
  });

  let count = 0;
  for (const [key, value] of sorted) {
    if (count >= MAX_FIELDS_PER_LEVEL) break;
    result[key] = inferType(value);
    count++;
  }

  return result;
}

/**
 * Merge multiple schemas (from different request examples) into one.
 * Union of all fields; if a field has different types, mark as "mixed".
 */
export function mergeSchemas(schemas: Record<string, string>[]): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const schema of schemas) {
    for (const [key, type] of Object.entries(schema)) {
      if (!merged[key]) {
        merged[key] = type;
      } else if (merged[key] !== type) {
        merged[key] = "mixed";
      }
    }
  }

  return merged;
}
