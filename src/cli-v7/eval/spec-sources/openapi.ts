/**
 * OpenAPI / Swagger spec source for W22 `unbrowse eval spec`.
 *
 * Always-wrap rule (Pro 25:2 — "It is the glory of God to conceal a thing,
 * but the glory of kings is to search out a matter"): when a target site
 * publishes its API surface, that document IS the search-out, the
 * ground-truth AST. The capture-rank-judge dance is pure scaffolding
 * around a missing primary source.
 *
 * Pointer discipline (contract 3c2dd353): we surface endpoint METADATA
 * (path, method, summary, parameter NAMES + types). We do NOT pull
 * `examples` blocks or response sample bodies — they may carry sample
 * user data the spec author leaked.
 */
export interface OpenApiEndpoint {
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  /** Parameter metadata — name + in (query/path/header/cookie) + type, never example values. */
  readonly parameters: Array<{
    readonly name: string;
    readonly in: string;
    readonly required: boolean;
    readonly type: string;
  }>;
  /** Response schema shape, names only — no example values. */
  readonly response_schema_keys: string[];
}

export interface OpenApiHit {
  readonly source: "openapi" | "swagger";
  readonly url: string;
  readonly version: string;
  readonly endpoint_count: number;
  readonly endpoints: OpenApiEndpoint[];
}

/**
 * Parse an OpenAPI 3.x OR Swagger 2.x JSON document into our pointer-only
 * endpoint shape. Returns null when the document doesn't look like either
 * format (so the probe registers as a miss).
 */
export function parseOpenApiDoc(doc: unknown, url: string): OpenApiHit | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;

  // Version detection — OAS3 carries `openapi: "3.x"`; Swagger2 carries `swagger: "2.0"`.
  const openapiField = typeof d.openapi === "string" ? d.openapi : "";
  const swaggerField = typeof d.swagger === "string" ? d.swagger : "";
  const isOas3 = openapiField.startsWith("3.");
  const isSwagger2 = swaggerField.startsWith("2.");
  if (!isOas3 && !isSwagger2) return null;

  const paths = d.paths;
  if (!paths || typeof paths !== "object") {
    // Spec is shaped right but carries no paths block — still a hit, just empty.
    return {
      source: isOas3 ? "openapi" : "swagger",
      url,
      version: isOas3 ? openapiField : swaggerField,
      endpoint_count: 0,
      endpoints: [],
    };
  }

  const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "trace"]);
  const endpoints: OpenApiEndpoint[] = [];
  for (const [pathStr, pathItemRaw] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItemRaw || typeof pathItemRaw !== "object") continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of Object.keys(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const opObj = op as Record<string, unknown>;

      const summary = typeof opObj.summary === "string"
        ? opObj.summary
        : (typeof opObj.description === "string" ? opObj.description.slice(0, 200) : "");

      const parameters: OpenApiEndpoint["parameters"] = [];
      const paramSource = Array.isArray(opObj.parameters) ? opObj.parameters : [];
      // Also inherit path-level parameters (OAS allows both).
      const inheritedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
      for (const p of [...inheritedParams, ...paramSource]) {
        if (!p || typeof p !== "object") continue;
        const pObj = p as Record<string, unknown>;
        const name = typeof pObj.name === "string" ? pObj.name : "";
        if (!name) continue;
        const inField = typeof pObj.in === "string" ? pObj.in : "query";
        const required = pObj.required === true;
        // OAS3: type is under schema.type; Swagger2: top-level type.
        let typ = "string";
        if (pObj.schema && typeof pObj.schema === "object") {
          const sObj = pObj.schema as Record<string, unknown>;
          if (typeof sObj.type === "string") typ = sObj.type;
        } else if (typeof pObj.type === "string") {
          typ = pObj.type;
        }
        parameters.push({ name, in: inField, required, type: typ });
      }

      // Response schema KEY NAMES only — never sample values.
      const responseKeys: string[] = [];
      const responses = opObj.responses;
      if (responses && typeof responses === "object") {
        const rObj = responses as Record<string, unknown>;
        const okResp = rObj["200"] ?? rObj["201"] ?? rObj["default"];
        if (okResp && typeof okResp === "object") {
          const okObj = okResp as Record<string, unknown>;
          // OAS3 shape: { content: { "application/json": { schema: {...} } } }
          const content = okObj.content;
          if (content && typeof content === "object") {
            for (const ct of Object.values(content as Record<string, unknown>)) {
              if (ct && typeof ct === "object") {
                const ctObj = ct as Record<string, unknown>;
                if (ctObj.schema && typeof ctObj.schema === "object") {
                  const sObj = ctObj.schema as Record<string, unknown>;
                  if (sObj.properties && typeof sObj.properties === "object") {
                    responseKeys.push(...Object.keys(sObj.properties as Record<string, unknown>));
                  }
                }
              }
            }
          }
          // Swagger2 shape: { schema: { properties: {...} } }
          if (okObj.schema && typeof okObj.schema === "object") {
            const sObj = okObj.schema as Record<string, unknown>;
            if (sObj.properties && typeof sObj.properties === "object") {
              responseKeys.push(...Object.keys(sObj.properties as Record<string, unknown>));
            }
          }
        }
      }

      endpoints.push({
        method: method.toUpperCase(),
        path: pathStr,
        summary,
        parameters,
        response_schema_keys: responseKeys,
      });
    }
  }

  return {
    source: isOas3 ? "openapi" : "swagger",
    url,
    version: isOas3 ? openapiField : swaggerField,
    endpoint_count: endpoints.length,
    endpoints,
  };
}

/**
 * Fetch a probe URL with a 3s budget + same-origin redirect guard
 * (cross-domain redirects are recorded as a miss to prevent a malicious
 * site swapping its spec for evil.com's spec).
 *
 * Returns `null` on any failure shape (timeout / network / non-200 /
 * cross-origin redirect / not a JSON spec). Caller treats null as miss.
 */
export async function probeOpenApiUrl(
  url: string,
  budgetMs: number,
): Promise<OpenApiHit | null> {
  const originHost = (() => {
    try { return new URL(url).host; } catch { return ""; }
  })();
  if (!originHost) return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json, application/yaml;q=0.5" },
      redirect: "manual", // we enforce same-origin manually
      signal: ctrl.signal,
    });
    // Manual redirect handling — only follow same-host hops, max 3 hops.
    let resp = r;
    let hops = 0;
    let currentUrl = url;
    while (resp.status >= 300 && resp.status < 400 && hops < 3) {
      const loc = resp.headers.get("location");
      if (!loc) break;
      const nextUrl = new URL(loc, currentUrl).toString();
      const nextHost = new URL(nextUrl).host;
      if (nextHost !== originHost) {
        // Cross-domain redirect — refuse to follow (security rule).
        return null;
      }
      currentUrl = nextUrl;
      resp = await fetch(nextUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: ctrl.signal,
      });
      hops += 1;
    }
    if (resp.status !== 200) return null;
    const ct = resp.headers.get("content-type") ?? "";
    // YAML support is honest-pending — punt to JSON-only happy path.
    if (ct.includes("yaml") || ct.includes("yml")) return null;
    let doc: unknown;
    try {
      doc = await resp.json();
    } catch {
      return null;
    }
    return parseOpenApiDoc(doc, currentUrl);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
