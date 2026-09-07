/**
 * holed-tool-fill (client half of "the server hands a shape, the client fills it").
 *
 * The server hands the client a PII-censored "tool with holes": a URL template
 * with `{name}` placeholders. Each hole is either PUBLIC (kind:id, fill:llm) —
 * filled here from values the client's agent supplies — or SECRET (kind:secret,
 * fill:vault), which is deliberately NOT filled here. Secret holes are supplied
 * by the browser at fetch time via cookies (`credentials: "include"`), so they
 * never touch this code path.
 */

export interface Hole {
  location: { in: "query" | "header" | "path" | "body"; name?: string; index?: number };
  name: string;
  kind: "secret" | "id";
  fill: "vault" | "llm";
}

export interface HoledTool {
  endpoint_id: string;
  method: string;
  url_template: string;
  holes: Hole[];
}

export type FillResult =
  | { ok: true; url: string; method: string }
  | { ok: false; reason: string };

/** A get_route manifest endpoint (the shape hero-marketplace.ts returns). */
export interface ManifestEndpoint {
  endpoint_id?: string;
  method?: string;
  url?: string;
  url_template?: string;
  headers?: Record<string, string>;
  headers_template?: Record<string, string>;
}

const SECRET_HEADER = /^(authorization|cookie|x-api-key|api-?key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|authentication|bearer|token)$/i;

/** Produce a PII-censored holed tool from a resolved-skill manifest endpoint —
 *  the client half of endpointToHoledTool. Every {placeholder} in the URL is a
 *  public (fill:llm) query/path hole; secret auth headers become secret
 *  (fill:vault) holes. No values, no credentials. */
export function endpointToHoledTool(ep: ManifestEndpoint): HoledTool {
  const urlTemplate = ep.url ?? ep.url_template ?? "";
  const holes: Hole[] = [];
  const qIdx = urlTemplate.indexOf("?");
  if (qIdx >= 0) {
    for (const pair of urlTemplate.slice(qIdx + 1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const key = pair.slice(0, eq);
      if (/^\{[^}]+\}$/.test(pair.slice(eq + 1)) && key) {
        holes.push({ location: { in: "query", name: key }, name: key, kind: "id", fill: "llm" });
      }
    }
  }
  const pathPart = qIdx >= 0 ? urlTemplate.slice(0, qIdx) : urlTemplate;
  for (const m of pathPart.matchAll(/\{([^}]+)\}/g)) {
    const name = m[1];
    if (name && !holes.some((h) => h.name === name)) {
      holes.push({ location: { in: "path", index: -1 }, name, kind: "id", fill: "llm" });
    }
  }
  for (const k of Object.keys(ep.headers ?? ep.headers_template ?? {})) {
    if (SECRET_HEADER.test(k)) {
      holes.push({ location: { in: "header", name: k }, name: k, kind: "secret", fill: "vault" });
    }
  }
  return { endpoint_id: ep.endpoint_id ?? "", method: String(ep.method ?? "GET"), url_template: urlTemplate, holes };
}

/**
 * Fill the public (llm) holes of a holed tool from `values`. Secret (vault)
 * holes are left for the browser to supply at fetch time. Returns the filled
 * URL, or an honest failure naming the unfilled hole/placeholder.
 */
export function fillHoledTool(tool: HoledTool, values: Record<string, string>): FillResult {
  let url = tool.url_template;

  for (const hole of tool.holes) {
    if (hole.fill !== "llm") {
      // Secret/vault holes: ignored here — the browser supplies them at fetch.
      continue;
    }
    const value = values[hole.name];
    if (value === undefined || value === null) {
      return { ok: false, reason: `unfilled hole: ${hole.name}` };
    }
    // Replace every {name} occurrence with the encoded value.
    url = url.split(`{${hole.name}}`).join(encodeURIComponent(value));
  }

  // Secret (vault) holes intentionally leave their `{name}` placeholder in the
  // URL for the browser to supply at fetch. Exempt those from the leftover check;
  // any OTHER remaining placeholder is a genuine unfilled hole.
  const secretNames = new Set(
    tool.holes.filter((h) => h.fill === "vault").map((h) => h.name),
  );
  const leftover = url.replace(/\{([^}]*)\}/g, (match, name: string) =>
    secretNames.has(name) ? "" : match,
  );
  if (/\{[^}]*\}/.test(leftover)) {
    return { ok: false, reason: "unfilled placeholder" };
  }

  return { ok: true, url, method: tool.method };
}
