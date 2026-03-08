import type { ResponseSchema } from "../types/index.js";

/**
 * Walk a ResponseSchema and produce actionable --path / --extract hints
 * so agents can extract data on first try without trial-and-error.
 *
 * Strategy:
 * 1. Find the "best data array" — the deepest array-of-objects with the most fields
 * 2. Rank fields by usefulness (name semantics, type, presence ratio)
 * 3. Emit a ready-to-paste CLI command
 */

export interface ExtractionHint {
  /** Dot-path to the best data array (for --path) */
  path: string;
  /** Suggested --extract fields (alias:path format) */
  fields: string[];
  /** Number of properties in the data items */
  item_field_count: number;
  /** Confidence: "high" if clear data array, "medium" if heuristic, "low" if flat */
  confidence: "high" | "medium" | "low";
  /** Ready-to-paste CLI args string */
  cli_args?: string;
  /** Compact schema tree for orientation */
  schema_tree?: Record<string, string>;
}

interface ArrayCandidate {
  path: string;
  itemSchema: ResponseSchema;
  fieldCount: number;
  depth: number;
}

interface IntentProfile {
  preferredPaths: string[];
  discouragedPaths: string[];
  preferredFields: string[];
  discouragedFields: string[];
  wantsStructuredRecords: boolean;
}

function buildIntentProfile(intent?: string): IntentProfile {
  const text = intent?.toLowerCase() ?? "";
  const profile: IntentProfile = {
    preferredPaths: [],
    discouragedPaths: [],
    preferredFields: [],
    discouragedFields: [],
    wantsStructuredRecords: /\b(search|list|find|get|fetch|timeline|feed|trending)\b/.test(text),
  };

  if (/\b(repo|repos|repository|repositories|code|projects?)\b/.test(text)) {
    profile.preferredPaths.push("repositories", "repos", "results", "items", "data");
    profile.preferredFields.push("full_name", "name", "description", "stargazers_count", "stars", "language", "owner", "url");
    profile.discouragedPaths.push("accounts", "users", "hashtags", "topics");
  }

  if (/\b(post|posts|tweet|tweets|status|statuses|timeline|feed|thread|threads)\b/.test(text)) {
    profile.preferredPaths.push("statuses", "posts", "tweets", "timeline", "entries", "results");
    profile.preferredFields.push("content", "text", "body", "created_at", "url", "account", "username", "replies_count", "reblogs_count", "favourites_count");
    profile.discouragedPaths.push("accounts", "users", "people", "profiles", "hashtags");
  }

  if (/\b(person|people|user|users|profile|profiles|member|members|account|accounts)\b/.test(text)) {
    profile.preferredPaths.push("people", "users", "accounts", "profiles", "included", "elements");
    profile.preferredFields.push("name", "headline", "title", "public_identifier", "username", "handle", "url");
    profile.discouragedPaths.push("hashtags", "statuses", "posts");
  }

  if (/\b(trend|trending|topic|topics)\b/.test(text)) {
    profile.preferredPaths.push("trends", "topics", "timeline", "entries", "results", "data");
    profile.preferredFields.push("name", "query", "topic", "post_count", "tweet_volume", "url");
    profile.discouragedPaths.push("accounts", "users");
  }

  return profile;
}

/** Walk the schema tree and collect all array-of-objects paths */
function findArrayCandidates(
  schema: ResponseSchema,
  path: string,
  depth: number,
  results: ArrayCandidate[]
): void {
  if (schema.type === "array" && schema.items) {
    const items = schema.items;
    if (items.type === "object" && items.properties) {
      const fieldCount = Object.keys(items.properties).length;
      results.push({ path: path ? `${path}[]` : "[]", itemSchema: items, fieldCount, depth });
      // Also recurse into the item's nested arrays
      for (const [key, prop] of Object.entries(items.properties)) {
        const childPath = path ? `${path}[].${key}` : `[].${key}`;
        findArrayCandidates(prop, childPath, depth + 1, results);
      }
      return;
    }
    // Array of arrays or primitives — recurse into items
    if (items.type === "array") {
      findArrayCandidates(items, path ? `${path}[]` : "[]", depth + 1, results);
    }
    return;
  }

  if (schema.type === "object" && schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      findArrayCandidates(prop, childPath, depth + 1, results);
    }
  }
}

/** Score field importance by name semantics and type */
function scoreField(name: string, schema: ResponseSchema): number {
  let score = 0;
  const lower = name.toLowerCase();

  // Identity fields (most important)
  if (/^(id|name|title|label|slug)$/i.test(name)) score += 10;
  if (/^(url|link|href|uri)$/i.test(name)) score += 8;

  // Content fields
  if (/^(description|text|content|body|summary|bio)$/i.test(name)) score += 7;
  if (/^(email|username|handle|screen.?name)$/i.test(name)) score += 7;

  // Time fields
  if (/date|time|created|updated|start|end/i.test(lower)) score += 5;

  // Numeric metrics
  if (/count|total|price|amount|score|rating|likes|views|followers/i.test(lower)) score += 5;

  // Status/category
  if (/status|state|type|category|kind|tag/i.test(lower)) score += 4;

  // Location
  if (/city|address|location|lat|lng|geo|place|venue/i.test(lower)) score += 4;

  // Media
  if (/image|photo|avatar|thumbnail|cover|logo|icon/i.test(lower)) score += 3;

  // Type bonus: strings and numbers more useful than objects/arrays for extraction
  if (schema.type === "string" || schema.type === "integer" || schema.type === "number" || schema.type === "boolean") {
    score += 2;
  }

  // Penalize internal/tracking fields
  if (/urn|tracking|internal|hash|token|cursor|pagination|__/i.test(lower)) score -= 5;
  if (name.startsWith("$") || name.startsWith("_")) score -= 3;

  return score;
}

/** Pick the best data array from candidates */
function selectBestArray(candidates: ArrayCandidate[], intent?: string): ArrayCandidate | null {
  if (candidates.length === 0) return null;
  const profile = buildIntentProfile(intent);

  // Score each candidate
  const scored = candidates.map((c) => {
    let score = c.fieldCount * 2; // More fields = richer data
    // Prefer moderate depth (not too shallow, not too deep)
    if (c.depth >= 1 && c.depth <= 3) score += 5;
    if (c.depth === 0) score += 2; // Top-level array is ok too
    // Bonus for well-named paths
    const pathLower = c.path.toLowerCase();
    if (/data|results|items|entries|elements|records|list|feed|posts|events|users/i.test(pathLower)) {
      score += 8;
    }
    if (/included|nodes|edges/i.test(pathLower)) score += 6;
    for (const token of profile.preferredPaths) {
      if (pathLower.includes(token)) score += 14;
    }
    for (const token of profile.discouragedPaths) {
      if (pathLower.includes(token)) score -= 18;
    }
    const fieldNames = Object.keys(c.itemSchema.properties ?? {}).map((name) => name.toLowerCase());
    for (const token of profile.preferredFields) {
      if (fieldNames.includes(token.toLowerCase())) score += 7;
    }
    for (const token of profile.discouragedFields) {
      if (fieldNames.includes(token.toLowerCase())) score -= 8;
    }
    if (profile.wantsStructuredRecords && c.fieldCount < 3) score -= 12;
    if (fieldNames.length > 0 && fieldNames.every((name) => /^(link|title|label|text|value)$/i.test(name))) {
      score -= 16;
    }
    // Penalize tiny items (likely metadata, not data)
    if (c.fieldCount < 3) score -= 5;
    return { candidate: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.candidate ?? null;
}

/** Build a flat path tree summary for schema visualization */
export function schemaToTree(schema: ResponseSchema, maxDepth = 3): Record<string, string> {
  const tree: Record<string, string> = {};

  function walk(s: ResponseSchema, path: string, depth: number): void {
    if (depth > maxDepth) return;

    if (s.type === "object" && s.properties) {
      for (const [key, prop] of Object.entries(s.properties)) {
        const childPath = path ? `${path}.${key}` : key;
        if (prop.type === "array" && prop.items) {
          if (prop.items.type === "object" && prop.items.properties) {
            const count = Object.keys(prop.items.properties).length;
            tree[`${childPath}[]`] = `array<object> (${count} fields)`;
            walk(prop.items, `${childPath}[]`, depth + 1);
          } else {
            tree[`${childPath}[]`] = `array<${prop.items.type}>`;
          }
        } else if (prop.type === "object" && prop.properties) {
          const count = Object.keys(prop.properties).length;
          tree[childPath] = `object (${count} fields)`;
          walk(prop, childPath, depth + 1);
        } else {
          tree[childPath] = prop.type;
        }
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    tree["[]"] = `array<${schema.items.type}>`;
    if (schema.items.type === "object") {
      walk(schema.items, "[]", 1);
    }
  } else {
    walk(schema, "", 0);
  }

  return tree;
}

/**
 * Generate extraction hints from a response schema.
 * Returns null if the schema is too simple to need hints (flat object, small array).
 */
export function generateExtractionHints(
  schema: ResponseSchema,
  intent?: string
): ExtractionHint | null {
  // Simple schemas don't need hints
  if (schema.type !== "object" && schema.type !== "array") return null;
  const profile = buildIntentProfile(intent);

  if (schema.type === "object" && schema.properties) {
    for (const token of profile.preferredPaths) {
      const prop = schema.properties[token];
      if (prop?.type === "array" && (!prop.items || prop.items.type !== "object")) {
        return finalize({
          path: `${token}[]`,
          fields: [],
          item_field_count: 0,
          confidence: "medium",
        }, schema);
      }
    }
  }

  const candidates: ArrayCandidate[] = [];
  findArrayCandidates(schema, "", 0, candidates);

  // If no arrays found, only generate hints for large flat objects
  if (candidates.length === 0) {
    if (schema.type === "object" && schema.properties) {
      const propCount = Object.keys(schema.properties).length;
      if (propCount <= 5) return null; // Small flat object — no hint needed
    }
    if (schema.type === "object" && schema.properties) {
      const fields = Object.entries(schema.properties)
        .map(([name, prop]) => ({ name, score: scoreField(name, prop) }))
        .filter((f) => f.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((f) => f.name);
      if (fields.length >= 2) {
        return finalize({ path: "", fields, item_field_count: Object.keys(schema.properties).length, confidence: "low" }, schema);
      }
    }
    return null;
  }

  const best = selectBestArray(candidates, intent);
  if (!best) return null;

  // Rank fields within the best array's item schema
  const itemProps = best.itemSchema.properties ?? {};
  const scoredFields = Object.entries(itemProps)
    .map(([name, prop]) => ({ name, score: scoreField(name, prop), type: prop.type }))
    .sort((a, b) => b.score - a.score);

  // Pick top fields: all positive-scored fields up to 10, minimum 3
  const topFields = scoredFields
    .filter((f) => f.score > 0)
    .slice(0, 10)
    .map((f) => f.name);

  // If intent mentions specific terms, boost matching fields
  if (intent) {
    const intentWords = intent.toLowerCase().split(/\s+/);
    for (const field of scoredFields) {
      if (topFields.includes(field.name)) continue;
      const fieldLower = field.name.toLowerCase();
      if (intentWords.some((w) => fieldLower.includes(w) || w.includes(fieldLower))) {
        topFields.push(field.name);
      }
    }
  }

  if (topFields.length < 2) {
    // Fall back to first few primitive fields
    const primitiveFields = scoredFields
      .filter((f) => f.type === "string" || f.type === "integer" || f.type === "number")
      .slice(0, 5)
      .map((f) => f.name);
    if (primitiveFields.length < 2) return null;
    return finalize({
      path: best.path,
      fields: primitiveFields,
      item_field_count: best.fieldCount,
      confidence: "low",
    }, schema);
  }

  const confidence = best.fieldCount >= 5 ? "high" : best.fieldCount >= 3 ? "medium" : "low";
  return finalize({
    path: best.path,
    fields: topFields,
    item_field_count: best.fieldCount,
    confidence,
  }, schema);
}

/** Attach cli_args and schema_tree to a hint */
function finalize(hint: ExtractionHint, schema: ResponseSchema): ExtractionHint {
  hint.cli_args = hintsToCliArgs(hint);
  hint.schema_tree = schemaToTree(schema, 2);
  return hint;
}

/**
 * Build a ready-to-use CLI command string from extraction hints.
 */
export function hintsToCliArgs(hints: ExtractionHint): string {
  const parts: string[] = [];
  if (hints.path) {
    parts.push(`--path "${hints.path}"`);
  }
  if (hints.fields.length > 0) {
    parts.push(`--extract "${hints.fields.join(",")}"`);
  }
  parts.push("--limit 10");
  return parts.join(" ");
}
