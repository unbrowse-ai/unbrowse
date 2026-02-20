import type { DriftResult, ResponseSchema } from "../types/index.js";
import { inferSchema } from "./index.js";

/**
 * Collect all field paths from a schema (dot-notation).
 */
function collectPaths(schema: ResponseSchema, prefix = ""): Map<string, string> {
  const paths = new Map<string, string>();
  if (schema.type === "object" && schema.properties) {
    for (const [key, val] of Object.entries(schema.properties)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      paths.set(fullPath, val.type);
      if (val.type === "object" && val.properties) {
        for (const [p, t] of collectPaths(val, fullPath)) {
          paths.set(p, t);
        }
      }
      if (val.type === "array" && val.items?.type === "object") {
        for (const [p, t] of collectPaths(val.items, `${fullPath}[]`)) {
          paths.set(p, t);
        }
      }
    }
  }
  return paths;
}

/**
 * Compare stored schema against a fresh response sample.
 * Returns added/removed fields and type changes.
 */
export function detectSchemaDrift(existing: ResponseSchema, newSample: unknown): DriftResult {
  const newSchema = inferSchema([newSample]);
  const oldPaths = collectPaths(existing);
  const newPaths = collectPaths(newSchema);

  const added_fields: string[] = [];
  const removed_fields: string[] = [];
  const type_changes: Array<{ path: string; was: string; now: string }> = [];

  for (const [path, type] of newPaths) {
    if (!oldPaths.has(path)) {
      added_fields.push(path);
    } else if (oldPaths.get(path) !== type) {
      type_changes.push({ path, was: oldPaths.get(path)!, now: type });
    }
  }
  for (const path of oldPaths.keys()) {
    if (!newPaths.has(path)) {
      removed_fields.push(path);
    }
  }

  return {
    drifted: added_fields.length > 0 || removed_fields.length > 0 || type_changes.length > 0,
    added_fields,
    removed_fields,
    type_changes,
  };
}
