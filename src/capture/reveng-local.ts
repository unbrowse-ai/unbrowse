/**
 * reveng-local — the LOCAL endpoint-inference fallback.
 *
 * unbrowse's premise is "learn a site's internal API routes from real browsing, then
 * replay them". Until now that inference existed only server-side: when `/v1/reveng`
 * was unreachable (offline, no key, local-only, or a non-2xx — an observed HTTP 426
 * this week) `revengServerFirst` returned an EMPTY list and every observed request was
 * discarded. Four real JS-rendered sites were captured, 42/65/39 network entries were
 * seen, 428 KB of `data.europa.eu/api/hub/search/search` was downloaded, and ZERO
 * endpoints were published. This module is the fallback that stops that.
 *
 * ── How an API is recognised ────────────────────────────────────────────────────
 * By the SHAPE OF THE RESPONSE, never the spelling of the URL. Per the repo standing
 * rule (CLAUDE.md, "generalize — never a hard filter when a structural signal exists"):
 *
 *     a request is a DATA ENDPOINT iff its response body decodes to a structure
 *     containing an array of ≥2 like-shaped records (objects sharing keys).
 *
 * That one predicate does all the work, and it does it without knowing a single host
 * or path token:
 *   - `data.europa.eu/api/hub/search/search` is found because its body carries 80
 *     objects sharing {id, title, description, format, media_type, access_url} — the
 *     collection is NESTED, so the walk is a bounded tree walk, not a `.results` peek.
 *   - `careers.un.org/ds/filter-search-proto/` is found FOR FREE by the same predicate
 *     despite carrying no `/api/` anywhere.
 *   - `…/assets/main.js.map` is REJECTED despite carrying `/api/` in its path, because
 *     a sourcemap's arrays hold strings, not records.
 *   - HTML documents, fonts, images, CSS, JS, scalar config blobs, health checks and
 *     204s are rejected because none of them decode to a record collection.
 * Adding a new site or a new response shape requires zero new entries anywhere.
 *
 * The only literal-string tables in this file are three genuine PROTOCOL constants,
 * each labelled at its definition: the XSSI anti-hijack prefixes (`)]}'`, `for(;;);`),
 * the HTML `<script type=…json…>` data-block mechanism, and the set of HTTP methods
 * RFC 9110 defines as safe. None of them names a site, a vendor or an endpoint.
 *
 * ── Primary data vs telemetry ───────────────────────────────────────────────────
 * An analytics beacon also POSTs JSON, so "is JSON" cannot separate them. What does
 * separate them is DIRECTION: a beacon's collection is OUTBOUND in the request and
 * fire-and-forget (the response is an ack — `{"ok":true}`, or 204); a data endpoint's
 * collection is INBOUND and consumed. So the admission predicate reads the RESPONSE
 * only, which excludes the ordinary beacon outright, and the ranking adds the
 * information-gain ratio (response bytes ÷ request bytes) so that a chattier beacon
 * that does echo records back still sorts below the real payload. No hostname, no
 * `/collect|/track|/beacon` token list.
 *
 * ── Credentials ─────────────────────────────────────────────────────────────────
 * Descriptors produced here are persisted and are publishable, so no credential value
 * may survive into one. Three layers, all reusing what already exists:
 *   1. every emitted string is read off `obfuscateCaptureForReveng`'s output, not off
 *      the raw capture — the same veil the server-side path puts on the wire;
 *   2. the capture's own credentials are harvested (cookie jar, Authorization, CSRF,
 *      any `isSensitiveHeader`/`looksLikeSecret` value) and handed to the obfuscator as
 *      `opts.secrets`, which triggers its `scrubKnownSecrets` guarantee pass;
 *   3. `headers_template` and `proven_recipe` are never emitted at all — they are the
 *      two fields that have historically carried the cookie jar (see the note in
 *      src/publish/sanitize.ts) — and a final fail-closed sweep DROPS any descriptor in
 *      which a harvested secret still appears.
 *
 * ── Honesty ─────────────────────────────────────────────────────────────────────
 * A locally-inferred endpoint is a weaker evidential class than a server-verified one:
 * it was OBSERVED succeeding once inside someone's browser session, never REPLAYED
 * standalone, never corroborated across captures. So it ships `verification_status:
 * "unverified"`, `last_verified_at` unset, and a reliability/confidence band capped
 * well below the verified floor (`isVerifiedDurable` wants ≥0.9 + "verified").
 */
import { createHash } from "node:crypto";
import { obfuscateCaptureForReveng } from "./obfuscate.js";
import { documentEndpoint } from "./skill-doc.js";
import { isIndexableUrl } from "./indexable.js";
import { extractGraphQLOperationName, isSensitiveHeader } from "../values/header-classify.js";
import { looksLikeSecret } from "../publish/sanitize.js";
import { getRegistrableDomain } from "../domain.js";
import type { RawRequest } from "./index.js";
import type { EndpointDescriptor, ResponseSchema } from "../types/skill.js";
import { decodeProtobufBody } from "../protobuf/wire.js";

// ---------------------------------------------------------------------------
// Bounds. Real captures carry several ~400 KB JSON bodies; the walk must be
// linear-ish and must never be able to run away on a deep or cyclic structure.
// ---------------------------------------------------------------------------
/** Bodies above this are not parsed — a body this large is a download, not a route. */
const MAX_BODY_BYTES = 8_000_000;
/**
 * Tree-walk depth cap. Measured: the europa collection sits at depth 3, but a
 * modern SSR hydration blob buries its records far deeper — target.com's
 * category lists sit at depth 10-11 under
 * `props.dehydratedState.queries[n].state.data.slots.*.content.taxonomy`, and
 * Next.js `props.pageProps.*` routinely reaches 8+. At the old cap of 6 the
 * walk could only ever reach the shallow plumbing (experiment payloads,
 * footer-language lists), so the deep CONTENT was structurally unreachable and
 * a tracking blob won by default. The node ceiling below, not the depth cap, is
 * what bounds cost.
 *
 * Cost of going from 6 to 12, measured over nine real pages (184 KB - 1.4 MB):
 * 71ms -> 296ms total, worst single page 30ms -> 117ms. That is ~33ms per page
 * against a network fetch of ~2s, and it buys the records the fetch was for.
 */
const MAX_WALK_DEPTH = 12;
/** Hard ceiling on nodes visited per body, so one pathological body cannot stall a capture. */
const MAX_WALK_NODES = 40_000;
/** How many array elements are sampled when scoring homogeneity. */
const HOMOGENEITY_SAMPLE = 20;
/** A collection needs at least this many records. Two is a collection; one is a record. */
const MIN_RECORDS = 2;
/**
 * Minimum keys a record must carry. Deliberately LOW: `{id, name}` is a perfectly
 * legitimate data endpoint. Measured on the live europa route the discriminating
 * signals were record COUNT and HOMOGENEITY, not field richness — so richness is not
 * used as a gate, only (weakly) as a ranking term.
 */
const MIN_RECORD_FIELDS = 2;
/** Fraction of the union-of-keys an average record must carry to count as "like-shaped". */
const MIN_HOMOGENEITY = 0.5;
/** Cap on field names carried into a descriptor (schema + example_fields). */
const MAX_FIELDS = 64;
/** Cap on embedded `<script type=…json…>` blocks scanned in one HTML document. */
const MAX_EMBEDDED_BLOCKS = 12;
/** Cap on scalar leaves harvested from a response for the query-echo signal. */
const MAX_ECHO_SCALARS = 5_000;
/** Shortest string that can count as human-facing content. */
const MIN_HUMAN_TEXT_CHARS = 3;
/** A space-free string must beat this length before it can count as content. */
const MIN_HUMAN_WORD_CHARS = 8;
/** Cap on scalar leaves sampled when measuring content density. */
const MAX_DENSITY_SCALARS = 400;
/**
 * Weight retained by a collection with ZERO human-facing text. Deliberately
 * non-zero: a legitimate collection can be all-numeric (a price series, a set of
 * coordinates), so density DAMPENS a candidate rather than disqualifying it.
 * At 0.35 a telemetry blob must carry ~3x the records of a content list to
 * still outrank it.
 */
const ZERO_DENSITY_WEIGHT_FLOOR = 0.35;

/**
 * PROTOCOL CONSTANT (unavoidable). XSSI anti-JSON-hijacking prefixes: a server-side
 * convention that prepends an unparseable guard to a JSON body so a `<script src>`
 * cross-origin include cannot evaluate it. These bytes are part of the JSON transport
 * convention, not a site allowlist — they carry no host or route information, and
 * failing to strip them makes a real record collection look like unparseable text.
 */
const XSSI_PREFIXES = [")]}'\n", ")]}',\n", ")]}'", "for(;;);", "while(1);"];

/**
 * PROTOCOL CONSTANT (unavoidable). RFC 9110 §9.2.1 defines exactly these methods as
 * safe (no intended state change). `idempotency` is a two-valued field over that
 * definition; there is no structural substitute for a spec enumeration.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** A redaction placeholder produced by the obfuscator. Never emit one as a literal. */
const REDACTION_RE = /^\[(?:REDACTED|bound:[0-9a-f]+|secret-token|phone|sensitive-number)\]$/;

// ---------------------------------------------------------------------------
// Record-collection detection — the whole classifier.
// ---------------------------------------------------------------------------

/** A collection of like-shaped records found somewhere inside a decoded body. */
export interface RecordCollection {
  /** JSON path to the array, e.g. ["result", "results"] — [] means the body IS the array. */
  path: string[];
  /** Number of records in the array. */
  count: number;
  /** 0..1 — mean share of the union-of-keys that each sampled record carries. */
  homogeneity: number;
  /** Union of record keys, sorted, capped at MAX_FIELDS. */
  fields: string[];
  /** field → JSON primitive type, for the response schema. */
  fieldTypes: Record<string, string>;
  /**
   * 0..1 — share of sampled scalar values that read as human-facing content
   * (titles, names, prose) rather than machine plumbing (opaque ids, hashes,
   * enum tokens, flags). See {@link contentDensity}.
   */
  density: number;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Does this scalar read as something a human was meant to see?
 *
 * Structural, not lexical: we never look at the KEY (no `title|name|price`
 * allowlist, which would miss the next site's field names). We look at the
 * VALUE's shape. Human-facing copy carries letters and either whitespace or
 * enough length to not be a token; machine plumbing is opaque — `WEB-441442`,
 * `5xt0d`, `a3f9c1e2`, `add_to_cart`, `true`, `1`.
 */
function isHumanFacingScalar(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s.length < MIN_HUMAN_TEXT_CHARS) return false;
  if (!/[a-zA-Z]/.test(s)) return false;
  // Whitespace between word characters is the strongest single signal of prose.
  if (/\w\s+\w/.test(s)) return true;
  // A single long word can still be content, but a bare identifier/slug/hash
  // (no spaces, only id-safe punctuation) is plumbing however long it is.
  const identifierLike = /^[A-Za-z0-9_\-.:/]+$/.test(s);
  return !identifierLike && s.length > MIN_HUMAN_WORD_CHARS;
}

/**
 * Share of a collection's scalar leaves that are human-facing (see
 * {@link isHumanFacingScalar}). This is the term that separates a page's real
 * records from its telemetry: measured on live pages, target.com's A/B payload
 * (`{tid,pl,et}`) scores 0.00 while its category list scores 0.53, and both are
 * ~30 records — so COUNT alone cannot tell them apart, and did not.
 *
 * Scans one level into nested objects/arrays so a record that nests its copy
 * (`{author:{name}}`) is not scored as if it were empty.
 */
function contentDensity(sample: Array<Record<string, unknown>>): number {
  let human = 0;
  let total = 0;
  const consider = (value: unknown, depth: number): void => {
    if (total >= MAX_DENSITY_SCALARS) return;
    if (value === null || value === undefined) return;
    if (typeof value === "object") {
      if (depth >= 2) return;
      const inner = Array.isArray(value) ? value.slice(0, 5) : Object.values(value as object).slice(0, 12);
      for (const v of inner) consider(v, depth + 1);
      return;
    }
    total++;
    if (isHumanFacingScalar(value)) human++;
  };
  for (const rec of sample) for (const v of Object.values(rec)) consider(v, 0);
  return total === 0 ? 0 : human / total;
}

/**
 * Score one array as a candidate record collection. Returns null when the array is not
 * a collection of like-shaped records (an array of strings — e.g. a sourcemap's
 * `sources` — or of mixed junk, or too short, or too thin).
 */
function scoreArray(arr: unknown[], path: string[]): RecordCollection | null {
  if (arr.length < MIN_RECORDS) return null;
  const sample = arr.slice(0, HOMOGENEITY_SAMPLE).filter(isRecord);
  // Most of what we sampled must actually be records; an array of scalars is not a
  // collection of records no matter how long it is.
  if (sample.length < MIN_RECORDS) return null;
  if (sample.length / Math.min(arr.length, HOMOGENEITY_SAMPLE) < 0.8) return null;

  const union = new Map<string, string>();
  for (const rec of sample) {
    for (const [k, v] of Object.entries(rec)) {
      if (!union.has(k)) union.set(k, jsonType(v));
    }
  }
  if (union.size < MIN_RECORD_FIELDS) return null;

  let coverage = 0;
  for (const rec of sample) {
    let shared = 0;
    for (const k of Object.keys(rec)) if (union.has(k)) shared++;
    coverage += shared / union.size;
  }
  let homogeneity = coverage / sample.length;
  // Real result records often carry a wide optional-field tail (jobs are a
  // common example). Union coverage unfairly collapses as optional keys grow,
  // even when every row shares a stable record spine. Admit that shape only
  // when at least two keys occur in >=80% of sampled records.
  if (homogeneity < MIN_HOMOGENEITY) {
    const stableFields = [...union.keys()].filter((key) =>
      sample.filter((record) => Object.prototype.hasOwnProperty.call(record, key)).length / sample.length >= 0.8
    );
    if (stableFields.length < MIN_RECORD_FIELDS) return null;
    homogeneity = stableFields.reduce((sum, key) =>
      sum + sample.filter((record) => Object.prototype.hasOwnProperty.call(record, key)).length / sample.length,
    0) / stableFields.length;
  }
  // A record must itself be a record: at least MIN_RECORD_FIELDS keys on average.
  const meanKeys = sample.reduce((n, r) => n + Object.keys(r).length, 0) / sample.length;
  if (meanKeys < MIN_RECORD_FIELDS) return null;

  const fields = [...union.keys()].sort().slice(0, MAX_FIELDS);
  const fieldTypes: Record<string, string> = {};
  for (const f of fields) fieldTypes[f] = union.get(f) ?? "string";
  return { path, count: arr.length, homogeneity, fields, fieldTypes, density: contentDensity(sample) };
}

/** Evidence weight of a collection — used both to pick the best one in a body and
 *  (as a term) to rank endpoints. More records that agree on more of their shape. */
export function collectionWeight(c: RecordCollection): number {
  const contentTerm = ZERO_DENSITY_WEIGHT_FLOOR + (1 - ZERO_DENSITY_WEIGHT_FLOOR) * c.density;
  return Math.log1p(c.count) * c.homogeneity * contentTerm;
}

/**
 * Walk a decoded body ONCE and return both the strongest collection it contains
 * and the strongest collection that actually carries human-facing content.
 *
 * The two differ because density only DAMPENS weight — it cannot disqualify a
 * candidate, since an all-numeric collection is still a legitimate one. So a
 * large enough telemetry array outweighs a small product list (1200 tracking
 * rows beat 20 products), and a caller that wants records a person would read
 * needs the second answer, not the first. Both come out of one walk because the
 * walk is the expensive part.
 */
export function findBestCollections(
  root: unknown,
  minDensity = 0,
): { best: RecordCollection | null; contentful: RecordCollection | null } {
  let best: RecordCollection | null = null;
  let contentful: RecordCollection | null = null;
  let visited = 0;
  const stack: Array<{ value: unknown; path: string[]; depth: number }> = [
    { value: root, path: [], depth: 0 },
  ];
  const seen = new Set<object>();

  while (stack.length > 0) {
    if (visited++ > MAX_WALK_NODES) break;
    const node = stack.pop()!;
    const { value, path, depth } = node;
    if (value === null || typeof value !== "object") continue;
    if (seen.has(value as object)) continue; // cycle guard (parsed JSON cannot cycle, but callers may pass live objects)
    seen.add(value as object);

    if (Array.isArray(value)) {
      const candidate = scoreArray(value, path);
      if (candidate) {
        if (isBetterCollection(candidate, best)) best = candidate;
        if (candidate.density >= minDensity && isBetterCollection(candidate, contentful)) {
          contentful = candidate;
        }
      }
      if (depth < MAX_WALK_DEPTH) {
        // Descend into a bounded prefix: a nested collection under a record still counts.
        for (let i = Math.min(value.length, 3) - 1; i >= 0; i--) {
          stack.push({ value: value[i], path: [...path, String(i)], depth: depth + 1 });
        }
      }
      continue;
    }

    if (depth < MAX_WALK_DEPTH) {
      const entries = Object.entries(value as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i--) {
        stack.push({ value: entries[i][1], path: [...path, entries[i][0]], depth: depth + 1 });
      }
    }
  }
  return { best, contentful };
}

/**
 * The strongest record collection in a body, or null. Bounded in depth and in
 * nodes visited. Deterministic: ties break on the shallower path, then
 * lexicographically, so the same body always yields the same collection.
 */
export function findRecordCollection(root: unknown): RecordCollection | null {
  return findBestCollections(root).best;
}

/**
 * Every scalar leaf of a decoded body, as strings. Used for the query-echo signal: a
 * request parameter whose value comes BACK in the response is a coordinate the server
 * acknowledges, i.e. one the caller controls. Bounded so a 400 KB payload is cheap.
 */
function collectScalars(root: unknown): Set<string> {
  const out = new Set<string>();
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0 && out.size < MAX_ECHO_SCALARS && visited < MAX_WALK_NODES) {
    visited++;
    const value = stack.pop();
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const s = String(value);
      if (s.length > 0 && s.length <= 64) out.add(s);
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = Math.min(value.length, 50) - 1; i >= 0; i--) stack.push(value[i]);
      continue;
    }
    if (typeof value === "object") for (const v of Object.values(value as Record<string, unknown>)) stack.push(v);
  }
  return out;
}

function isBetterCollection(candidate: RecordCollection, incumbent: RecordCollection | null): boolean {
  if (!incumbent) return true;
  const a = collectionWeight(candidate);
  const b = collectionWeight(incumbent);
  if (a !== b) return a > b;
  if (candidate.path.length !== incumbent.path.length) return candidate.path.length < incumbent.path.length;
  return candidate.path.join(".") < incumbent.path.join(".");
}

// ---------------------------------------------------------------------------
// Body decoding.
// ---------------------------------------------------------------------------

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return String(v ?? "");
  }
  return "";
}

/** Decode a body as JSON, tolerating the XSSI guard prefixes. Returns undefined for
 *  anything that is not JSON — which is how fonts, images, CSS, JS and HTML are
 *  rejected without ever consulting their URL or their content-type. */
export function decodeJsonBody(body: string | undefined): unknown {
  if (!body) return undefined;
  if (body.length > MAX_BODY_BYTES) return undefined;
  let text = body.trim();
  for (const prefix of XSSI_PREFIXES) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * PROTOCOL CONSTANT (unavoidable). HTML's own data-block mechanism: a `<script>` whose
 * `type` is a JSON MIME type is, per the HTML spec, inert data rather than script. That
 * is the mechanism SSR frameworks use to ship the page's payload (Next's `__NEXT_DATA__`,
 * JSON-LD, and every hand-rolled equivalent) — recognising the MECHANISM catches all of
 * them, including ones that do not exist yet, and names none of them.
 */
const JSON_SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const JSON_SCRIPT_TYPE_RE = /type\s*=\s*["']?[^"'>]*\bjson\b/i;
/**
 * Structural: a JS binding whose RHS is a JSON-shaped array/object literal
 * (`var data = [{…}]`, `window.__STATE__ = {…}`). Shape-recognised — not a
 * variable-name allowlist. quotes.toscrape.com/js/ ships its whole collection
 * this way inside a plain (non-JSON-MIME) script.
 */
const ASSIGN_JSON_RE =
  /(?:(?:var|let|const)\s+)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*=\s*([\[{])/g;

/** Balanced `[…]` / `{…}` slice starting at `start`, honouring JSON string escapes. */
function balancedJsonSlice(source: string, start: number): string | null {
  if (start < 0 || start >= source.length) return null;
  const open = source[start];
  if (open !== "[" && open !== "{") return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  const limit = Math.min(source.length, start + MAX_BODY_BYTES);
  for (let i = start; i < limit; i++) {
    const c = source[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push(c === "{" ? "}" : "]");
      continue;
    }
    if (c === "}" || c === "]") {
      if (stack.length === 0 || stack[stack.length - 1] !== c) return null;
      stack.pop();
      if (stack.length === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** JSON-shaped assignment RHS values inside a plain `<script>` body. */
function jsonAssignmentsInScript(scriptBody: string): unknown[] {
  const out: unknown[] = [];
  if (!scriptBody) return out;
  ASSIGN_JSON_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGN_JSON_RE.exec(scriptBody)) !== null) {
    if (out.length >= MAX_EMBEDDED_BLOCKS) break;
    // match[0] ends with `[` or `{`; the open bracket is the last char.
    const openAt = match.index + match[0].length - 1;
    const slice = balancedJsonSlice(scriptBody, openAt);
    if (!slice) continue;
    const decoded = decodeJsonBody(slice);
    if (decoded !== undefined) out.push(decoded);
  }
  return out;
}

/**
 * Every JSON data payload embedded in an HTML document, in document order.
 *
 * Two structural mechanisms (no site/variable allowlist):
 *  1. `<script type=*json*>` inert data blocks (HTML's own data-block MIME)
 *  2. JSON-shaped assignment RHS in plain scripts (`var data = [{…}]`)
 *
 * Used by capture ranking AND the document path so a page that ships its
 * collection inside a script is not reduced to chrome-only text.
 */
export function embeddedJsonBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  if (!html || html.length > MAX_BODY_BYTES) return out;
  JSON_SCRIPT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_SCRIPT_BLOCK_RE.exec(html)) !== null) {
    if (out.length >= MAX_EMBEDDED_BLOCKS) break;
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    if (JSON_SCRIPT_TYPE_RE.test(attrs)) {
      const decoded = decodeJsonBody(body);
      if (decoded !== undefined) out.push(decoded);
      continue;
    }
    // Skip external script tags with no body.
    if (!body.trim()) continue;
    for (const assigned of jsonAssignmentsInScript(body)) {
      if (out.length >= MAX_EMBEDDED_BLOCKS) break;
      out.push(assigned);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Credential harvesting — layer 2 of the no-leak guarantee.
// ---------------------------------------------------------------------------

/**
 * The credential VALUES this capture actually carries. Handed to the obfuscator as
 * `opts.secrets` (which triggers its `scrubKnownSecrets` identity pass) and used again
 * as the fail-closed sweep over the finished descriptors. Recognises a credential by
 * the header classifier the rest of the repo already uses, plus the cookie/authorization
 * transport shapes those classifiers deliberately handle "separately".
 *
 * NEVER log or emit the return value.
 */
export function harvestCaptureSecrets(requests: RawRequest[]): string[] {
  const secrets = new Set<string>();
  const add = (value: unknown): void => {
    const s = typeof value === "string" ? value.trim() : "";
    if (s.length >= 8 && !REDACTION_RE.test(s)) secrets.add(s);
  };

  for (const req of requests) {
    for (const headers of [req.request_headers, req.response_headers]) {
      for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
        const name = rawName.toLowerCase();
        const value = String(rawValue ?? "");
        if (name === "cookie" || name === "set-cookie") {
          add(value);
          // Each individual cookie value is itself a credential.
          for (const pair of value.split(/;\s*/)) {
            const eq = pair.indexOf("=");
            if (eq > 0) add(pair.slice(eq + 1).split(/;/)[0]);
          }
          continue;
        }
        if (name === "authorization" || name === "proxy-authorization") {
          add(value);
          const space = value.indexOf(" ");
          if (space > 0) add(value.slice(space + 1));
          continue;
        }
        if (isSensitiveHeader(rawName) || looksLikeSecret(rawName, value)) add(value);
      }
    }
    // Query values whose key or shape names a credential (?session_token=…).
    try {
      const u = new URL(req.url);
      for (const [k, v] of u.searchParams.entries()) if (looksLikeSecret(k, v)) add(v);
    } catch {
      /* unparseable URL — the indexable gate drops it anyway */
    }
    // Body leaves keyed by a credential name.
    const body = decodeJsonBody(req.request_body);
    if (body !== undefined) collectSecretLeaves(body, "", add);
  }
  return [...secrets];
}

function collectSecretLeaves(value: unknown, key: string, add: (v: unknown) => void, depth = 0): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (typeof value === "string") {
    if (looksLikeSecret(key, value)) add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) collectSecretLeaves(item, key, add, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) collectSecretLeaves(v, k, add, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Candidate admission.
// ---------------------------------------------------------------------------

interface Candidate {
  /** Index into the paired raw/veiled arrays. */
  index: number;
  raw: RawRequest;
  /** The obfuscated twin — the ONLY source of any string that reaches a descriptor. */
  veiled: RawRequest;
  method: string;
  /** Parsed veiled URL. */
  url: URL;
  collection: RecordCollection;
  responseBytes: number;
  requestBytes: number;
  /** Scalar leaves of the response — the query-echo signal for templating. */
  responseScalars: Set<string>;
  /** Where the collection was found: the response body itself, or a JSON data-block
   *  inside an HTML response (SSR payload). */
  source: "json" | "embedded-json";
  score: number;
}

/** The information-gain ratio: how much more this request RECEIVED than it SENT.
 *  A consumed data payload is ≫1; a fire-and-forget beacon is ≪1. */
function informationGain(responseBytes: number, requestBytes: number): number {
  return Math.log((responseBytes + 1) / (requestBytes + 1));
}

function admitCandidate(
  raw: RawRequest,
  veiled: RawRequest,
  index: number,
  pageDomain: string,
): Candidate | null {
  const method = String(raw.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return null;
  const status = Number(raw.response_status ?? 0);
  if (!(status >= 200 && status < 300)) return null;
  // A fabricated body is not evidence of a response contract (see RawRequest.synthetic_body).
  if (raw.synthetic_body) return null;
  if (!isIndexableUrl(veiled.url)) return null;

  let url: URL;
  try {
    url = new URL(veiled.url);
  } catch {
    return null;
  }

  const body = raw.response_body ?? "";
  let collection = null as RecordCollection | null;
  let source: Candidate["source"] = "json";
  let responseScalars = new Set<string>();

  let decoded = decodeJsonBody(body);
  if (decoded === undefined) {
    const protobuf = decodeProtobufBody(body, headerValue(raw.response_headers, "content-type"));
    if (protobuf?.records.length) decoded = { records: protobuf.records };
  }
  if (decoded !== undefined) {
    collection = findRecordCollection(decoded);
    if (collection) responseScalars = collectScalars(decoded);
  } else {
    // Not JSON on the wire — but an SSR page ships its payload as an inert JSON
    // data-block, and that payload is as real an API response as an XHR's.
    let bestBlock: unknown;
    for (const block of embeddedJsonBlocks(body)) {
      const found = findRecordCollection(block);
      if (found && isBetterCollection(found, collection)) { collection = found; bestBlock = block; }
    }
    if (collection) { source = "embedded-json"; responseScalars = collectScalars(bestBlock); }
  }
  if (!collection) return null;

  const responseBytes = body.length;
  const requestBytes = (raw.request_body ?? "").length;
  const firstParty = pageDomain !== "" && getRegistrableDomain(url.hostname) === pageDomain;

  // Ranking. Every term is a property of the exchange, not of its address.
  //   records      — a net wants many fish (cardinality)
  //   homogeneity  — records that agree on their shape are a table, not a grab-bag
  //   payload      — order of magnitude of what came back
  //   gain         — received ÷ sent. Telemetry sends and does not receive.
  //   firstParty   — a page's primary data usually rides its own registrable domain.
  //                  A weak tiebreaker, never a gate: a first-party beacon still loses
  //                  on gain, and a third-party data API still wins on records+gain.
  //   embedded     — an SSR data-block is real data but is a weaker replay target than
  //                  a JSON route (it re-renders a whole page), so it sorts below.
  const score =
    2.0 * Math.log1p(collection.count) +
    1.5 * collection.homogeneity +
    1.0 * (Math.log10(responseBytes + 1)) +
    1.5 * Math.max(-3, Math.min(3, informationGain(responseBytes, requestBytes))) / 3 +
    0.5 * (firstParty ? 1 : 0) +
    (source === "embedded-json" ? -0.75 : 0);

  return {
    index, raw, veiled, method, url, collection,
    responseBytes, requestBytes, responseScalars, source, score,
  };
}

// ---------------------------------------------------------------------------
// url_template inference — which query params are VARIABLE.
// ---------------------------------------------------------------------------

/** Route identity for grouping observations: method + origin + (already {id}-normalised) path. */
function routeKey(c: Candidate): string {
  return `${c.method} ${c.url.origin}${c.url.pathname}`;
}

function placeholderName(param: string, taken: Set<string>): string {
  let base = param.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  if (!base) base = "param";
  if (/^\d/.test(base)) base = `p_${base}`;
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}_${n++}`;
  taken.add(name);
  return name;
}

/**
 * Decide, per (route, param), whether the param is VARIABLE — i.e. whether it should
 * become `{name}` so the route replays at other values, or stay a literal because it is
 * part of the route's identity.
 *
 * The signal is observed variation, exactly as a human reverse-engineer would read it:
 *   1. the obfuscator redacted the value  → always variable (a secret is never a literal,
 *      and emitting `[REDACTED]` as a literal would both leak the fact and break replay);
 *   2. the value is empty                → variable (an empty slot is a slot);
 *   3. ≥2 distinct values across this route's own observations → variable;
 *   4. the route was seen ONCE, but the same param name carries ≥2 distinct values
 *      elsewhere in the capture → variable (the site itself demonstrated it varies);
 *   5. the value is ECHOED in the response body → variable. A parameter the server hands
 *      back is a coordinate it acknowledges the caller controls (`page=2` → `"page": 2`);
 *   6. the value is a bare integer → variable. An integer-valued parameter is a position
 *      in a series — page, offset, limit, size, id — and a position is by definition not
 *      route identity.
 * Rules 5 and 6 exist because a capture often sees a route ONCE (rules 3-4 need siblings),
 * and a route replayable only at the one value that happened to be captured is not
 * reusable, which is the whole point of learning it. They are safe to be liberal with
 * because templating is LOSSLESS: `query` carries the observed value as the default, so a
 * replay that passes no arguments reproduces the captured request byte-for-byte, and one
 * that does pass arguments can now move.
 *
 * Everything else stays literal: `format=json` observed only ever as `json`, never echoed,
 * is part of the route.
 */
function inferVariableParams(
  group: Candidate[],
  globalParamValues: Map<string, Set<string>>,
): Set<string> {
  const perRoute = new Map<string, Set<string>>();
  for (const c of group) {
    for (const [k, v] of c.url.searchParams.entries()) {
      if (!perRoute.has(k)) perRoute.set(k, new Set());
      perRoute.get(k)!.add(v);
    }
  }
  const echoed = (value: string): boolean => group.some((c) => c.responseScalars.has(value));
  const variable = new Set<string>();
  for (const [param, values] of perRoute) {
    const seen = [...values];
    if (seen.some((v) => REDACTION_RE.test(v))) { variable.add(param); continue; }
    if (seen.some((v) => v === "")) { variable.add(param); continue; }
    if (values.size >= 2) { variable.add(param); continue; }
    if ((globalParamValues.get(param)?.size ?? 0) >= 2) { variable.add(param); continue; }
    if (seen.some((v) => /^-?\d+$/.test(v))) { variable.add(param); continue; }
    if (seen.some((v) => echoed(v))) variable.add(param);
  }
  return variable;
}

/**
 * Every distinct value this route was observed carrying, per query param, in
 * first-seen order. Read off the VEILED URLs, and a redaction marker is not a value
 * — it is the absence of one, which is exactly what the documentation needs to say
 * ("no value survives; supply your own"). Feeds `skill-doc`'s parameter prose.
 */
function observedParamValues(group: Candidate[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of group) {
    for (const [key, value] of c.url.searchParams.entries()) {
      if (value === "" || REDACTION_RE.test(value)) continue;
      const seen = out[key] ?? (out[key] = []);
      if (!seen.includes(value)) seen.push(value);
    }
  }
  return out;
}

/** Params the site itself sent EMPTY. Not the same as "no value survived": an empty
 *  value that produced a 200 is a demonstration that the param is OPTIONAL and that
 *  empty means "no filter" — the opposite of a value the credential veil withheld. */
function emptyParamNames(group: Candidate[]): string[] {
  const out: string[] = [];
  for (const c of group) {
    for (const [key, value] of c.url.searchParams.entries()) {
      if (value === "" && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

/** Params whose observed value came BACK in the response body — the server
 *  acknowledges the caller controls that coordinate. Same echo signal
 *  `inferVariableParams` uses for templating, surfaced for documentation. */
function echoedParamNames(group: Candidate[], observed: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(observed)) {
    if (observed[key].some((value) => group.some((c) => c.responseScalars.has(value)))) out.push(key);
  }
  return out;
}

interface TemplatedRoute {
  urlTemplate: string;
  /** param name → placeholder name, for the params that became `{…}`. */
  bindings: Record<string, string>;
  /** param name → observed default (never a redacted value). */
  defaults: Record<string, unknown>;
  /** Distinct `{…}` placeholders present in the PATH (produced by the obfuscator). */
  pathPlaceholders: string[];
}

function buildTemplate(representative: Candidate, variable: Set<string>): TemplatedRoute {
  const url = new URL(representative.url.toString());
  const taken = new Set<string>();
  const bindings: Record<string, string> = {};
  const defaults: Record<string, unknown> = {};

  // The obfuscator already replaced opaque/secret path segments with `{id}`. Make them
  // unique so two of them in one path are two distinct slots rather than one.
  const pathPlaceholders: string[] = [];
  let idN = 0;
  const pathname = url.pathname
    .split("/")
    .map((seg) => {
      if (!/^\{[^}]+\}$/.test(seg)) return seg;
      const name = placeholderName(idN === 0 ? "id" : `id_${idN + 1}`, taken);
      idN++;
      pathPlaceholders.push(name);
      return `{${name}}`;
    })
    .join("/");

  const params: Array<[string, string]> = [...url.searchParams.entries()];
  const rebuilt = new URLSearchParams();
  for (const [key, value] of params) {
    if (variable.has(key)) {
      const name = placeholderName(key, taken);
      bindings[key] = name;
      rebuilt.append(key, `{${name}}`);
      // A redacted value is not a default — it is the absence of one.
      if (!REDACTION_RE.test(value) && value !== "") defaults[key] = value;
    } else {
      rebuilt.append(key, value);
    }
  }

  const query = rebuilt.toString();
  // URLSearchParams percent-encodes the braces of a placeholder; restore them so
  // `extractTemplateQueryBindings` (src/template-params.ts) can read them back.
  const restored = query.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  const urlTemplate = `${url.origin}${pathname}${restored ? `?${restored}` : ""}`;
  return { urlTemplate, bindings, defaults, pathPlaceholders };
}

// ---------------------------------------------------------------------------
// Descriptor construction.
// ---------------------------------------------------------------------------

/** Same hash the rest of the repo uses (src/execution/index.ts, src/api/browse-index.ts)
 *  so a locally-inferred route and a server-inferred one for the same template collide
 *  on ID and `mergeEndpoints` reconciles them instead of double-listing. */
function stableEndpointId(method: string, urlTemplate: string): string {
  return createHash("sha256").update(`${method}:${urlTemplate}`).digest("base64url").slice(0, 21);
}

function buildResponseSchema(c: Candidate): ResponseSchema {
  const items: ResponseSchema = {
    type: "object",
    properties: Object.fromEntries(
      c.collection.fields.map((f) => [f, { type: c.collection.fieldTypes[f] ?? "string", inferred_from_samples: 1 }]),
    ),
    inferred_from_samples: Math.min(c.collection.count, HOMOGENEITY_SAMPLE),
  };
  const array: ResponseSchema = {
    type: "array",
    items,
    inferred_from_samples: Math.min(c.collection.count, HOMOGENEITY_SAMPLE),
  };
  // Rebuild the wrapper so a consumer knows where in the body the collection lives.
  let node = array;
  for (let i = c.collection.path.length - 1; i >= 0; i--) {
    const key = c.collection.path[i];
    if (/^\d+$/.test(key)) {
      node = { type: "array", items: node, inferred_from_samples: 1 };
    } else {
      node = { type: "object", properties: { [key]: node }, inferred_from_samples: 1 };
    }
  }
  return node;
}

/** The resource this route is about, read off the route itself: the last path segment
 *  that is not a placeholder and not a bare number. No vocabulary list. */
function resourceKind(urlTemplate: string): string {
  try {
    const segments = new URL(urlTemplate).pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = decodeURIComponent(segments[i]);
      if (/^\{[^}]+\}$/.test(seg) || /^\d+$/.test(seg)) continue;
      return seg.replace(/\.[a-z0-9]+$/i, "").toLowerCase() || "collection";
    }
  } catch {
    /* fall through */
  }
  return "collection";
}

/** Did the observed request carry a credential? Reported as `semantic.auth_required` —
 *  the NAME of the fact, never the value. Read off the veiled twin, where every such
 *  value is already a redaction marker. */
function observedWithCredential(veiled: RawRequest): boolean {
  for (const [name, value] of Object.entries(veiled.request_headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "cookie" || lower === "authorization") return true;
    if (isSensitiveHeader(name) && REDACTION_RE.test(String(value ?? ""))) return true;
  }
  return false;
}

/**
 * Confidence band for a locally-inferred route. Bounded ABOVE the floor that makes an
 * endpoint useless and BELOW the band a verified route occupies (`isVerifiedDurable`
 * wants ≥0.9 AND verification_status "verified", which this path never claims). Driven
 * by the strength of the structural evidence, not by a constant, so a 2-record 300-byte
 * blob and an 80-record 400 KB payload are not asserted to be equally trustworthy.
 */
const LOCAL_CONFIDENCE_FLOOR = 0.35;
const LOCAL_CONFIDENCE_CEILING = 0.65;

function localConfidence(c: Candidate, observations: number): number {
  const records = Math.min(1, Math.log1p(c.collection.count) / Math.log1p(50));
  const gain = Math.min(1, Math.max(0, informationGain(c.responseBytes, c.requestBytes) / 6));
  const repeat = Math.min(1, (observations - 1) / 2);
  const evidence = 0.45 * records + 0.25 * c.collection.homogeneity + 0.2 * gain + 0.1 * repeat;
  const raw = LOCAL_CONFIDENCE_FLOOR + (LOCAL_CONFIDENCE_CEILING - LOCAL_CONFIDENCE_FLOOR) * evidence;
  // Quantised so the value is stable across platforms' float formatting.
  return Math.round(raw * 1000) / 1000;
}

function originAndPath(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

export interface LocalRevengContext {
  pageUrl?: string;
  finalUrl?: string;
  [k: string]: unknown;
}

/**
 * Infer replayable endpoints from a real capture, locally.
 *
 * Pure and deterministic: same input ⇒ byte-identical output, including order. Draws no
 * clock (timestamps come from the capture's own entries), performs no I/O, and never
 * throws — an inference failure degrades to `[]`, exactly as the server path does.
 */
export function revengLocal(requests: RawRequest[], context?: LocalRevengContext): EndpointDescriptor[] {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  try {
    return inferEndpoints(requests, context);
  } catch {
    return [];
  }
}

function inferEndpoints(requests: RawRequest[], context?: LocalRevengContext): EndpointDescriptor[] {
  // Layer 1+2 of the credential guarantee: veil the capture with its own secrets
  // supplied, so the obfuscator's `scrubKnownSecrets` identity pass runs. Every string
  // that reaches a descriptor is read off `veiled`, never off `requests`.
  const secrets = harvestCaptureSecrets(requests);
  const veiled = obfuscateCaptureForReveng(requests, { secrets });

  const pageUrl = context?.finalUrl ?? context?.pageUrl ?? "";
  let pageDomain = "";
  try {
    if (pageUrl) pageDomain = getRegistrableDomain(new URL(pageUrl).hostname);
  } catch {
    pageDomain = "";
  }

  const candidates: Candidate[] = [];
  for (let i = 0; i < requests.length; i++) {
    const admitted = admitCandidate(requests[i], veiled[i] ?? requests[i], i, pageDomain);
    if (admitted) candidates.push(admitted);
  }
  if (candidates.length === 0) return [];

  // Cross-capture param variability, for routes observed only once.
  const globalParamValues = new Map<string, Set<string>>();
  for (const c of candidates) {
    for (const [k, v] of c.url.searchParams.entries()) {
      if (!globalParamValues.has(k)) globalParamValues.set(k, new Set());
      globalParamValues.get(k)!.add(v);
    }
  }

  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = routeKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const triggerUrl = originAndPath(pageUrl);
  const ranked: Array<{ descriptor: EndpointDescriptor; score: number }> = [];

  for (const group of groups.values()) {
    // Representative = strongest observation; ties break on capture order so the
    // choice is deterministic.
    const representative = [...group].sort((a, b) => (b.score - a.score) || (a.index - b.index))[0];
    const variable = inferVariableParams(group, globalParamValues);
    const { urlTemplate, defaults } = buildTemplate(representative, variable);

    const method = representative.method as EndpointDescriptor["method"];
    const confidence = localConfidence(representative, group.length);
    const collection = representative.collection;

    const descriptor: EndpointDescriptor = {
      endpoint_id: stableEndpointId(method, urlTemplate),
      method,
      url_template: urlTemplate,
      // Structure only — record count, field NAMES, where the collection sits. No value.
      description:
        `Locally inferred data route (${method}). Observed ${group.length}× returning ` +
        `${collection.count} like-shaped records` +
        (collection.path.length ? ` at ${collection.path.join(".")}` : " at the response root") +
        `; fields: ${collection.fields.slice(0, 8).join(", ")}.`,
      idempotency: SAFE_METHODS.has(method) ? "safe" : "unsafe",
      // Observed succeeding inside a live session — never replayed standalone, never
      // corroborated by the server. That is "unverified", and `last_verified_at` stays
      // unset because nothing has verified it.
      verification_status: "unverified",
      reliability_score: confidence,
      response_schema: buildResponseSchema(representative),
      semantic: {
        action_kind: "read",
        resource_kind: resourceKind(urlTemplate),
        description_out: `A collection of ${collection.count} ${resourceKind(urlTemplate)} records.`,
        description_source: "auto",
        example_fields: collection.fields,
        confidence,
        observed_at: representative.raw.timestamp,
        sample_request_url: urlTemplate,
        auth_required: observedWithCredential(representative.veiled),
      },
    };

    if (Object.keys(defaults).length > 0) descriptor.query = defaults;
    if (triggerUrl) descriptor.trigger_url = triggerUrl;

    // Preserve an observed JSON body as the executable recipe for non-GET
    // routes. Capture has already veiled credentials at this point and the
    // descriptor-wide secret sweep below still fails closed. Dropping this body
    // creates a convincing-looking POST endpoint that cannot reproduce the call.
    const observedBody = decodeJsonBody(representative.veiled.request_body);
    if (observedBody && typeof observedBody === "object" && !Array.isArray(observedBody)) {
      descriptor.body = observedBody as Record<string, unknown>;
    }

    // `operation_name` lives on `graphql_info` (src/types/skill.ts:278) — it is the
    // GraphQL operation, present only when the request IS GraphQL. Detected from the
    // wire format (an operationName / a `query {…}` document), reusing the classifier
    // the capture path already owns.
    const operationName = extractGraphQLOperationName(representative.veiled.url, representative.veiled.request_body);
    if (operationName) descriptor.graphql_info = { operation_name: operationName };

    // `extraction_method` + `confidence` live on `dom_extraction` (src/types/skill.ts:243)
    // — "endpoint returns HTML — apply DOM extraction with this config". Set ONLY for the
    // SSR case, where that is true; stamping it on a JSON route would send the executor
    // down a DOM path that route does not need. `spa-` is the prefix the executor and
    // publish-admission already read as "real SSR payload, not a page artifact"
    // (src/execution/index.ts:873, src/publish-admission.ts:100).
    if (representative.source === "embedded-json") {
      descriptor.dom_extraction = { extraction_method: "spa-embedded-json", confidence };
    }

    // A route nobody can call is not learned, it is merely stored. `documentEndpoint`
    // (./skill-doc.ts) turns the observed structure into prose a foreign agent can act
    // on without re-capturing: per-parameter meaning + required-vs-optional, the
    // response shape (where the collection sits, how many records, every field name),
    // an explicit auth statement, and a worked example call. Deterministic and
    // model-free, so the same capture always documents itself identically.
    //
    // It runs BEFORE the fail-closed credential sweep below, deliberately: the
    // generated prose is swept exactly like every other field, so a credential that
    // somehow reached the documentation drops the whole descriptor rather than
    // shipping.
    const observedParams = observedParamValues(group);
    const documented = documentEndpoint(descriptor, {
      observations: group.length,
      record_count: collection.count,
      homogeneity: collection.homogeneity,
      collection_path: collection.path,
      observed_params: observedParams,
      empty_params: emptyParamNames(group),
      echoed_params: echoedParamNames(group, observedParams),
      response_bytes: representative.responseBytes,
      ...(triggerUrl ? { page_url: triggerUrl } : {}),
    });

    ranked.push({ descriptor: documented, score: representative.score });
  }

  return (
    ranked
      // Layer 3: fail closed. Any descriptor in which a harvested credential still
      // appears is DROPPED, not patched — a route we cannot vouch for is worth less
      // than none.
      .filter((entry) => !containsAnySecret(entry.descriptor, secrets))
      // Deterministic order: strongest evidence first, ties broken on endpoint_id.
      .sort((a, b) => (b.score - a.score) || a.descriptor.endpoint_id.localeCompare(b.descriptor.endpoint_id))
      .map((entry) => entry.descriptor)
  );
}

/** True when any harvested credential value survives anywhere in a descriptor. */
export function containsAnySecret(descriptor: EndpointDescriptor, secrets: string[]): boolean {
  if (secrets.length === 0) return false;
  const blob = JSON.stringify(descriptor);
  return secrets.some((s) => s.length >= 8 && blob.includes(s));
}
