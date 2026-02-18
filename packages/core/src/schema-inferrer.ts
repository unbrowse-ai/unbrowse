/**
 * Schema Inferrer — Extract type shapes from JSON request/response bodies.
 *
 * Recursively walks JSON payloads to infer field names and types,
 * producing compact schema summaries for skill documentation.
 *
 * Also generates method names and descriptions from endpoint paths.
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

const PRIORITY_FIELDS = ["id", "name", "title", "type", "status", "email", "url", "key", "value", "data", "message", "error", "result", "results", "items", "total", "count"];

// ── Schema inference ──────────────────────────────────────────────────────

function inferType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array";
    const itemType = inferType(value[0]);
    return `array<${itemType}>`;
  }
  if (typeof value === "object") return "object";
  return typeof value;
}

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

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      extractFields(value, fullKey, depth + 1, result);
    }
  }
}

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

export function safeParseJson(text: string | undefined | null): unknown | null {
  if (!text || text.length === 0) return null;
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

// ── Method name generation ────────────────────────────────────────────────

/**
 * Singularize a simple English plural (projects → project, users → user).
 * Handles common patterns only — not a full NLP singularizer.
 */
function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 2) return word.slice(0, -1);
  return word;
}

/** Strip file extensions and characters invalid in JS identifiers, then camelCase. */
function sanitizeSegment(segment: string): string {
  // Remove file extensions (.json, .xml, .html, .php, etc.)
  let s = segment.replace(/\.\w+$/, "");
  // Split on non-alphanumeric (hyphens, dots, underscores, etc.) and camelCase join
  const parts = s.split(/[^a-zA-Z0-9]+/).filter(p => p.length > 0);
  if (parts.length === 0) return "";
  // Remove leading digits from each part
  const cleaned = parts.map(p => p.replace(/^\d+/, ""));
  return cleaned.filter(p => p.length > 0).map((p, i) => {
    if (i === 0) {
      // Lowercase first char only, preserve rest (keeps camelCase like "moduleList")
      return p.charAt(0).toLowerCase() + p.slice(1);
    }
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join("");
}

function toCamelCase(segments: string[]): string {
  return segments.map((s, i) => i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

/**
 * Generate a method name from HTTP method + normalized path.
 *
 * Examples:
 *   GET /v1/projects           → listProjects
 *   GET /v1/projects/{id}      → getProject
 *   GET /v1/users/me           → getMe
 *   POST /v1/projects          → createProject
 *   PUT /v1/projects/{id}      → updateProject
 *   DELETE /v1/projects/{id}   → deleteProject
 *   GET /v1/projects/{id}/members → listProjectMembers
 *   GET /v1/settings           → getSettings
 */
export function generateMethodName(method: string, normalizedPath: string): string {
  // Strip API version prefix and filter empty/param segments
  const segments = normalizedPath.split("/").filter(s => s.length > 0);
  const meaningful = segments.filter(s =>
    !s.startsWith("{") && !/^v\d+$/.test(s) && !/^\d{4}[-]\d{4}$/.test(s)
  );

  if (meaningful.length === 0) return method.toLowerCase();

  const lastRaw = meaningful[meaningful.length - 1];
  const last = sanitizeSegment(lastRaw) || lastRaw.replace(/[^a-zA-Z0-9]/g, "");
  if (!last) return method.toLowerCase();

  const hasTrailingParam = normalizedPath.endsWith("}");

  const m = method.toUpperCase();

  if (m === "GET") {
    if (hasTrailingParam) {
      return toCamelCase(["get", singularize(last)]);
    }
    if (last === "me" || last === "self" || last === "profile") {
      return toCamelCase(["get", last]);
    }
    // GET /projects → listProjects, GET /projects/{id}/members → listProjectMembers
    if (meaningful.length >= 2) {
      const parentRaw = meaningful[meaningful.length - 2];
      const parent = singularize(sanitizeSegment(parentRaw) || parentRaw.replace(/[^a-zA-Z0-9]/g, ""));
      if (parent) {
        return toCamelCase(["list", parent, last.charAt(0).toUpperCase() + last.slice(1)]);
      }
    }
    return toCamelCase(["list", last]);
  }

  if (m === "POST") {
    return toCamelCase(["create", singularize(last)]);
  }

  if (m === "PUT" || m === "PATCH") {
    return toCamelCase(["update", singularize(last)]);
  }

  if (m === "DELETE") {
    return toCamelCase(["delete", singularize(last)]);
  }

  return toCamelCase([method.toLowerCase(), last]);
}

/**
 * Generate a human-readable endpoint description from method + path + query params.
 *
 * Examples:
 *   GET /v1/projects           → "List projects"
 *   GET /v1/projects/{id}      → "Get project by projectId"
 *   POST /v1/projects          → "Create project"
 *   GET /v1/search?q=&page=    → "Search by q and page"
 */
export function generateEndpointDescription(
  method: string,
  normalizedPath: string,
  queryParams?: { name: string }[],
): string {
  const segments = normalizedPath.split("/").filter(s => s.length > 0);
  const meaningful = segments.filter(s => !s.startsWith("{") && !/^v\d+$/.test(s));
  const lastRaw = meaningful[meaningful.length - 1] || "resource";
  // For descriptions, strip file extensions but keep hyphens/spaces readable
  const last = lastRaw.replace(/\.\w+$/, "").replace(/[-_]/g, " ");
  const hasTrailingParam = normalizedPath.endsWith("}");

  const m = method.toUpperCase();

  // Extract path param name from trailing {param}
  const trailingParamMatch = normalizedPath.match(/\{([^}]+)\}$/);
  const paramName = trailingParamMatch?.[1];

  let desc: string;

  if (m === "GET") {
    if (hasTrailingParam && paramName) {
      desc = `Get ${singularize(last)} by ${paramName}`;
    } else if (last === "me" || last === "self" || last === "profile") {
      desc = `Get current user ${last}`;
    } else {
      desc = `List ${last}`;
    }
  } else if (m === "POST") {
    desc = `Create ${singularize(last)}`;
  } else if (m === "PUT" || m === "PATCH") {
    desc = `Update ${singularize(last)}${paramName ? ` by ${paramName}` : ""}`;
  } else if (m === "DELETE") {
    desc = `Delete ${singularize(last)}${paramName ? ` by ${paramName}` : ""}`;
  } else {
    desc = `${method} ${last}`;
  }

  if (queryParams && queryParams.length > 0) {
    const qNames = queryParams.map(q => q.name).slice(0, 3);
    desc += ` by ${qNames.join(" and ")}`;
  }

  return desc;
}
