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
