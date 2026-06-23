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

/** A page's path-template if it is an ENTITY-DETAIL pointer — a path carrying a
 *  variable id/slug segment (`/p/risoles-138534`, `/product/{id}`, a uuid, a
 *  `-12345` suffix). Returns null for fixed-category nav (`/store/apps`). The id
 *  segment is masked so sibling item links collapse to one template. */
export function entityPointerTemplate(href: string): string | null {
  let path = href;
  try {
    path = new URL(href, "https://_").pathname;
  } catch {
    path = href.split("?")[0];
  }
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return null;
  const shape: string[] = [];
  let hasId = false;
  for (const s of segs) {
    const low = s.toLowerCase();
    if (/\d{3,}/.test(low) || low.length > 30 || /^[0-9a-f-]{8,}$/.test(low) || /-\d{2,}$/.test(low)) {
      shape.push("{id}");
      hasId = true;
    } else {
      shape.push(low);
    }
  }
  return hasId ? shape.slice(0, 3).join("/") : null;
}

/** Structural collection signal (the net, Ezekiel 47:10): do these link hrefs
 *  form a NET OF POINTERS to entity detail pages? A listing page links to many
 *  same-template detail holes (each with a variable id); a nav/landing page links
 *  to a few fixed-category pages. True when the largest same-template
 *  entity-pointer group meets `min`. A list intent satisfied by such a page is
 *  STRUCTURALLY answered — a brittle token-overlap gate must not reject it. */
export function linksFormEntityCollection(hrefs: Iterable<string>, min = 4): boolean {
  const groups = new Map<string, number>();
  for (const href of hrefs) {
    const t = entityPointerTemplate(href);
    if (!t) continue;
    const n = (groups.get(t) ?? 0) + 1;
    if (n >= min) return true;
    groups.set(t, n);
  }
  return false;
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

/** Registrable host (eTLD+1-ish) of a URL or bare host — dependency-free twin of the
 *  orchestrator's registrableHost, kept here so the warm-peek fast path needs no heavy import. */
function registrableHostOf(input?: string | null): string | null {
  if (!input) return null;
  const host = (() => {
    try { return new URL(input).hostname; } catch { /* not a full URL */ }
    try { return new URL(`https://${input}`).hostname; } catch { return null; }
  })();
  if (!host) return null;
  return host.replace(/^www\./, "").split(".").slice(-2).join(".") || null;
}

/** Collect candidate record URLs from a resolved VALUE (a list of records or a single
 *  record), reading the conventional url/link fields. Shallow + bounded — the warm path. */
function collectRecordHosts(data: unknown): string[] {
  const out: string[] = [];
  const push = (rec: unknown): void => {
    if (!rec || typeof rec !== "object") return;
    const r = rec as Record<string, unknown>;
    for (const k of ["url", "link", "href", "source_url"]) {
      const v = r[k];
      const h = typeof v === "string" ? registrableHostOf(v) : null;
      if (h) out.push(h);
    }
  };
  if (Array.isArray(data)) for (const rec of data.slice(0, 20)) push(rec);
  else push(data);
  return out;
}

/**
 * The ledger-replay HOST guard (issue: cross-domain misroute). A cached resolution
 * VALUE may be replayed for an explicit target URL only when it is host-consistent:
 * when the request names a concrete registrable host and the cached value's records
 * ALL point to a DIFFERENT host (e.g. a github.com result cached under a reddit.com
 * request), the entry is a misroute and must be treated as a miss. Conservative —
 * returns true (admit) when there is no target host or the value carries no record
 * URL to anchor against, so only an unambiguous all-off-host value is rejected.
 * Structural recognition (host compare), not an allowlist.
 */
export function resolutionHostMatches(url: string | undefined, data: unknown): boolean {
  const reqHost = registrableHostOf(url);
  if (!reqHost) return true;
  const hosts = collectRecordHosts(data);
  if (hosts.length === 0) return true;
  return hosts.some((h) => h === reqHost);
}

// ── Concrete-resource-path shape (shared by the CLI cache gate and the orchestrator) ──
// Generalize by SHAPE, never a per-site allowlist: a URL names a CONCRETE resource
// when its pathname is non-root and its final segment is not a generic listing/feed
// word. Listing/collection/root URLs are NOT concrete, so the precision gates below
// leave them exactly as today.

/** A path leaf is a "concrete resource" unless it is a generic listing/feed word. */
export function isConcreteResourceLeaf(leaf: string): boolean {
  return (
    !!leaf &&
    !/^(search|explore|trending|tabs|home|for-you|foryou|latest|live|people|posts|videos)$/.test(
      leaf,
    )
  );
}

/** True when a URL names a concrete resource path (non-root, non-listing leaf). */
export function urlHasConcreteResourcePath(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    if (segments.length === 0) return false;
    const leaf = decodeURIComponent(segments[segments.length - 1] ?? "").toLowerCase();
    return isConcreteResourceLeaf(leaf);
  } catch {
    return false;
  }
}

/**
 * Path-coherence: a candidate path matches a requested path when, split on "/", they
 * have the same number of segments and every segment is either identical or the
 * candidate segment is a {hole} placeholder (e.g. /users/{name} matches /users/octocat;
 * /zen matches /zen; /users/{name} does NOT match /zen). Accepts full URLs or bare paths.
 */
export function pathCoherent(candidate: string, contextPath: string): boolean {
  const toPath = (s: string): string => {
    try { return new URL(s).pathname; } catch { return s; }
  };
  const decodeSeg = (s: string): string => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  const candSegments = toPath(candidate).split("/").filter(Boolean).map(decodeSeg);
  const ctxSegments = toPath(contextPath).split("/").filter(Boolean).map(decodeSeg);
  if (candSegments.length !== ctxSegments.length) return false;
  for (let i = 0; i < candSegments.length; i++) {
    const cand = candSegments[i] ?? "";
    const ctx = ctxSegments[i] ?? "";
    const isHole = /^\{[^}]*\}$/.test(cand);
    if (!isHole && cand !== ctx) return false;
  }
  return true;
}

/** Collect candidate record URLs from a resolved VALUE, reading conventional
 *  url/link/href/source_url/url_template fields. Mirror of collectRecordHosts. */
function collectRecordUrls(data: unknown): string[] {
  const out: string[] = [];
  const push = (rec: unknown): void => {
    if (!rec || typeof rec !== "object") return;
    const r = rec as Record<string, unknown>;
    for (const k of ["url", "link", "href", "source_url", "url_template"]) {
      const v = r[k];
      if (typeof v === "string" && v) out.push(v);
    }
  };
  if (Array.isArray(data)) for (const rec of data.slice(0, 20)) push(rec);
  else push(data);
  return out;
}

/**
 * The ledger-replay PATH guard. When the explicit target URL names a CONCRETE
 * resource (e.g. /zen, /users/octocat), a cached resolution VALUE may be replayed
 * only when it evidences that exact concrete path — i.e. some record URL is
 * path-coherent with the request. A host-only-matched stale hit (a github.com
 * feed cached under api.github.com/zen) is a misroute for a concrete path and is
 * treated as a miss so the resolver re-resolves the literal URL. Conservative:
 * returns true (admit) for non-concrete (listing/root) URLs, or when the value
 * carries no record URL to anchor against — only an unambiguous concrete-path
 * mismatch is rejected. Structural recognition (path-coherence), not an allowlist.
 */
export function resolutionPathMatches(url: string | undefined, data: unknown): boolean {
  if (!urlHasConcreteResourcePath(url)) return true;
  let contextPath = "";
  try { contextPath = new URL(url as string).pathname; } catch { return true; }
  const urls = collectRecordUrls(data);
  if (urls.length === 0) return true;
  return urls.some((u) => pathCoherent(u, contextPath));
}
