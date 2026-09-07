/**
 * skill-doc — the DOCUMENTATION generator for a learned internal API.
 *
 * ── The problem ────────────────────────────────────────────────────────────────
 * A learned route is only worth what a foreign agent can do with it WITHOUT
 * re-capturing and without reading the site. Measured on the largest skill on this
 * machine — 225 KB, 55 endpoints — what a reader actually got was:
 *
 *     name        : "127.0.0.1"                     ← an IP, not a name
 *     description : "DOM skill for 127.0.0.1"       ← says nothing
 *     endpoint    : GET /search?q={q}
 *       description : "Page content from 127.0.0.1" ← IDENTICAL on all 55
 *       semantic    : { description_in: "Requires q" }
 *       query       : none, constraints: 0
 *
 * Nothing there answers the five questions a caller has: what does this return,
 * what do I pass, what is required, do I need auth, what does a correct call look
 * like. A field-dump is not documentation. This module answers those five, in
 * prose, from observed structure.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────────
 * NOT a model. No LLM, no network, no clock, no randomness. Same capture in ⇒
 * byte-identical documentation out (asserted across two OS processes in
 * tests/skill-doc-readable.test.ts). A model on this path would author different
 * prose every run and make the persisted skill store non-reproducible — two
 * captures of the same site would diff on prose that says the same thing.
 *
 * NOT a third inference engine. Everything structural is READ OFF
 * `resolveEndpointSemantic` (src/lib/graph-core/index.ts), which already derives
 * action_kind, resource_kind, the `requires` bindings (from path_params, query and
 * `{…}` template holes, each with `required` and `semantic_type`) and `provides`.
 * This repo's recurring wound is one concept implemented many times, so this module
 * adds exactly the layer graph-core leaves empty:
 *
 *   graph-core gives   →  { key: "page", required: false, source: "query" }
 *                          description_in: "Requires q"
 *   skill-doc adds     →  binding.description  (what the parameter MEANS, whether
 *                          it is required, whether it pages)
 *                          binding.example_value (the observed value)
 *                          description_in / description_out / endpoint.description
 *                          (prose an agent can read and act on)
 *                          constraints[] (the required params, machine-readable)
 *
 * ── Where the prose comes from (no vocabulary lists) ────────────────────────────
 * Per the repo standing rule, a parameter's role is recognised by the SHAPE OF ITS
 * OBSERVED VARIATION, never by its spelling. `page`, `offset`, `cursor`, `p` and
 * `sida` are all recognised by the same signal and none of them is named here:
 *
 *   - a param observed at ≥2 distinct INTEGER values on one route PAGES the
 *     collection — the site itself demonstrated that moving it returns a different
 *     slice;
 *   - a param observed at exactly one integer value EQUAL to the number of records
 *     that came back BOUNDS the page size — that numeric correspondence is the
 *     evidence, not the word "limit" (and it correctly does NOT fire when the
 *     numbers disagree);
 *   - a param whose value is ECHOED in the response body is a coordinate the server
 *     acknowledges the caller controls (this is the same echo signal the templater
 *     in reveng-local already computes);
 *   - a templated param with NO surviving observed value had its value WITHHELD —
 *     the credential veil redacted it, or it was empty. That is why it is
 *     documented as "supply your own", and it is why the caller is told a value is
 *     mandatory there. No key-name allowlist is consulted to reach that conclusion.
 *
 * The response shape is read off `response_schema` (or the caller's richer
 * `EndpointDocEvidence`): where the collection sits in the body, how many records
 * came back, how uniform they were, and every field name + JSON type.
 *
 * ── Credentials ────────────────────────────────────────────────────────────────
 * This documents an AUTHENTICATED capture, so the one thing the docs may never
 * carry is the credential that made the capture work. Two structural guarantees:
 *
 *   1. this module reads ONLY the EndpointDescriptor, which in the reveng-local
 *      path is already built exclusively off the obfuscated twin — there is no path
 *      from a raw header or cookie jar into this file;
 *   2. the AUTH section names the MECHANISM and never a value: "send your own
 *      session cookie for this host". A templated param whose value did not survive
 *      is documented as a hole to fill, never as the value that filled it.
 *
 * In the reveng-local path the generated text is additionally covered by the
 * existing fail-closed sweep (`containsAnySecret`), which runs AFTER documentation
 * and DROPS any descriptor in which a harvested credential appears anywhere —
 * including in this prose. tests/skill-doc-readable.test.ts pins that with the
 * fixture's five planted credentials.
 *
 * ── Publish boundary (deliberate, not an oversight) ─────────────────────────────
 * `src/publish/sanitize.ts` strips `binding.example_value` and rewrites every URL
 * inside prose. So the observed example value and the concrete example URL are
 * LOCAL documentation; what publishes is the shape, the field names, the auth
 * statement and the parameter semantics. Values are put in `example_value` (which
 * the boundary strips) rather than inside `binding.description` (which it does not)
 * precisely so that boundary keeps working.
 */
import type {
  EndpointConstraint,
  EndpointDescriptor,
  EndpointSemanticDescriptor,
  OperationBinding,
  ResponseSchema,
  SkillManifest,
} from "../types/skill.js";
import { resolveEndpointSemantic } from "../lib/graph-core/index.js";

/** Cap on parameters documented in prose; the bindings themselves are never truncated. */
const MAX_DOCUMENTED_PARAMS = 24;
/** Cap on record fields spelled out in the RETURNS paragraph. */
const MAX_DOCUMENTED_FIELDS = 24;
/** Bounded walk when locating the record collection inside a response_schema. */
const MAX_SCHEMA_WALK_NODES = 500;

/**
 * The observations a caller (reveng-local) holds that a finished EndpointDescriptor
 * has already lost. All optional: without any of it the generator still documents
 * the endpoint from `response_schema` + `query` alone, which is what makes it usable
 * on the 104 skills already on disk.
 */
export interface EndpointDocEvidence {
  /** How many times this exact route was seen in the capture. */
  observations?: number;
  /** Exact record count in the representative response (schema only keeps the sample size). */
  record_count?: number;
  /** 0..1 share of the union-of-keys an average record carried. */
  homogeneity?: number;
  /** JSON path to the collection, e.g. ["result","results"]; [] means the body IS the array. */
  collection_path?: string[];
  /** param → distinct observed values, in first-seen order. Never a redacted marker. */
  observed_params?: Record<string, string[]>;
  /**
   * Params observed carrying an EMPTY value. Distinct from "no observed value":
   * the site demonstrated the call works with the param empty, so it is optional and
   * an empty value means "no filter" — the opposite conclusion from a param whose
   * value the credential veil withheld.
   */
  empty_params?: string[];
  /** Params whose observed value came BACK in the response body. */
  echoed_params?: string[];
  /** Byte length of the representative response body. */
  response_bytes?: number;
  /** The page whose browsing produced this route. */
  page_url?: string;
}

/** The record collection as the documentation needs to talk about it. */
interface ResponseShape {
  path: string[];
  count?: number;
  sampled?: number;
  homogeneity?: number;
  fields: Array<{ name: string; type: string }>;
}

/** One documented parameter: the binding graph-core inferred, plus what it MEANS. */
interface DocumentedParam {
  binding: OperationBinding;
  /** The prose line for the PARAMETERS block. */
  line: string;
  /** Observed values (local only — stripped at publish via example_value). */
  observed: string[];
  /** The site sent this param empty and the call still worked. */
  observedEmpty: boolean;
}

// ---------------------------------------------------------------------------
// Response shape.
// ---------------------------------------------------------------------------

function isIntegerLiteral(value: string): boolean {
  return /^-?\d+$/.test(value);
}

/**
 * Locate the record collection inside a response schema: the shallowest `array`
 * node whose items are objects. Deterministic — breadth-first in the schema's own
 * key order, first hit wins, bounded.
 */
function locateCollection(schema: ResponseSchema | undefined): { path: string[]; node: ResponseSchema } | null {
  if (!schema) return null;
  const queue: Array<{ node: ResponseSchema; path: string[] }> = [{ node: schema, path: [] }];
  let visited = 0;
  while (queue.length > 0) {
    if (visited++ > MAX_SCHEMA_WALK_NODES) break;
    const { node, path } = queue.shift()!;
    if (node.type === "array" && node.items?.properties) return { path, node };
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        queue.push({ node: child, path: [...path, key] });
      }
    }
    if (node.items) queue.push({ node: node.items, path: [...path, "[]"] });
  }
  return null;
}

function readResponseShape(
  endpoint: EndpointDescriptor,
  evidence: EndpointDocEvidence | undefined,
  semantic: EndpointSemanticDescriptor,
): ResponseShape | null {
  const located = locateCollection(endpoint.response_schema);
  const fields: Array<{ name: string; type: string }> = [];
  if (located?.node.items?.properties) {
    for (const [name, child] of Object.entries(located.node.items.properties)) {
      fields.push({ name, type: child.type || "string" });
    }
  } else {
    for (const name of semantic.example_fields ?? []) fields.push({ name, type: "unknown" });
  }
  if (fields.length === 0) return null;
  return {
    path: evidence?.collection_path ?? located?.path ?? [],
    count: evidence?.record_count,
    sampled: located?.node.inferred_from_samples,
    homogeneity: evidence?.homogeneity,
    fields: fields.slice(0, MAX_DOCUMENTED_FIELDS),
  };
}

function collectionLocation(shape: ResponseShape): string {
  if (shape.path.length === 0) return "the response body IS the array";
  return `\`${shape.path.join(".")}\``;
}

// ---------------------------------------------------------------------------
// Parameters. The role of a parameter is read off how its value VARIED.
// ---------------------------------------------------------------------------

/**
 * Every value this parameter was observed carrying. The DEFAULT the descriptor
 * actually replays (`query` / `path_params`) is put first, so the worked example
 * below is byte-identical to what an argument-free replay sends — an example that
 * disagrees with the route's own defaults would be worse than none.
 */
function observedValuesFor(
  key: string,
  endpoint: EndpointDescriptor,
  evidence: EndpointDocEvidence | undefined,
): string[] {
  const values: string[] = [];
  const push = (value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    const text = String(value);
    if (!values.includes(text)) values.push(text);
  };
  push(endpoint.query?.[key]);
  push(endpoint.path_params?.[key]);
  for (const value of evidence?.observed_params?.[key] ?? []) push(value);
  return values;
}

function valueTypeOf(values: string[]): string {
  if (values.length === 0) return "unknown";
  if (values.every(isIntegerLiteral)) return "integer";
  if (values.every((v) => v === "true" || v === "false")) return "boolean";
  return "string";
}

function whereSent(source: string | undefined, urlTemplate: string, key: string): string {
  if (source === "path_params") return "path segment";
  if (source === "query") return "query-string parameter";
  // A `{…}` hole inferred from the template: say which half of the URL it sits in.
  try {
    const url = new URL(urlTemplate);
    if (url.searchParams.has(key) || url.search.includes(`{${key}}`)) return "query-string parameter";
    if (url.pathname.includes(`{${key}}`)) return "path segment";
  } catch {
    /* unparseable template — fall through */
  }
  return "request parameter";
}

/**
 * The role sentence. Every branch is a statement about OBSERVED VARIATION, so a
 * newly-invented parameter name is documented correctly without touching this file.
 */
function roleSentence(
  values: string[],
  echoed: boolean,
  shape: ResponseShape | null,
  required: boolean,
  observedEmpty: boolean,
): string {
  if (observedEmpty && values.length === 0) {
    return "Optional filter: the site sent it EMPTY during capture and the call still worked, so an empty value means \"no filter\". Supply a value to narrow the result.";
  }
  if (values.length === 0) {
    return required
      ? "No value survives the capture — the observed one was withheld by the credential veil, so you MUST supply your own."
      : "No value was observed for it during capture; supply your own.";
  }
  const allIntegers = values.every(isIntegerLiteral);
  if (allIntegers && values.length >= 2) {
    return `Pages through the collection: ${values.length} distinct integer values were observed on this route and each returned a different slice.`;
  }
  if (allIntegers && shape?.count !== undefined && Number(values[0]) === shape.count) {
    return `Bounds how many records come back: the one observed value equals the ${shape.count} records that were returned.`;
  }
  if (allIntegers) {
    return "An integer position in a series — it can be moved; omit it and the value observed during capture is sent.";
  }
  if (echoed) {
    return "A free-text value the server echoes back in the response, so it selects which records come back. Omit it and the value observed during capture is sent.";
  }
  return "A free-text value. Omit it and the value observed during capture is sent.";
}

function documentParams(
  endpoint: EndpointDescriptor,
  semantic: EndpointSemanticDescriptor,
  evidence: EndpointDocEvidence | undefined,
  shape: ResponseShape | null,
): DocumentedParam[] {
  const echoedSet = new Set(evidence?.echoed_params ?? []);
  const emptySet = new Set(evidence?.empty_params ?? []);
  const out: DocumentedParam[] = [];
  // DEDUPE on (name, WHERE IT IS SENT). Two different things force this:
  //   - `mergeBindings` in graph-core dedupes on `bindingIdentity`, which includes
  //     `type` and `required`. Documenting a binding SETS those, so re-documenting an
  //     already-documented endpoint made every parameter identity-distinct from its
  //     freshly-inferred twin and the list doubled ("6 parameters: q, limit, page, q,
  //     limit, page"). Documentation has to be idempotent — an agent re-reading a
  //     skill must not be told there are twice as many parameters as there are.
  //   - the same name legitimately appears in two LOCATIONS (a `page` path segment and
  //     a `page` query param are two parameters), so the name alone is not the key.
  const seen = new Set<string>();
  for (const binding of semantic.requires ?? []) {
    if (!binding.key) continue;
    const identity = `${binding.key} ${whereSent(binding.source, endpoint.url_template, binding.key)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const values = observedValuesFor(binding.key, endpoint, evidence);
    const location = whereSent(binding.source, endpoint.url_template, binding.key);
    const observedEmpty = emptySet.has(binding.key) && values.length === 0;
    // `inferRequires` calls a `{…}` hole with no stored default REQUIRED, which is
    // right for a withheld value and WRONG for one the site itself sent empty: an
    // empty value that produced a 200 is a demonstration that the param is optional.
    // Correcting it here is this layer's job — documenting required-vs-optional
    // accurately is the whole point.
    const required = observedEmpty ? false : binding.required !== false;
    const type = valueTypeOf(values);
    const role = roleSentence(values, echoedSet.has(binding.key), shape, required, observedEmpty);
    // The prose names the parameter and states required-vs-optional explicitly, and
    // carries NO captured value (publish does not scrub binding.description).
    const description =
      `\`${binding.key}\` — ${required ? "REQUIRED" : "optional"} ${location}` +
      `${type === "unknown" ? "" : ` (${type})`}. ${role}`;
    out.push({
      binding: {
        ...binding,
        required,
        description,
        ...(type === "unknown" ? {} : { type }),
        // The observed value lives HERE, in the field the publish boundary strips.
        ...(values.length > 0 ? { example_value: values[0] } : {}),
      },
      line: description,
      observed: values,
      observedEmpty,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auth. The NAME of the fact, never the value.
// ---------------------------------------------------------------------------

function hostOf(urlTemplate: string): string {
  try {
    return new URL(urlTemplate).hostname;
  } catch {
    return "this host";
  }
}

function authSentence(endpoint: EndpointDescriptor, semantic: EndpointSemanticDescriptor): string {
  const host = hostOf(endpoint.url_template);
  if (semantic.auth_required) {
    return (
      `REQUIRED. The captured call carried a session credential for ${host}. ` +
      `Send YOUR OWN cookie for ${host} — no credential from the capture is stored on ` +
      `this route or replayable from it.`
    );
  }
  return (
    `Not required. The captured call carried no credential for ${host}, so an ` +
    `unauthenticated request reproduces what was observed. If it 401s, the site has ` +
    `changed and you need your own session for ${host}.`
  );
}

// ---------------------------------------------------------------------------
// The worked example call.
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Substitute each `{hole}` in the template with its observed value, so the example
 * is a call you can actually make. A hole with no observed value keeps an explicit
 * `<…>` marker — an unfilled hole is information, not something to fake.
 */
function exampleUrl(endpoint: EndpointDescriptor, params: DocumentedParam[]): string {
  const byKey = new Map(params.map((p) => [p.binding.key, p]));
  return endpoint.url_template.replace(/\{([^}]+)\}/g, (_match, rawKey: string) => {
    const param = byKey.get(rawKey);
    if (param && param.observed.length > 0) return encodeURIComponent(param.observed[0]);
    // Observed empty: the captured call really did send `jn=`. Reproduce that.
    if (param?.observedEmpty) return "";
    return `<your-${rawKey}>`;
  });
}

interface ExampleCall {
  curl: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: Record<string, unknown>; note?: string };
}

function buildExampleCall(
  endpoint: EndpointDescriptor,
  params: DocumentedParam[],
  semantic: EndpointSemanticDescriptor,
): ExampleCall {
  const url = exampleUrl(endpoint, params);
  const host = hostOf(endpoint.url_template);
  const headers: Record<string, string> = { accept: "application/json" };
  if (semantic.auth_required) headers.cookie = `<your ${host} session cookie>`;
  const parts = ["curl", "-sS"];
  if (endpoint.method !== "GET") parts.push("-X", endpoint.method);
  if (endpoint.body) headers["content-type"] = "application/json";
  for (const [name, value] of Object.entries(headers)) {
    const displayName = name === "cookie" ? "Cookie" : name === "content-type" ? "Content-Type" : "Accept";
    parts.push("-H", shellQuote(`${displayName}: ${value}`));
  }
  if (endpoint.body) parts.push("--data", shellQuote(JSON.stringify(endpoint.body)));
  parts.push(shellQuote(url));
  const note =
    endpoint.method === "GET"
      ? undefined
      : endpoint.body
        ? "The captured JSON body is preserved; Unbrowse refreshes a veiled sessionId before replay."
        : "The captured request BODY is not stored on this route, so the example shows method, headers and URL only.";
  return {
    curl: parts.join(" "),
    request: { method: endpoint.method, url, headers, ...(endpoint.body ? { body: endpoint.body } : {}), ...(note ? { note } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Prose assembly.
// ---------------------------------------------------------------------------

function purposeSentence(
  endpoint: EndpointDescriptor,
  semantic: EndpointSemanticDescriptor,
  shape: ResponseShape | null,
  evidence: EndpointDocEvidence | undefined,
): string {
  const host = hostOf(endpoint.url_template);
  const resource = semantic.resource_kind && semantic.resource_kind !== "resource"
    ? semantic.resource_kind
    : "record";
  const observations = evidence?.observations;
  const count = shape?.count;
  const returns = count !== undefined
    ? `returns ${count} ${resource} records per call`
    : `returns ${resource} records`;
  const learned = observations
    ? `Learned by watching ${evidence?.page_url ? evidence.page_url : host} call it ` +
      `${observations} time${observations === 1 ? "" : "s"} during one real browsing session`
    : `Learned from one real browsing session of ${host}`;
  const graphql = endpoint.graphql_info?.operation_name
    ? ` It is the GraphQL operation \`${endpoint.graphql_info.operation_name}\`.`
    : "";
  const ssr = endpoint.dom_extraction?.extraction_method
    ? ` The payload does not ride an XHR: it is an inert JSON data-block inside the HTML page (\`${endpoint.dom_extraction.extraction_method}\`), so the response is HTML and the records must be read out of that block.`
    : "";
  return (
    `\`${endpoint.method} ${endpoint.url_template}\` ${returns} from ${host}.${graphql}${ssr} ` +
    `${learned}; it has never been replayed standalone, so it is ${endpoint.verification_status}.`
  );
}

function returnsParagraph(shape: ResponseShape | null, endpoint: EndpointDescriptor): string {
  if (!shape) {
    return "Response shape was not captured for this route — call it once and read the body before relying on it.";
  }
  const bodyKind = endpoint.dom_extraction ? "HTML carrying an embedded JSON block" : "JSON";
  const where = collectionLocation(shape);
  const countText = shape.count !== undefined
    ? `an array of ${shape.count} like-shaped objects`
    : `an array of like-shaped objects (${shape.sampled ?? 0} sampled)`;
  const uniform = shape.homogeneity !== undefined
    ? ` ${shape.homogeneity >= 1 ? "Every" : `${Math.round(shape.homogeneity * 100)}% of`} sampled record${shape.homogeneity >= 1 ? " carried all" : "s carried the"} ${shape.fields.length} keys.`
    : "";
  const fields = shape.fields.map((f) => `${f.name} (${f.type})`).join(", ");
  return (
    `HTTP 200, ${bodyKind}. The records live at ${where} — ${countText}.${uniform} ` +
    `Each record has: ${fields}.`
  );
}

/** The one-line "what do I pass" summary that replaces graph-core's "Requires q". */
function buildDescriptionIn(params: DocumentedParam[]): string {
  if (params.length === 0) return "Takes no parameters — call the URL as-is.";
  const required = params.filter((p) => p.binding.required !== false).map((p) => p.binding.key);
  const defaulted = params
    .filter((p) => p.binding.required === false && p.observed.length > 0)
    .map((p) => p.binding.key);
  const blank = params
    .filter((p) => p.binding.required === false && p.observed.length === 0)
    .map((p) => p.binding.key);
  const bits: string[] = [];
  if (required.length > 0) {
    bits.push(`${required.length} required (${required.join(", ")}) — no value survives the capture, so you must supply one`);
  }
  if (defaulted.length > 0) {
    bits.push(`${defaulted.length} optional with a captured default (${defaulted.join(", ")}) that is sent when you omit it`);
  }
  if (blank.length > 0) {
    bits.push(`${blank.length} optional and observed EMPTY (${blank.join(", ")}), i.e. unfiltered`);
  }
  return `Takes ${params.length} parameter${params.length === 1 ? "" : "s"}: ${bits.join("; ")}.`;
}

/** The one-line "what comes back" summary. */
function buildDescriptionOut(shape: ResponseShape | null, semantic: EndpointSemanticDescriptor): string {
  if (!shape) return `Returns ${semantic.resource_kind} data; the response shape was not captured.`;
  const where = shape.path.length === 0 ? "the response root" : `\`${shape.path.join(".")}\``;
  const count = shape.count !== undefined ? `${shape.count} ` : "";
  return (
    `Returns ${count}${semantic.resource_kind} records at ${where}, each with ` +
    `${shape.fields.map((f) => f.name).join(", ")}.`
  );
}

function buildManPage(
  endpoint: EndpointDescriptor,
  semantic: EndpointSemanticDescriptor,
  params: DocumentedParam[],
  shape: ResponseShape | null,
  example: ExampleCall,
  evidence: EndpointDocEvidence | undefined,
): string {
  const shown = params.slice(0, MAX_DOCUMENTED_PARAMS);
  const paramBlock = shown.length === 0
    ? "None. Call the URL as-is."
    : shown.map((p) => `  ${p.line}`).join("\n") +
      (params.length > shown.length ? `\n  …and ${params.length - shown.length} more.` : "");
  return [
    `${endpoint.method} ${endpoint.url_template}`,
    "",
    "WHAT IT DOES",
    purposeSentence(endpoint, semantic, shape, evidence),
    "",
    `PARAMETERS (${params.length})`,
    paramBlock,
    "",
    "RETURNS",
    returnsParagraph(shape, endpoint),
    "",
    "AUTH",
    authSentence(endpoint, semantic),
    "",
    "EXAMPLE CALL",
    example.curl,
    ...(example.request.note ? [example.request.note] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** The header line every generated man page opens with — also the marker that says
 *  "this endpoint has already been documented by this generator". */
function manPageHeader(endpoint: EndpointDescriptor): string {
  return `${endpoint.method} ${endpoint.url_template}\n`;
}

/** True when this exact generator already wrote this endpoint's documentation. */
export function isDocumented(endpoint: EndpointDescriptor): boolean {
  return (
    typeof endpoint.description === "string" &&
    endpoint.description.startsWith(manPageHeader(endpoint)) &&
    typeof endpoint.semantic?.description_in === "string" &&
    endpoint.semantic.description_in.length > 0
  );
}

/**
 * Document one endpoint. Returns a NEW descriptor with `description`, `semantic`
 * (description_in / description_out / documented `requires` bindings /
 * example_request) and `constraints` populated. Pure, deterministic, never throws:
 * on any failure the input descriptor is returned unchanged, because a route with a
 * thin description is still better than no route.
 */
export function documentEndpoint(
  endpoint: EndpointDescriptor,
  evidence?: EndpointDocEvidence,
): EndpointDescriptor {
  try {
    // Already documented and no NEW observations to document from: return it
    // unchanged. Re-deriving from a strictly lossier view (schema only, no record
    // count, no observed values) would rewrite good prose into worse prose and make
    // documentation non-idempotent.
    if (evidence === undefined && isDocumented(endpoint)) return endpoint;

    const base = resolveEndpointSemantic(endpoint);
    // This module DOCUMENTS; it does not re-decide facts the descriptor already
    // asserted. `resolveEndpointSemantic` is a merge, and its inferred half would
    // otherwise overwrite four things reveng-local set deliberately:
    //   action_kind / resource_kind — the site's own last path segment ("facets",
    //     "jo-filter") is more truthful than a normalised vocabulary token ("form");
    //   confidence — reveng-local caps a locally-inferred route BELOW the verified
    //     band on purpose (LOCAL_CONFIDENCE_CEILING); the merge would raise it to 0.8
    //     and quietly claim evidence that does not exist;
    //   example_fields — already the clean record field names; the merge prepends
    //     schema wrapper paths ("result", "result.results") as if they were fields.
    // So the descriptor's own values win, and only the fields it left EMPTY
    // (requires / provides / negative_tags) are taken from graph-core.
    const prior = endpoint.semantic;
    const facts: EndpointSemanticDescriptor = {
      ...base,
      action_kind: prior?.action_kind ?? base.action_kind,
      resource_kind: prior?.resource_kind ?? base.resource_kind,
      confidence: prior?.confidence ?? base.confidence,
      example_fields: prior?.example_fields?.length ? prior.example_fields : base.example_fields,
    };

    const shape = readResponseShape(endpoint, evidence, facts);
    const params = documentParams(endpoint, facts, evidence, shape);
    const example = buildExampleCall(endpoint, params, facts);
    const description = buildManPage(endpoint, facts, params, shape, example, evidence);

    const semantic: EndpointSemanticDescriptor = {
      ...facts,
      description_in: buildDescriptionIn(params),
      description_out: buildDescriptionOut(shape, facts),
      response_summary: shape
        ? `${shape.count ?? shape.sampled ?? 0} records at ${shape.path.length ? shape.path.join(".") : "(root)"}: ${shape.fields.map((f) => f.name).join(", ")}`
        : facts.response_summary,
      // Honest provenance. "agent" is reserved (src/lib/graph-core/agent-augment.ts)
      // for prose an LLM augmenter actually authored; this is derived, so it is
      // "auto". It does NOT need review by this repo's own rule — see
      // getEndpointDescriptionMetadata, where an auto description carrying real
      // response fields (`schemaGrounded`) is explicitly exempt.
      description_source: "auto",
      description_needs_review: false,
      description_warning:
        `Derived deterministically from ${evidence?.observations ?? 1} observed call(s) in one capture — no model wrote it. ` +
        `Field names, record counts and parameter values are observed facts; parameter MEANINGS are inferred from how the values varied.`,
      requires: params.map((p) => p.binding),
      example_request: example.request,
    };

    // The required parameters, machine-readable. `source: "agent"` is the closer of
    // the two allowed values (EndpointConstraint.source is "api_error" | "agent"):
    // this was learned by observing the capture, not from an API error response.
    const constraints: EndpointConstraint[] = params
      .filter((p) => p.binding.required !== false)
      .map((p) => ({
        param: p.binding.key,
        rule: "required" as const,
        message: `\`${p.binding.key}\` has no value observed during capture — the request will not reproduce without one you supply.`,
        source: "agent" as const,
        // Deterministic: the capture's own timestamp, never a clock read.
        learned_at: facts.observed_at ?? endpoint.last_verified_at ?? "",
      }));

    return {
      ...endpoint,
      description,
      semantic,
      ...(constraints.length > 0
        ? { constraints: [...(endpoint.constraints ?? []), ...constraints] }
        : {}),
    };
  } catch {
    return endpoint;
  }
}

/**
 * Manifest-level documentation: the header a reader sees before any endpoint.
 * Replaces `name: "127.0.0.1"` / `description: "DOM skill for 127.0.0.1"` with a
 * description that says what the skill actually contains, and intents that carry
 * the resource tokens BM25 needs.
 *
 * NOTE: the call sites that build a SkillManifest live outside this module
 * (src/execution/index.ts, src/orchestrator/index.ts, src/lib/indexer-core/index.ts,
 * src/api/browse-index.ts — each does `name: domain`). Wiring it there is a
 * one-liner per site; this function is the part that knows what to say.
 */
export function describeSkill(
  domain: string,
  endpoints: EndpointDescriptor[],
  opts?: { pageUrl?: string },
): { name: string; description: string; intents: string[] } {
  const name = `${domain} internal API`;
  if (endpoints.length === 0) {
    return {
      name,
      description: `No internal API routes have been learned for ${domain} yet.`,
      intents: [],
    };
  }
  const summaries: string[] = [];
  const intents: string[] = [];
  let authed = 0;
  for (const endpoint of endpoints) {
    const semantic = endpoint.semantic ?? resolveEndpointSemantic(endpoint);
    if (semantic.auth_required) authed++;
    const shape = readResponseShape(endpoint, undefined, semantic);
    const fields = (shape?.fields.map((f) => f.name) ?? semantic.example_fields ?? []).slice(0, 6);
    summaries.push(
      `${semantic.resource_kind} (${endpoint.method}${fields.length ? `, records carry ${fields.join(", ")}` : ""})`,
    );
    const intent = `${semantic.action_kind} ${semantic.resource_kind} on ${domain}`;
    if (!intents.includes(intent)) intents.push(intent);
  }
  const verified = endpoints.filter((e) => e.verification_status === "verified").length;
  const description = [
    `Learned internal API for ${domain} — ${endpoints.length} route${endpoints.length === 1 ? "" : "s"}`,
    opts?.pageUrl ? ` captured from real browsing of ${opts.pageUrl}` : " captured from real browsing",
    `. Covers: ${summaries.join("; ")}.`,
    ` ${authed} of ${endpoints.length} route${endpoints.length === 1 ? "" : "s"} need an authenticated session — send your own cookie for ${domain}; no credential from the capture is stored here.`,
    verified === endpoints.length
      ? " All routes are verified."
      : ` ${endpoints.length - verified} route${endpoints.length - verified === 1 ? " is" : "s are"} unverified: observed succeeding inside a live browser session, never replayed standalone.`,
    " Read each endpoint's `description` for its parameters, response shape and a worked example call.",
  ].join("");
  return { name, description, intents };
}

/**
 * Document a whole manifest in place of its thin header — endpoints included.
 * Used by the round-trip proof (write to a snapshot dir, read the JSON back, assert
 * the documentation is still there). Deterministic and pure: no clock, no I/O.
 */
export function documentSkillManifest(
  manifest: SkillManifest,
  evidenceByEndpointId?: Record<string, EndpointDocEvidence>,
): SkillManifest {
  const endpoints = manifest.endpoints.map((endpoint) =>
    documentEndpoint(endpoint, evidenceByEndpointId?.[endpoint.endpoint_id]),
  );
  const header = describeSkill(manifest.domain, endpoints);
  return {
    ...manifest,
    name: header.name,
    description: header.description,
    intents: [...new Set([...(manifest.intents ?? []), ...header.intents])],
    endpoints,
  };
}
