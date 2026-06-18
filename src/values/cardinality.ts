/**
 * cardinality — the net-vs-fish guard (Ezekiel 47:10, "the spreading of nets;
 * their fish after their kinds, exceeding many").
 *
 * A list/search intent is a *net*: it wants many pointers. A product/detail
 * resolution is a single *fish*. When the resolution ledger replays a single-item
 * value for a list-shaped intent, the cardinality is wrong — the net came back
 * with one fish. This module is the single source of truth for that judgement,
 * shared by the ledger-replay boundary (src/cli.ts) and the orchestrator's
 * per-endpoint eligibility gate (src/orchestrator/index.ts).
 *
 * Dependency-free on purpose: the CLI consults it on the warm fast path before the
 * orchestrator (and its heavy deps) ever load.
 */

/** Intent words that ask for a collection (a net), not a single record. */
const LIST_INTENT_RE =
  /\b(search|find|lookup|browse|discover|list(?:ings?)?|feed|catalog(?:ue)?)\b/i;

/** True when the intent text asks for many results rather than one record. */
export function isListLikeIntent(intent?: string): boolean {
  return LIST_INTENT_RE.test(intent ?? "");
}

const ITEM_SCHEMA_TYPES = new Set([
  "product", "offer", "article", "newsarticle", "blogposting", "recipe",
  "event", "place", "localbusiness", "jobposting", "book", "movie",
  "creativework", "person", "organization",
]);

const COLLECTION_KEYS = [
  "itemListElement", "items", "results", "products", "listings",
  "data", "edges", "hits", "records", "entries", "rows", "nodes",
];

/**
 * True when a resolved VALUE (the actual data a resolution returned) is a single
 * item rather than a collection. Conservative: only a clearly single commercial /
 * editorial record (schema.org item type, or a named+priced object) trips it.
 * An array, a collection container, or any object carrying an array-of-objects is
 * a list and is never flagged.
 */
export function valueLooksLikeSingleItem(value: unknown): boolean {
  if (value == null || Array.isArray(value) || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  // Explicit collection containers → a list.
  for (const key of COLLECTION_KEYS) {
    if (Array.isArray(obj[key])) return false;
  }
  // Any top-level array-of-objects property → list-ish.
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.some((x) => x !== null && typeof x === "object")) return false;
  }
  const atType = typeof obj["@type"] === "string" ? (obj["@type"] as string).toLowerCase() : "";
  const isItemType = ITEM_SCHEMA_TYPES.has(atType);
  const hasName = "name" in obj || "title" in obj || "headline" in obj;
  const hasPriceish = "offers" in obj || "price" in obj || "sku" in obj;
  return isItemType || (hasName && hasPriceish);
}

/**
 * True when a captured endpoint's RESPONSE SCHEMA describes a single item rather
 * than a collection. The schema twin of {@link valueLooksLikeSingleItem}: it reads
 * the inferred JSON-schema shape (type/properties) instead of a concrete value.
 */
export function schemaLooksLikeSingleItem(rs: unknown): boolean {
  if (!rs || typeof rs !== "object") return false;
  const schema = rs as { type?: string; properties?: Record<string, unknown> };
  if (schema.type === "array") return false; // top-level collection
  const props = schema.properties ?? {};
  for (const key of COLLECTION_KEYS) {
    if (key in props) return false;
  }
  for (const value of Object.values(props)) {
    if (
      value && typeof value === "object" &&
      (value as { type?: string }).type === "array" &&
      ((value as { items?: { type?: string } }).items?.type === "object")
    ) {
      return false;
    }
  }
  if (schema.type !== "object") return false;
  const hasType = "@type" in props;
  const hasName = "name" in props || "title" in props;
  const hasPriceish = "offers" in props || "price" in props || "sku" in props;
  return hasType || (hasName && hasPriceish);
}

/**
 * The ledger-replay guard: a cached resolution VALUE may be replayed for an intent
 * only when its cardinality matches. A list-shaped intent must not be answered by a
 * single-item value (the net-with-one-fish). `data` is the resolved payload (the
 * `.result`/`.data` field of a cached envelope).
 */
export function resolutionCardinalityMatches(intent: string | undefined, data: unknown): boolean {
  if (!isListLikeIntent(intent)) return true; // a single-item intent accepts a single item
  return !valueLooksLikeSingleItem(data);
}
