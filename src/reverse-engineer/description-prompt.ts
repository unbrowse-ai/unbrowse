export interface DescriptionContext {
  url_template: string;
  method: string;
  params: Array<{ name: string; in: string; example?: string }>;
  sample_response_keys?: string[];
  domain: string;
}

/**
 * Build a grounded prompt for LLM description generation.
 * Includes request params and sample response fields to prevent hallucination.
 */
export function buildDescriptionPrompt(ctx: DescriptionContext): string {
  const parts: string[] = [
    `Endpoint: ${ctx.method} ${ctx.url_template}`,
    `Domain: ${ctx.domain}`,
  ];

  if (ctx.params.length > 0) {
    parts.push("Parameters:");
    for (const p of ctx.params) {
      parts.push(`  - ${p.name} (${p.in})${p.example ? `: e.g. "${p.example}"` : ""}`);
    }
  }

  if (ctx.sample_response_keys && ctx.sample_response_keys.length > 0) {
    parts.push(`Response fields: ${ctx.sample_response_keys.join(", ")}`);
  }

  parts.push("Write a one-sentence description of what this endpoint does, grounded in the parameters and response fields above.");
  return parts.join("\n");
}

/**
 * Extract top-level keys from a sample JSON response for grounding.
 */
export function extractResponseKeys(sampleResponse: unknown): string[] {
  if (!sampleResponse || typeof sampleResponse !== "object") return [];
  const obj = sampleResponse as Record<string, unknown>;

  // If it's an array, look at first element
  if (Array.isArray(obj)) {
    return obj.length > 0 ? extractResponseKeys(obj[0]) : [];
  }

  return Object.keys(obj).slice(0, 20);
}

/**
 * Derive a one-line grounded description from actual endpoint data.
 * This replaces pure URL-heuristic descriptions with descriptions that
 * name actual params and response fields observed during capture.
 */
export function groundedDescription(ctx: DescriptionContext): string {
  // Extract path segments from the original template so we can identify
  // {param} placeholders before they get mangled by URL parsing.
  const url = tryParseUrl(ctx.url_template);
  const rawPathname = url
    ? extractPathname(ctx.url_template)
    : "";
  const pathSegments = rawPathname
    .split("/")
    .filter(Boolean)
    .filter((s) => !/^v\d+$/.test(s) && !/^\{[^}]+\}$/.test(s));
  const subject =
    pathSegments[pathSegments.length - 1] ?? url?.hostname ?? ctx.domain;

  const action = deriveAction(ctx.method, ctx.params, rawPathname);
  const parts: string[] = [`${action} ${titleCase(subject)}`];

  if (ctx.sample_response_keys && ctx.sample_response_keys.length > 0) {
    parts.push(`with ${ctx.sample_response_keys.slice(0, 6).join(", ")}`);
  }

  const paramNames = ctx.params.map((p) => p.name);
  if (paramNames.length > 0) {
    parts.push(`using ${paramNames.slice(0, 4).join(", ")}`);
  }

  return parts.join(" ");
}

function titleCase(text: string): string {
  return text
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function deriveAction(
  method: string,
  params: Array<{ name: string; in: string }>,
  pathname: string,
): string {
  const hasSearchParam = params.some((p) =>
    /^(q|query|search|term|keyword)$/i.test(p.name),
  );
  if (hasSearchParam || /search|find|lookup/i.test(pathname)) return "Searches";
  if (/status|health|incident|maintenance/i.test(pathname))
    return "Returns status for";
  switch (method.toUpperCase()) {
    case "POST":
      return "Creates";
    case "PUT":
    case "PATCH":
      return "Updates";
    case "DELETE":
      return "Deletes";
    default:
      if (pathname.match(/\{[^}]+\}|\/[0-9A-Za-z_-]{4,}(\/|$)/))
        return "Returns details for";
      return "Returns";
  }
}

function tryParseUrl(template: string): URL | null {
  try {
    return new URL(template.replace(/\{[^}]+\}/g, "_"));
  } catch {
    return null;
  }
}

/** Extract pathname from a URL template string, preserving {param} placeholders. */
function extractPathname(template: string): string {
  // Strip scheme + authority, then take everything before ? or #
  const afterScheme = template.replace(/^https?:\/\/[^/]*/, "");
  const pathOnly = afterScheme.split(/[?#]/)[0] ?? afterScheme;
  return pathOnly || "/";
}
