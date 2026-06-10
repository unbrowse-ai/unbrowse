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
