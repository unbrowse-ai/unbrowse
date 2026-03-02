import { resolvePath, compact } from "./index.js";
import type { ExtractionRecipe } from "../types/index.js";

export interface RecipeResult {
  data: unknown[];
  _recipe: {
    source: string;
    items_before_filter: number;
    items_after_filter: number;
    fields_mapped: string[];
  };
}

/**
 * Apply an ExtractionRecipe to raw response data.
 * Returns null if the recipe cannot be applied — caller falls back to raw data.
 */
export function applyRecipe(data: unknown, recipe: ExtractionRecipe): RecipeResult | null {
  // Step 1: Resolve source path
  const sourceValues = resolvePath(data, recipe.source);
  if (sourceValues.length === 0) return null;

  let items: unknown[];
  if (sourceValues.length === 1 && Array.isArray(sourceValues[0])) {
    items = sourceValues[0] as unknown[];
  } else if (sourceValues.every(v => typeof v === "object" && v !== null)) {
    items = sourceValues;
  } else {
    return null;
  }

  const itemsBeforeFilter = items.length;

  // Step 2: Filter by field value
  if (recipe.filter) {
    const { field, equals, contains, in: inValues } = recipe.filter;
    items = items.filter(item => {
      if (item == null || typeof item !== "object") return false;
      const fieldValues = resolvePath(item, field);
      if (fieldValues.length === 0) return false;
      const val = fieldValues[0];
      if (typeof val !== "string") return false;
      if (equals != null) return val === equals;
      if (contains != null) return val.includes(contains);
      if (inValues != null) return inValues.includes(val);
      return true;
    });
  }

  // Step 3: Require non-null fields
  if (recipe.require && recipe.require.length > 0) {
    items = items.filter(item => {
      if (item == null || typeof item !== "object") return false;
      return recipe.require!.every(requiredField => {
        const vals = resolvePath(item, requiredField);
        return vals.length > 0 && vals[0] != null;
      });
    });
  }

  // Step 4: Map fields
  const outputFields = Object.keys(recipe.fields);
  const mapped = items.map(item => {
    const out: Record<string, unknown> = {};
    for (const [outputName, sourcePath] of Object.entries(recipe.fields)) {
      const vals = resolvePath(item, sourcePath);
      out[outputName] = vals.length === 1 ? vals[0] : vals.length > 1 ? vals : undefined;
    }
    return out;
  });

  // Step 5: Compact
  let result: unknown[] = mapped;
  if (recipe.compact) {
    result = mapped
      .map(item => compact(item))
      .filter(item => item != null) as unknown[];
  }

  return {
    data: result,
    _recipe: {
      source: recipe.source,
      items_before_filter: itemsBeforeFilter,
      items_after_filter: result.length,
      fields_mapped: outputFields,
    },
  };
}

/**
 * Validate an ExtractionRecipe before persisting it.
 * Returns an array of error strings (empty = valid).
 */
export function validateRecipe(recipe: unknown): string[] {
  const errors: string[] = [];
  const r = recipe as Record<string, unknown>;

  if (!r || typeof r !== "object") return ["recipe must be an object"];

  if (typeof r.source !== "string" || r.source.length === 0) {
    errors.push("recipe.source is required and must be a non-empty string");
  }

  if (!r.fields || typeof r.fields !== "object" || Object.keys(r.fields as object).length === 0) {
    errors.push("recipe.fields is required and must be a non-empty object");
  } else {
    for (const [key, val] of Object.entries(r.fields as Record<string, unknown>)) {
      if (typeof val !== "string") {
        errors.push(`recipe.fields["${key}"] must be a string (dot-path)`);
      }
    }
  }

  if (r.filter != null) {
    if (typeof r.filter !== "object") {
      errors.push("recipe.filter must be an object");
    } else {
      const f = r.filter as Record<string, unknown>;
      if (typeof f.field !== "string") errors.push("recipe.filter.field is required");
      if (f.equals != null && typeof f.equals !== "string") errors.push("recipe.filter.equals must be a string");
      if (f.contains != null && typeof f.contains !== "string") errors.push("recipe.filter.contains must be a string");
      if (f.in != null && (!Array.isArray(f.in) || !(f.in as unknown[]).every(v => typeof v === "string"))) {
        errors.push("recipe.filter.in must be an array of strings");
      }
    }
  }

  if (r.require != null) {
    if (!Array.isArray(r.require) || !(r.require as unknown[]).every(v => typeof v === "string")) {
      errors.push("recipe.require must be an array of strings");
    }
  }

  return errors;
}
