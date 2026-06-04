import type { ProjectionOptions, ResponseSchema } from "../types/index.js";

// --- Entity Index (for normalized/decorator-pattern APIs) ---

/**
 * Build a lookup map from entityUrn → object for APIs that use
 * normalized entity references (LinkedIn Voyager, Facebook Graph, etc.).
 * Objects reference each other via "*fieldName" keys whose values are URNs.
 */
export function buildEntityIndex(items: unknown[]): Map<string, unknown> {
  const index = new Map<string, unknown>();
  for (const item of items) {
    if (item != null && typeof item === "object") {
      const urn = (item as Record<string, unknown>).entityUrn;
      if (typeof urn === "string") index.set(urn, item);
    }
  }
  return index;
}

/**
 * Auto-detect and build an entity index from a response that contains
 * an entityUrn-keyed array (e.g. `included[]`, `data.included[]`).
 * Returns null if no suitable array is found.
 */
export function detectEntityIndex(data: unknown): Map<string, unknown> | null {
  if (data == null || typeof data !== "object") return null;

  // Check common locations for normalized entity arrays
  const candidates: unknown[] = [];
  const obj = data as Record<string, unknown>;

  // Direct: { included: [...] }
  if (Array.isArray(obj.included)) candidates.push(obj.included);
  // Nested: { data: { included: [...] } }
  if (obj.data && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    if (Array.isArray(d.included)) candidates.push(d.included);
  }

  // Check if any candidate has entityUrn-keyed objects
  for (const arr of candidates) {
    const items = arr as unknown[];
    if (items.length < 2) continue;
    // Sample first few items to check for entityUrn
    const sample = items.slice(0, 5);
    const hasUrns = sample.filter(
      (i) => i != null && typeof i === "object" && typeof (i as Record<string, unknown>).entityUrn === "string"
    ).length;
    if (hasUrns >= sample.length * 0.5) {
      return buildEntityIndex(items);
    }
  }
  return null;
}

// --- Field Projection ---

/**
 * Walk a dot-notation path with [] array expansion.
 * e.g. "elements[].actor.name" expands across array items.
 */
export function resolvePath(obj: unknown, path: string, entityIndex?: Map<string, unknown>): unknown[] {
  const parts = path.split(".");
  let current: unknown[] = [obj];

  for (const part of parts) {
    const next: unknown[] = [];
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;

    for (const item of current) {
      if (item == null || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      let val = rec[key];

      // URN reference resolution: if direct lookup fails, check for "*key" reference
      if (val === undefined && entityIndex) {
        const ref = rec[`*${key}`];
        if (typeof ref === "string") {
          val = entityIndex.get(ref);
        }
      }

      if (val === undefined) continue;
      if (isArray && Array.isArray(val)) {
        next.push(...val);
      } else {
        next.push(val);
      }
    }
    current = next;
  }
  return current;
}

/**
 * Select only specified fields, rebuilding nested structure.
 */
export function project(data: unknown, fields: string[]): unknown {
  if (data == null) return data;
  if (Array.isArray(data)) return data.map((item) => project(item, fields));

  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const resolved = resolvePath(data, field);
    if (resolved.length === 0) continue;
    setNestedValue(result, field, resolved.length === 1 ? resolved[0] : resolved);
  }
  return result;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").map((p) => (p.endsWith("[]") ? p.slice(0, -2) : p));
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Strip nulls, empty strings, empty arrays, and ephemeral keys.
 */
const EPHEMERAL_KEYS = new Set(["trackingId", "$type", "recipeType"]);
const EPHEMERAL_SUFFIXES = ["Urn"];

function isEphemeral(key: string): boolean {
  if (EPHEMERAL_KEYS.has(key)) return true;
  return EPHEMERAL_SUFFIXES.some((s) => key.endsWith(s));
}

export function compact(data: unknown, _opts?: { max_depth?: number }): unknown {
  if (data == null) return undefined;
  if (Array.isArray(data)) {
    const filtered = data.map((item) => compact(item, _opts)).filter((v) => v !== undefined);
    return filtered.length > 0 ? filtered : undefined;
  }
  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      if (isEphemeral(key)) continue;
      const compacted = compact(val, _opts);
      if (compacted !== undefined) result[key] = compacted;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  if (typeof data === "string" && data === "") return undefined;
  return data;
}

function truncateDepth(data: unknown, maxDepth: number, currentDepth = 0): unknown {
  if (currentDepth >= maxDepth) return typeof data === "object" && data !== null ? "[truncated]" : data;
  if (Array.isArray(data)) return data.map((item) => truncateDepth(item, maxDepth, currentDepth + 1));
  if (typeof data === "object" && data !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      result[key] = truncateDepth(val, maxDepth, currentDepth + 1);
    }
    return result;
  }
  return data;
}

/**
 * Orchestrate project + compact + max_depth truncation.
 */
export function applyProjection(data: unknown, projection: ProjectionOptions): unknown {
  let result = data;
  if (projection.fields && projection.fields.length > 0) {
    result = project(result, projection.fields);
  }
  if (projection.compact) {
    result = compact(result);
  }
  if (projection.max_depth != null) {
    result = truncateDepth(result, projection.max_depth);
  }
  return result;
}

// --- Schema Inference ---

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value; // string, boolean, object
}

function inferSingle(value: unknown): ResponseSchema {
  const t = typeOf(value);
  if (t === "null") return { type: "null", inferred_from_samples: 1 };
  if (t === "array") {
    const arr = value as unknown[];
    if (arr.length === 0) return { type: "array", inferred_from_samples: 1 };
    const itemSchemas = arr.map(inferSingle);
    return { type: "array", items: mergeSchemas(itemSchemas), inferred_from_samples: 1 };
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const properties: Record<string, ResponseSchema> = {};
    for (const [key, val] of Object.entries(obj)) {
      properties[key] = inferSingle(val);
    }
    return {
      type: "object",
      properties,
      required: Object.keys(obj),
      inferred_from_samples: 1,
    };
  }
  return { type: t, inferred_from_samples: 1 };
}

function mergeSchemas(schemas: ResponseSchema[]): ResponseSchema {
  if (schemas.length === 0) return { type: "object", inferred_from_samples: 0 };
  if (schemas.length === 1) return schemas[0];

  const types = new Set(schemas.map((s) => s.type));
  if (types.size === 1 && types.has("object")) {
    return mergeObjectSchemas(schemas);
  }
  if (types.size === 1 && types.has("array")) {
    const itemSchemas = schemas.filter((s) => s.items).map((s) => s.items!);
    return {
      type: "array",
      items: itemSchemas.length > 0 ? mergeSchemas(itemSchemas) : undefined,
      inferred_from_samples: schemas.length,
    };
  }
  if (types.size === 1) {
    return { type: schemas[0].type, inferred_from_samples: schemas.length };
  }
  // Union type
  const unique = [...types].map((t) => ({ type: t, inferred_from_samples: schemas.length }));
  return { type: unique[0].type, anyOf: unique, inferred_from_samples: schemas.length };
}

function mergeObjectSchemas(schemas: ResponseSchema[]): ResponseSchema {
  const allKeys = new Set<string>();
  for (const s of schemas) {
    if (s.properties) Object.keys(s.properties).forEach((k) => allKeys.add(k));
  }
  const properties: Record<string, ResponseSchema> = {};
  const required: string[] = [];

  for (const key of allKeys) {
    const propSchemas = schemas
      .filter((s) => s.properties?.[key])
      .map((s) => s.properties![key]);
    properties[key] = mergeSchemas(propSchemas);
    // Required only if present in ALL samples
    if (propSchemas.length === schemas.length) required.push(key);
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    inferred_from_samples: schemas.length,
  };
}

/**
 * Infer JSON Schema draft-07 subset from 1+ response samples.
 */
export function inferSchema(samples: unknown[]): ResponseSchema {
  if (samples.length === 0) return { type: "object", inferred_from_samples: 0 };
  const schemas = samples.map(inferSingle);
  const merged = mergeSchemas(schemas);
  merged.inferred_from_samples = samples.length;
  return merged;
}
