// Protocol-shape hole decomposition for non-REST endpoints.
//
// Extracted verbatim from execution/index.ts (the protocol-decomposers block)
// so the executor monolith stays focused on ranking + execution. Each protocol
// (GraphQL / Connect-gRPC / JSON-RPC / form-urlencoded|multipart / SOAP-XML)
// follows the same shape: a captured request has FIXED structure + variable
// HOLES; decompose* surfaces the holes as flat agent params, build* reconstructs
// the wire body from agent-supplied values. See execution/index.ts for callers.

import type { EndpointDescriptor } from "../types/index.js";

/**
 * GraphQL endpoints (especially X.com / LinkedIn / TikTok) capture as URL
 * templates with opaque {variables} and {features} JSON slots. Agents shouldn't
 * have to hand-craft those JSON blobs — they should pass flat params like q,
 * count, cursor and the executor reconstructs the GraphQL request shape from
 * the captured example.
 *
 * decomposeGraphqlEndpoint detects GraphQL endpoints, parses the captured
 * example_request.variables JSON into per-leaf agent params, and returns the
 * shape the resolver and executor need.
 */
export interface GraphqlDecomposition {
  isGraphql: boolean;
  operationName?: string;
  variablesTemplate?: Record<string, unknown>;
  featuresTemplate?: string;
  /** Flat agent-friendly params derived from variables.top_level_keys */
  agentParams: Array<{
    key: string;
    semantic_type: string;
    required: boolean;
    example: unknown;
    /** Path inside variables JSON, e.g. "rawQuery" or "userId" */
    variables_path: string;
  }>;
}

export function decomposeGraphqlEndpoint(endpoint: EndpointDescriptor): GraphqlDecomposition {
  const url = endpoint.url_template ?? "";
  const looksGraphql =
    /\/graphql\//i.test(url) ||
    /\bvariables=\{variables\}/.test(url) ||
    (Array.isArray(endpoint.semantic?.requires) &&
      endpoint.semantic!.requires.some((r) => r.key === "variables") &&
      endpoint.semantic!.requires.some((r) => r.key === "features"));
  if (!looksGraphql) return { isGraphql: false, agentParams: [] };

  // Operation name = last URL segment (before query string)
  let operationName: string | undefined;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    if (segs.length) operationName = segs[segs.length - 1];
  } catch { /* ignore */ }

  const exampleReq = (endpoint.semantic?.example_request ?? endpoint.body ?? {}) as Record<string, unknown>;
  let variablesTemplate: Record<string, unknown> | undefined;
  const rawVariables = exampleReq.variables;
  if (rawVariables && typeof rawVariables === "object") {
    variablesTemplate = rawVariables as Record<string, unknown>;
  } else if (typeof rawVariables === "string") {
    try { variablesTemplate = JSON.parse(rawVariables); } catch { /* ignore */ }
  }
  let featuresTemplate: string | undefined;
  const rawFeatures = exampleReq.features;
  if (typeof rawFeatures === "string") featuresTemplate = rawFeatures;
  else if (rawFeatures && typeof rawFeatures === "object") featuresTemplate = JSON.stringify(rawFeatures);

  // Build agentParams from variables top-level keys.
  const agentParams: GraphqlDecomposition["agentParams"] = [];
  if (variablesTemplate) {
    for (const [key, value] of Object.entries(variablesTemplate)) {
      // Skip placeholder-only keys ({variables_seentweetids_0} etc.)
      if (typeof value === "string" && /^\{[a-z0-9_]+_\d+\}$/i.test(value)) continue;
      // Skip arrays of placeholders (the captured payload's seenTweetIds shape)
      if (Array.isArray(value) && value.every((v) => typeof v === "string" && /^\{[a-z0-9_]+_\d+\}$/i.test(v))) continue;
      // Surface scalar leaves only — skip nested objects and arrays of objects
      if (value && typeof value === "object" && !Array.isArray(value)) continue;
      agentParams.push({
        key,
        semantic_type: typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "input",
        required: false,
        example: value,
        variables_path: key,
      });
    }
  }

  return {
    isGraphql: true,
    operationName,
    variablesTemplate,
    featuresTemplate,
    agentParams,
  };
}

/**
 * Build the URL-encoded {variables, features} pair for a GraphQL endpoint
 * given agent-supplied flat params. Falls back to captured example values
 * for any field the agent didn't provide. Used by executeEndpoint when it
 * detects a GraphQL endpoint.
 */
export function buildGraphqlRequestParams(
  decomp: GraphqlDecomposition,
  agentParams: Record<string, unknown>,
): { variables: string; features: string } {
  const vars: Record<string, unknown> = decomp.variablesTemplate ? JSON.parse(JSON.stringify(decomp.variablesTemplate)) : {};
  // Drop placeholder pseudo-values from the example so they don't leak into the request
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string" && /^\{[a-z0-9_]+_\d+\}$/i.test(v)) delete vars[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "string" && /^\{[a-z0-9_]+_\d+\}$/i.test(x))) delete vars[k];
  }
  // Fill from agent params by direct key match. Agents read agentParams[].key
  // (the actual GraphQL variables key with its example value) and pass that
  // verbatim. No alias registry — if the agent wants `q` to map to `rawQuery`,
  // they can read decomp.agentParams to see the real key, or an LLM judge can
  // reshape the params on the way in.
  for (const [k, v] of Object.entries(agentParams)) {
    if (vars[k] !== undefined || decomp.agentParams.some((p) => p.variables_path === k)) {
      vars[k] = v;
    }
  }
  return {
    variables: JSON.stringify(vars),
    features: decomp.featuresTemplate ?? "{}",
  };
}

// ── Connect/gRPC hole decomposition ──────────────────────────────────────────
// The gRPC analog of decomposeGraphqlEndpoint. A Connect/gRPC unary endpoint is
// POST JSON over `/<dotted.package>.<Service>/<Method>`; the service/method PATH
// is fixed structure and the request MESSAGE fields are the holes the agent fills
// (mirrors GraphQL: query=structure, variables=holes). The agent passes flat
// fields (`tweetId`, `userId`); buildGrpcRequestBody reconstructs the JSON message.
export interface GrpcDecomposition {
  isGrpc: boolean;
  /** Dotted package.Service, e.g. "tweet.v1.TweetService" */
  service?: string;
  /** Unary method name, e.g. "GetTweet" */
  method?: string;
  /** Captured request-message shape (the Connect JSON body). */
  messageTemplate?: Record<string, unknown>;
  /** Flat agent-fillable holes from the request message's top-level scalar fields. */
  agentParams: Array<{
    key: string;
    semantic_type: string;
    required: boolean;
    example: unknown;
    /** Path inside the request message JSON, e.g. "tweetId". */
    message_path: string;
  }>;
}

// Connect/gRPC unary path shape: /<dotted.package>.<Service>/<Method>
const GRPC_PATH_RE = /\/([A-Za-z_][\w.]*\.[A-Za-z_]\w*)\/([A-Za-z_]\w*)\/?$/;
const GRPC_PLACEHOLDER_RE = /^\{[a-z0-9_]+(_\d+)?\}$/i;

export function decomposeGrpcEndpoint(endpoint: EndpointDescriptor): GrpcDecomposition {
  const url = endpoint.url_template ?? "";
  let service: string | undefined;
  let method: string | undefined;
  let pathMatch: RegExpMatchArray | null = null;
  try {
    pathMatch = new URL(url).pathname.match(GRPC_PATH_RE);
  } catch {
    pathMatch = url.match(GRPC_PATH_RE);
  }
  if (!pathMatch) return { isGrpc: false, agentParams: [] };
  service = pathMatch[1];
  method = pathMatch[2];

  const exampleReq = (endpoint.semantic?.example_request ?? endpoint.body ?? {}) as unknown;
  let messageTemplate: Record<string, unknown> | undefined;
  if (exampleReq && typeof exampleReq === "object" && !Array.isArray(exampleReq)) {
    messageTemplate = exampleReq as Record<string, unknown>;
  } else if (typeof exampleReq === "string") {
    try {
      const parsed = JSON.parse(exampleReq);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) messageTemplate = parsed;
    } catch { /* ignore */ }
  }

  const agentParams: GrpcDecomposition["agentParams"] = [];
  if (messageTemplate) {
    for (const [key, value] of Object.entries(messageTemplate)) {
      if (value && typeof value === "object") continue; // surface scalar leaves only
      // A clean named placeholder ("{tweetId}") is an explicit REQUIRED hole — surface
      // it (example null), don't drop it; a real captured value is an OPTIONAL hole
      // whose captured value is the example/default.
      const isPlaceholder = typeof value === "string" && GRPC_PLACEHOLDER_RE.test(value);
      agentParams.push({
        key,
        semantic_type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string",
        required: isPlaceholder,
        example: isPlaceholder ? null : value,
        message_path: key,
      });
    }
  }
  return { isGrpc: true, service, method, messageTemplate, agentParams };
}

/**
 * Reconstruct the Connect/gRPC request-message JSON body from the captured message
 * template + agent-supplied flat params. Drops placeholder pseudo-values; the agent's
 * value (or pointer) wins. Mirrors buildGraphqlRequestParams.
 */
export function buildGrpcRequestBody(
  decomp: GrpcDecomposition,
  agentParams: Record<string, unknown>,
): string {
  const msg: Record<string, unknown> = decomp.messageTemplate
    ? JSON.parse(JSON.stringify(decomp.messageTemplate))
    : {};
  for (const [k, v] of Object.entries(msg)) {
    if (typeof v === "string" && GRPC_PLACEHOLDER_RE.test(v)) delete msg[k];
  }
  for (const [k, v] of Object.entries(agentParams)) {
    if (msg[k] !== undefined || decomp.agentParams.some((p) => p.message_path === k)) {
      msg[k] = v;
    }
  }
  return JSON.stringify(msg);
}

// ── JSON-RPC 2.0 hole decomposition ──────────────────────────────────────────
// Same shape as GraphQL/gRPC: the `method` is fixed structure, the `params` object
// fields are the holes the agent fills. Detects {"jsonrpc":"2.0","method":...,"params":{...}}.
// Named (object) params are decomposed; positional (array) params are passed through.
const HOLE_PLACEHOLDER_RE = /^\{[a-z0-9_]+(_\d+)?\}$/i;
function scalarType(v: unknown): string {
  return typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
}

export interface JsonRpcDecomposition {
  isJsonRpc: boolean;
  method?: string;
  /** Named params template (object) or positional (array). */
  paramsTemplate?: Record<string, unknown> | unknown[];
  positional: boolean;
  agentParams: Array<{ key: string; semantic_type: string; required: boolean; example: unknown; params_path: string }>;
}

function parseBodyObject(endpoint: EndpointDescriptor): Record<string, unknown> | undefined {
  const ex = (endpoint.semantic?.example_request ?? endpoint.body ?? undefined) as unknown;
  if (ex && typeof ex === "object" && !Array.isArray(ex)) return ex as Record<string, unknown>;
  if (typeof ex === "string") {
    try { const p = JSON.parse(ex); if (p && typeof p === "object" && !Array.isArray(p)) return p; } catch { /* ignore */ }
  }
  return undefined;
}

export function decomposeJsonRpcEndpoint(endpoint: EndpointDescriptor): JsonRpcDecomposition {
  const body = parseBodyObject(endpoint);
  const isJsonRpc = !!body && (body.jsonrpc === "2.0" || ("method" in body && "params" in body));
  if (!body || !isJsonRpc) return { isJsonRpc: false, positional: false, agentParams: [] };
  const method = typeof body.method === "string" ? body.method : undefined;
  const params = body.params;
  const agentParams: JsonRpcDecomposition["agentParams"] = [];
  let positional = false;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (v && typeof v === "object") continue; // scalar leaves only
      const ph = typeof v === "string" && HOLE_PLACEHOLDER_RE.test(v);
      agentParams.push({ key: k, semantic_type: scalarType(v), required: ph, example: ph ? null : v, params_path: k });
    }
  } else if (Array.isArray(params)) {
    positional = true;
    params.forEach((v, i) => {
      if (v && typeof v === "object") return;
      const ph = typeof v === "string" && HOLE_PLACEHOLDER_RE.test(v);
      agentParams.push({ key: `params[${i}]`, semantic_type: scalarType(v), required: ph, example: ph ? null : v, params_path: String(i) });
    });
  }
  return { isJsonRpc: true, method, paramsTemplate: params as Record<string, unknown> | unknown[] | undefined, positional, agentParams };
}

/** Reconstruct the full JSON-RPC 2.0 request body from agent flat params. */
export function buildJsonRpcRequestBody(
  decomp: JsonRpcDecomposition,
  agentParams: Record<string, unknown>,
  base?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { jsonrpc: "2.0", ...(base ?? {}) };
  if (decomp.method) out.method = decomp.method;
  if (decomp.positional && Array.isArray(decomp.paramsTemplate)) {
    const arr = JSON.parse(JSON.stringify(decomp.paramsTemplate)) as unknown[];
    for (const [k, v] of Object.entries(agentParams)) {
      const m = /^params\[(\d+)\]$/.exec(k);
      if (m) arr[Number(m[1])] = v;
    }
    out.params = arr.map((x) => (typeof x === "string" && HOLE_PLACEHOLDER_RE.test(x) ? null : x));
  } else {
    const p: Record<string, unknown> = decomp.paramsTemplate && !Array.isArray(decomp.paramsTemplate)
      ? JSON.parse(JSON.stringify(decomp.paramsTemplate)) : {};
    for (const [k, v] of Object.entries(p)) if (typeof v === "string" && HOLE_PLACEHOLDER_RE.test(v)) delete p[k];
    for (const [k, v] of Object.entries(agentParams)) {
      if (p[k] !== undefined || decomp.agentParams.some((ap) => ap.params_path === k)) p[k] = v;
    }
    out.params = p;
  }
  if (out.id === undefined) out.id = 1;
  return out;
}

// ── form-data / urlencoded hole decomposition ────────────────────────────────
// A form POST (application/x-www-form-urlencoded or multipart/form-data) carries
// its inputs as top-level body fields — the holes the agent fills. The captured
// content-type header selects the encoding; serializeReplayBody already handles
// the wire format, so the body object's scalar fields are the holes.
export interface FormDecomposition {
  isForm: boolean;
  encoding?: "urlencoded" | "multipart";
  agentParams: Array<{ key: string; semantic_type: string; required: boolean; example: unknown; field_path: string }>;
}

export function decomposeFormEndpoint(endpoint: EndpointDescriptor): FormDecomposition {
  const ht = (endpoint.headers_template ?? {}) as Record<string, string>;
  const ct = (ht["content-type"] ?? ht["Content-Type"] ?? "").toString();
  const encoding: FormDecomposition["encoding"] | undefined =
    /multipart\/form-data/i.test(ct) ? "multipart" : /x-www-form-urlencoded/i.test(ct) ? "urlencoded" : undefined;
  if (!encoding) return { isForm: false, agentParams: [] };
  const body = parseBodyObject(endpoint);
  const agentParams: FormDecomposition["agentParams"] = [];
  if (body) {
    for (const [k, v] of Object.entries(body)) {
      if (v && typeof v === "object") continue; // scalar form fields only
      const ph = typeof v === "string" && HOLE_PLACEHOLDER_RE.test(v);
      agentParams.push({ key: k, semantic_type: scalarType(v), required: ph, example: ph ? null : v, field_path: k });
    }
  }
  return { isForm: true, encoding, agentParams };
}

/** Reconstruct the form body object from agent flat params (serializeReplayBody encodes it). */
export function buildFormRequestBody(
  decomp: FormDecomposition,
  agentParams: Record<string, unknown>,
  template?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = template ? JSON.parse(JSON.stringify(template)) : {};
  for (const [k, v] of Object.entries(out)) if (typeof v === "string" && HOLE_PLACEHOLDER_RE.test(v)) delete out[k];
  for (const [k, v] of Object.entries(agentParams)) {
    if (out[k] !== undefined || decomp.agentParams.some((ap) => ap.field_path === k)) out[k] = v;
  }
  return out;
}

// ── SOAP / XML body hole decomposition ───────────────────────────────────────
// An XML/SOAP request body is fixed envelope structure with variable LEAF-element
// text values — the holes. Detect via content-type (text/xml | application/xml |
// application/soap+xml) or a body that opens with <?xml / <…Envelope / a tag. Leaf
// elements <tag>text</tag> (no child tags) become flat holes; buildXmlRequestBody
// substitutes the agent's value into the matching element, preserving the envelope.
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function rawBodyString(endpoint: EndpointDescriptor): string | undefined {
  const ex = (endpoint.semantic?.example_request ?? endpoint.body) as unknown;
  return typeof ex === "string" ? ex : undefined;
}

export interface XmlDecomposition {
  isXml: boolean;
  flavor?: "soap" | "xml";
  rootElement?: string;
  template?: string;
  agentParams: Array<{ key: string; semantic_type: string; required: boolean; example: unknown; xml_path: string }>;
}

export function decomposeXmlEndpoint(endpoint: EndpointDescriptor): XmlDecomposition {
  const ht = (endpoint.headers_template ?? {}) as Record<string, string>;
  const ct = (ht["content-type"] ?? ht["Content-Type"] ?? "").toString();
  const raw = rawBodyString(endpoint);
  const ctXml = /(?:text|application)\/(?:soap\+)?xml/i.test(ct);
  const bodyXml = !!raw && /^\s*<(?:\?xml|[a-zA-Z_])/.test(raw);
  if (!(ctXml || bodyXml) || !raw) return { isXml: false, agentParams: [] };
  const flavor: XmlDecomposition["flavor"] = /soap/i.test(ct) || /<[\w]*:?Envelope[\s>]/i.test(raw) ? "soap" : "xml";
  const rootM = raw.replace(/<\?xml[^>]*\?>/i, "").match(/<([a-zA-Z_][\w.-]*(?::[\w.-]+)?)[\s>]/);
  const rootElement = rootM?.[1];

  const agentParams: XmlDecomposition["agentParams"] = [];
  const seen = new Set<string>();
  const leafRe = /<([a-zA-Z_][\w.-]*(?::[\w.-]+)?)\s*>([^<>]*)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = leafRe.exec(raw)) !== null) {
    const tag = m[1];
    const val = m[2];
    if (seen.has(tag)) continue;
    seen.add(tag);
    const ph = HOLE_PLACEHOLDER_RE.test(val.trim());
    agentParams.push({
      key: tag.includes(":") ? (tag.split(":").pop() as string) : tag,
      semantic_type: "string",
      required: ph,
      example: ph ? null : val,
      xml_path: tag,
    });
  }
  return { isXml: true, flavor, rootElement, template: raw, agentParams };
}

/** Reconstruct the XML/SOAP body by substituting the agent's values into leaf elements. */
export function buildXmlRequestBody(decomp: XmlDecomposition, agentParams: Record<string, unknown>): string {
  let xml = decomp.template ?? "";
  for (const ap of decomp.agentParams) {
    const provided = agentParams[ap.key] ?? agentParams[ap.xml_path];
    const open = `<${escapeRe(ap.xml_path)}\\s*>`;
    const close = `</${escapeRe(ap.xml_path)}>`;
    if (provided === undefined) {
      // no value supplied → blank a placeholder leaf so "{tag}" never goes on the wire
      xml = xml.replace(new RegExp(`(${open})\\s*\\{[a-z0-9_]+(?:_\\d+)?\\}\\s*(${close})`, "i"), "$1$2");
      continue;
    }
    xml = xml.replace(new RegExp(`(${open})[^<>]*(${close})`), `$1${String(provided)}$2`);
  }
  return xml;
}
