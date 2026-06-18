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

// ---------------------------------------------------------------------------
// The common cardinality interface — one gate for every DAG node.
// ---------------------------------------------------------------------------
// Mirrors the proof/ledger layer's verify*(subject, expectation): boolean
// convention (verifyDelta / verifyDescent / verifyCommitmentAgainstResponse /
// verifyPublished). There the subject is a commitment + a root; here it is an
// intent + a tagged subject, and the "expectation" is the cardinality invariant
// (Ezekiel 47:10): a net is satisfiable only by many fish. Every resolve→execute
// →extract node calls THIS, never an ad-hoc predicate — one source of truth, one
// shape. true = compatible (admit); false = cardinality mismatch (reject/escalate).

/** A route's shape for cardinality purposes — the minimal endpoint surface. */
export interface RouteShape {
  url_template?: string;
  response_schema?: unknown;
}

/** True when a captured ROUTE yields a single item: a detail/product URL shape
 *  or trailing entity id; failing a URL signal, a single-item response schema.
 *  Listing/collection URL signals (/search, /q, /categories, ?q=…) win outright. */
export function routeLooksLikeSingleItem(route: RouteShape): boolean {
  const tmpl = route.url_template ?? "";
  let pathAndQuery = tmpl;
  try {
    const u = new URL(tmpl);
    pathAndQuery = `${u.pathname}${u.search}`;
  } catch {
    /* keep raw template */
  }
  const lower = pathAndQuery.toLowerCase();
  // Listing/collection path signals win outright — never a single item.
  if (
    /\/(?:search|q|categories?|browse|results?|listings|explore|discover|feed|catalog(?:ue)?|collections?|shop|all)\b/.test(lower) ||
    /[?&](?:q|query|keyword|keywords|search|term|category|cat|page)=/.test(lower)
  ) {
    return false;
  }
  // Detail/product URL shapes → single item.
  if (/\/(?:p|product|products|item|items|listing|detail|details|dp|pd|sku)\/[^/]+/.test(lower)) return true;
  const lastSeg = lower.split("?")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  if (/-\d{3,}$/.test(lastSeg) || /^\d{3,}$/.test(lastSeg)) return true; // slug-<id> or bare numeric id
  // A bare template hole with no detail signal → generic/list route, not single.
  if (/\{[^}]+\}/.test(lower)) return false;
  // Response-shape signal: a single schema.org record, not a collection.
  return schemaLooksLikeSingleItem(route.response_schema);
}

/** URL-path list signal (the context twin of {@link isListLikeIntent}): a page
 *  whose path is a search/results/browse surface implies a collection intent
 *  even when the intent text is terse. */
export function urlPathLooksListLike(contextUrl?: string): boolean {
  if (!contextUrl) return false;
  try {
    const pathname = new URL(contextUrl).pathname.toLowerCase();
    return /\/(?:search|basic-search|result-page|results?|discover|browse|categories?|q|listings|feed|catalog(?:ue)?)\b/.test(pathname);
  } catch {
    return false;
  }
}

/** The subject of a cardinality check, tagged by what it is. One union so the
 *  gate is polymorphic over the three things a DAG node ever holds. */
export type CardinalitySubject =
  | { kind: "value"; value: unknown }     // a resolved / extracted VALUE
  | { kind: "schema"; schema: unknown }   // an endpoint response_schema
  | { kind: "route"; route: RouteShape }; // an endpoint (URL template + schema)

/**
 * THE cardinality gate. Does `subject` satisfy `intent`'s cardinality? A
 * list/search intent (a net — by intent text or by `opts.contextUrl` path) is
 * satisfiable only by a many-shaped subject; a detail intent admits anything.
 * Returns true = compatible (admit), false = mismatch (reject / escalate).
 */
export function cardinalityMatches(
  intent: string | undefined,
  subject: CardinalitySubject,
  opts?: { contextUrl?: string },
): boolean {
  const wantsMany = isListLikeIntent(intent) || urlPathLooksListLike(opts?.contextUrl);
  if (!wantsMany) return true;
  switch (subject.kind) {
    case "value":
      return !valueLooksLikeSingleItem(subject.value);
    case "schema":
      return !schemaLooksLikeSingleItem(subject.schema);
    case "route":
      return !routeLooksLikeSingleItem(subject.route);
  }
}

/**
 * The ledger-replay guard (thin alias over {@link cardinalityMatches}): a cached
 * resolution VALUE may be replayed for an intent only when their cardinality
 * agrees. `data` is the resolved payload (the `.result`/`.data` of an envelope).
 */
export function resolutionCardinalityMatches(intent: string | undefined, data: unknown): boolean {
  return cardinalityMatches(intent, { kind: "value", value: data });
}
