import type { ExtractionRecipe } from "../types/index.js";
import { detectEntityIndex } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuggestionResult {
  recipe: ExtractionRecipe;
  confidence: number;
  stats: {
    source_items: number;
    fields_found: number;
    heterogeneous: boolean;
    dominant_type?: string;
    dominant_type_count?: number;
  };
}

interface CandidateArray {
  path: string;
  items: unknown[];
  length: number;
  depth: number;
  score: number;
}

interface HeterogeneityResult {
  heterogeneous: boolean;
  discriminator?: string;
  dominant_value?: string;
  dominant_count?: number;
  total_items: number;
}

interface ScoredField {
  path: string;
  alias: string;
  score: number;
  type: string;
  presence: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WELL_KNOWN_ARRAYS = new Set([
  "data", "items", "results", "entries", "records", "elements", "hits",
  "nodes", "edges", "list", "rows", "objects", "values", "content",
  "feed", "posts", "users", "messages", "included", "collection",
  "response", "articles", "comments", "notifications", "events",
]);

/** Arrays that are typically metadata/config, not primary content */
const METADATA_ARRAYS = new Set([
  "feedbackactions", "actions", "feedback", "errors", "warnings",
  "extensions", "metadata", "headers", "cookies", "params", "options",
  "permissions", "scopes", "features", "flags", "configs", "settings",
]);

const DISCRIMINATOR_NAMES = [
  "$type", "__typename", "type", "kind", "entityType",
  "objectType", "_type", "class", "category", "recordType",
];

const NAME_BONUSES: Record<string, number> = {
  id: 15, name: 12, title: 12, text: 10, body: 10, content: 10,
  description: 8, summary: 8, url: 8, link: 8, href: 8,
  date: 6, time: 6, created: 6, updated: 6, published: 6, timestamp: 6,
  author: 6, user: 6, username: 6, creator: 6,
  count: 4, num: 4, total: 4, score: 4, rating: 4,
  image: 4, photo: 4, avatar: 4, thumbnail: 4,
  email: 4, phone: 4, address: 4, location: 4,
  status: 3, state: 3, type: 3, category: 3, tag: 3, label: 3,
  price: 5, amount: 5, currency: 4,
};

const EPHEMERAL_PATTERN = /^(trackingId|recipeType|\$type|\$recipeTypes|entityUrn|objectUrn|dashEntityUrn|_type|__typename|__ref|__id)$/;
const EPHEMERAL_VALUE_PATTERN = /^urn:|^[0-9a-f]{8}-[0-9a-f]{4}-/;
const EPHEMERAL_SUFFIXES = ["Urn", "TrackingId"];

const MAX_KEYS = 2000;
const MAX_DEPTH = 6;
const MAX_FIELD_DEPTH = 7;
const MAX_SAMPLE = 50;

// ---------------------------------------------------------------------------
// Phase 1: Find candidate arrays
// ---------------------------------------------------------------------------

function findCandidateArrays(data: unknown, intentWords: string[]): CandidateArray[] {
  const candidates: CandidateArray[] = [];
  let keysExamined = 0;

  function walk(obj: unknown, path: string, depth: number): void {
    if (keysExamined >= MAX_KEYS || depth > MAX_DEPTH) return;
    if (obj == null || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      const objectItems = obj.filter((item) => item != null && typeof item === "object" && !Array.isArray(item));
      if (objectItems.length >= 2) {
        const sample = objectItems.slice(0, 5);
        const avgFields = sample.reduce((sum, item) => sum + Object.keys(item as object).length, 0) / sample.length;

        // Detect metadata arrays — items with mostly short string values
        const avgStringLen = sample.reduce((sum, item) => {
          const vals = Object.values(item as Record<string, unknown>).filter((v) => typeof v === "string");
          return sum + (vals.length > 0 ? vals.reduce((s, v) => s + (v as string).length, 0) / vals.length : 0);
        }, 0) / sample.length;

        const pathSegment = path.split(".").pop() || "";
        const segLower = pathSegment.toLowerCase();
        // Item count: log scale to avoid huge arrays dominating
        let score = Math.min(Math.log2(objectItems.length + 1) * 8, 60);
        score += depth <= 2 ? 20 : depth <= 4 ? 10 : 0;
        score += avgFields > 8 ? 25 : avgFields > 3 ? 15 : 0;
        score += avgStringLen > 50 ? 20 : avgStringLen > 20 ? 10 : 0; // boost content-rich arrays
        if (WELL_KNOWN_ARRAYS.has(segLower)) score += 25;
        if (METADATA_ARRAYS.has(segLower)) score -= 40; // penalize known metadata arrays
        for (const w of intentWords) {
          if (segLower.includes(w)) score += 15;
        }

        candidates.push({
          path,
          items: objectItems.slice(0, MAX_SAMPLE),
          length: objectItems.length,
          depth,
          score,
        });
      }
      // Recurse into first few array items to find nested arrays
      for (const item of obj.slice(0, 3)) {
        if (item != null && typeof item === "object") {
          walk(item, path + "[]", depth + 1);
        }
      }
      return;
    }

    const entries = Object.entries(obj as Record<string, unknown>);
    for (const [key, val] of entries) {
      keysExamined++;
      if (keysExamined >= MAX_KEYS) return;
      const childPath = path ? `${path}.${key}` : key;
      walk(val, childPath, depth + 1);
    }
  }

  walk(data, "", 0);
  return candidates.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Phase 2: Detect heterogeneity
// ---------------------------------------------------------------------------

function detectHeterogeneity(items: unknown[]): HeterogeneityResult {
  const sample = items.slice(0, MAX_SAMPLE);
  const result: HeterogeneityResult = { heterogeneous: false, total_items: items.length };

  // Check preferred discriminator names first, then scan all string fields
  const fieldCandidates: string[] = [];

  for (const name of DISCRIMINATOR_NAMES) {
    const values = new Map<string, number>();
    let present = 0;
    for (const item of sample) {
      if (item == null || typeof item !== "object") continue;
      const val = (item as Record<string, unknown>)[name];
      if (typeof val === "string") {
        present++;
        values.set(val, (values.get(val) || 0) + 1);
      }
    }
    // Must have repeated values (enum-like, not unique identifiers)
    const hasRepeats = values.size < present * 0.7;
    if (present / sample.length >= 0.8 && values.size >= 2 && values.size <= 20 && hasRepeats) {
      fieldCandidates.push(name);
    }
  }

  // If no preferred names found, scan all string fields
  if (fieldCandidates.length === 0) {
    const allKeys = new Set<string>();
    for (const item of sample.slice(0, 10)) {
      if (item != null && typeof item === "object") {
        Object.keys(item as object).forEach((k) => allKeys.add(k));
      }
    }
    for (const key of allKeys) {
      if (DISCRIMINATOR_NAMES.includes(key)) continue; // already checked
      const values = new Map<string, number>();
      let present = 0;
      for (const item of sample) {
        if (item == null || typeof item !== "object") continue;
        const val = (item as Record<string, unknown>)[key];
        if (typeof val === "string") {
          present++;
          values.set(val, (values.get(val) || 0) + 1);
        }
      }
      // Must have repeated values — discriminators are enums, not unique fields
      const hasRepeats = values.size < present * 0.7;
      if (present / sample.length >= 0.8 && values.size >= 2 && values.size <= 15 && hasRepeats) {
        fieldCandidates.push(key);
        break; // take the first viable one
      }
    }
  }

  if (fieldCandidates.length === 0) return result;

  // Use the first (highest priority) discriminator
  const disc = fieldCandidates[0];
  const valueCounts = new Map<string, { count: number; avgFields: number }>();
  for (const item of sample) {
    if (item == null || typeof item !== "object") continue;
    const val = (item as Record<string, unknown>)[disc];
    if (typeof val !== "string") continue;
    const entry = valueCounts.get(val) || { count: 0, avgFields: 0 };
    entry.count++;
    const nonNullFields = Object.values(item as Record<string, unknown>).filter((v) => v != null).length;
    entry.avgFields = entry.avgFields + (nonNullFields - entry.avgFields) / entry.count; // running average
    valueCounts.set(val, entry);
  }

  // Find dominant type: most frequent, with richest fields as tiebreaker
  let dominant: { value: string; count: number; avgFields: number } | null = null;
  for (const [value, stats] of valueCounts) {
    if (!dominant || stats.count > dominant.count || (stats.count === dominant.count && stats.avgFields > dominant.avgFields)) {
      dominant = { value, count: stats.count, avgFields: stats.avgFields };
    }
  }

  if (dominant && dominant.count / sample.length >= 0.3 && valueCounts.size >= 2) {
    result.heterogeneous = true;
    result.discriminator = disc;
    result.dominant_value = dominant.value;
    result.dominant_count = dominant.count;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 3: Score fields
// ---------------------------------------------------------------------------

function isEphemeralField(name: string): boolean {
  if (EPHEMERAL_PATTERN.test(name)) return true;
  return EPHEMERAL_SUFFIXES.some((s) => name.endsWith(s));
}

function isEphemeralValue(val: unknown): boolean {
  return typeof val === "string" && EPHEMERAL_VALUE_PATTERN.test(val);
}

function typeOf(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (Array.isArray(val)) return "array";
  return typeof val;
}

const TYPE_BONUSES: Record<string, number> = {
  string: 10, number: 8, boolean: 5, object: 3, array: 2,
};

function nameBonus(fieldName: string): number {
  const lower = fieldName.toLowerCase();
  // Exact match
  if (NAME_BONUSES[lower]) return NAME_BONUSES[lower];
  // Partial match — field contains a known word
  let best = 0;
  for (const [word, bonus] of Object.entries(NAME_BONUSES)) {
    if (lower.includes(word) && bonus / 2 > best) best = bonus / 2;
  }
  return best;
}

function collectFields(items: unknown[], intentWords: string[], maxDepth = MAX_FIELD_DEPTH, entityIndex?: Map<string, unknown> | null): ScoredField[] {
  const fieldStats = new Map<string, { count: number; types: Map<string, number>; ephemeralValues: number; depth: number }>();

  function walkItem(obj: unknown, path: string, depth: number): void {
    if (depth > maxDepth || obj == null || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      // Follow *-prefixed URN references transparently
      if (key.startsWith("*") && typeof val === "string" && entityIndex) {
        const resolved = entityIndex.get(val);
        if (resolved != null && typeof resolved === "object") {
          const refKey = key.slice(1); // strip the "*" prefix
          const refPath = path ? `${path}.${refKey}` : refKey;
          walkItem(resolved, refPath, depth + 1);
        }
        continue; // don't record the raw URN string as a field
      }

      const fieldPath = path ? `${path}.${key}` : key;
      const t = typeOf(val);

      if (t !== "null") {
        let stats = fieldStats.get(fieldPath);
        if (!stats) {
          stats = { count: 0, types: new Map(), ephemeralValues: 0, depth };
          fieldStats.set(fieldPath, stats);
        }
        stats.count++;
        stats.types.set(t, (stats.types.get(t) || 0) + 1);
        if (isEphemeralValue(val)) stats.ephemeralValues++;
      }

      // Recurse into objects (not arrays — too complex for field paths)
      if (t === "object") {
        walkItem(val, fieldPath, depth + 1);
      }
    }
  }

  for (const item of items) {
    walkItem(item, "", 0);
  }

  const total = items.length;
  const scored: ScoredField[] = [];

  for (const [path, stats] of fieldStats) {
    const presence = stats.count / total;
    const segments = path.split(".");
    const fieldName = segments[segments.length - 1];

    // Dominant type for this field
    let dominantType = "string";
    let maxTypeCount = 0;
    for (const [t, c] of stats.types) {
      if (c > maxTypeCount) { dominantType = t; maxTypeCount = c; }
    }

    let score = presence * 40;
    score += TYPE_BONUSES[dominantType] || 0;
    score += nameBonus(fieldName);
    if (isEphemeralField(fieldName)) score -= 30;
    if (stats.ephemeralValues / stats.count > 0.9) score -= 25;
    // Penalize ID-like string fields (hashes, internal IDs)
    if (fieldName.endsWith("_str") || fieldName.endsWith("Id") || fieldName === "rest_id") score -= 15;
    score -= stats.depth * 1.5;

    // Intent match
    for (const w of intentWords) {
      if (fieldName.toLowerCase().includes(w)) { score += 10; break; }
    }

    // Skip object/array fields — they're containers, not leaf values
    if (dominantType === "object" || dominantType === "array") continue;

    scored.push({
      path,
      alias: "", // filled in next step
      score,
      type: dominantType,
      presence,
    });
  }

  return scored.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Phase 4: Assemble recipe
// ---------------------------------------------------------------------------

function generateAlias(path: string, usedAliases: Set<string>): string {
  const segments = path.split(".");
  let alias: string;

  if (segments.length === 1) {
    alias = segments[0];
  } else if (segments.length === 2) {
    alias = segments.join("_");
  } else {
    // For deep paths, use meaningful segments:
    // e.g. "actor.name.text" → "actor_name" (drop trailing generic like "text")
    // e.g. "commentary.text.text" → "commentary"
    // e.g. "socialDetail.totalSocialActivityCounts.numLikes" → "num_likes"
    const generic = new Set(["text", "value", "data", "content", "result", "item", "node"]);
    const meaningful = segments.filter((s) => !generic.has(s.toLowerCase()));
    if (meaningful.length === 0) {
      // All segments are generic — use first + parent
      alias = segments.slice(0, 2).join("_");
    } else if (meaningful.length <= 2) {
      alias = meaningful.join("_");
    } else {
      // For very deep paths, just use the last meaningful segment
      alias = meaningful[meaningful.length - 1];
    }
  }

  // Clean up: remove $, camelCase to snake_case, lowercase
  alias = alias
    .replace(/^\$/, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();

  // Deduplicate
  if (usedAliases.has(alias)) {
    let i = 2;
    while (usedAliases.has(`${alias}_${i}`)) i++;
    alias = `${alias}_${i}`;
  }
  usedAliases.add(alias);
  return alias;
}

// ---------------------------------------------------------------------------
// Main: suggestExtraction
// ---------------------------------------------------------------------------

export function suggestExtraction(data: unknown, intent?: string): SuggestionResult | null {
  if (data == null || typeof data !== "object") return null;

  // If data is already a flat array of simple objects, no suggestion needed
  if (Array.isArray(data)) {
    if (data.length > 0 && data.length <= 100) {
      const sample = data.slice(0, 5);
      const allSimple = sample.every((item) => {
        if (item == null || typeof item !== "object" || Array.isArray(item)) return false;
        const keys = Object.keys(item as object);
        return keys.length <= 8 && keys.every((k) => {
          const v = (item as Record<string, unknown>)[k];
          return v == null || typeof v !== "object";
        });
      });
      if (allSimple) return null;
    }
  }

  const intentWords = (intent || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Phase 1: Find candidate arrays
  const candidates = findCandidateArrays(data, intentWords);
  if (candidates.length === 0) return null;

  const best = candidates[0];
  if (best.items.length < 2) return null;

  // Phase 2: Detect heterogeneity
  const hetero = detectHeterogeneity(best.items);

  // Filter items to dominant type if heterogeneous
  let filteredItems = best.items;
  if (hetero.heterogeneous && hetero.discriminator && hetero.dominant_value) {
    filteredItems = best.items.filter((item) => {
      if (item == null || typeof item !== "object") return false;
      return (item as Record<string, unknown>)[hetero.discriminator!] === hetero.dominant_value;
    });
    if (filteredItems.length < 2) filteredItems = best.items; // fallback if filter is too aggressive
  }

  // Build entity index for URN reference resolution (LinkedIn, Facebook, etc.)
  const entityIndex = detectEntityIndex(data);

  // Phase 3: Score fields (follows *-prefixed URN references when entity index is available)
  const scored = collectFields(filteredItems, intentWords, MAX_FIELD_DEPTH, entityIndex);
  // Exclude the discriminator field — it's redundant with the filter
  const discriminatorPath = hetero.discriminator || "";
  const topFields = scored
    .filter((f) => f.score > 20 && f.path !== discriminatorPath)
    .slice(0, 12);
  if (topFields.length === 0) return null;

  // Generate aliases
  const usedAliases = new Set<string>();
  for (const field of topFields) {
    field.alias = generateAlias(field.path, usedAliases);
  }

  // Phase 4: Assemble recipe
  const fields: Record<string, string> = {};
  for (const f of topFields) {
    fields[f.alias] = f.path;
  }

  // Require top 2 most present fields
  const requireCandidates = topFields.filter((f) => f.presence > 0.5).slice(0, 2);

  const recipe: ExtractionRecipe = {
    source: best.path,
    ...(hetero.heterogeneous && hetero.discriminator && hetero.dominant_value
      ? { filter: { field: hetero.discriminator, equals: hetero.dominant_value } }
      : {}),
    ...(requireCandidates.length > 0 ? { require: requireCandidates.map((f) => f.path) } : {}),
    fields,
    compact: true,
    description: `Auto-suggested: ${topFields.length} fields from ${best.path}[${best.length}]`,
  };

  // Confidence scoring
  let confidence = 0.5;
  if (best.length > 10) confidence += 0.1;
  if (topFields[0].presence > 0.9) confidence += 0.1;
  if (!hetero.heterogeneous) confidence += 0.1;
  if (best.depth <= 2) confidence += 0.1;
  if (intentWords.length > 0 && topFields.some((f) => intentWords.some((w) => f.path.toLowerCase().includes(w)))) confidence += 0.1;
  confidence = Math.min(confidence, 0.95);

  return {
    recipe,
    confidence,
    stats: {
      source_items: best.length,
      fields_found: topFields.length,
      heterogeneous: hetero.heterogeneous,
      ...(hetero.dominant_value ? { dominant_type: hetero.dominant_value } : {}),
      ...(hetero.dominant_count ? { dominant_type_count: hetero.dominant_count } : {}),
    },
  };
}
