/**
 * LLM-based Description Generator
 *
 * Uses Claude to generate human-readable skill descriptions
 * from captured API endpoint data.
 */

import type { ApiData } from "./types.js";

interface DescriptionResult {
  description: string;
  usedLlm: boolean;
}

/**
 * Generate a human-readable description for a skill using an LLM.
 * Falls back to template-based description if LLM is unavailable.
 */
export async function generateSkillDescription(
  service: string,
  data: ApiData,
): Promise<DescriptionResult> {
  const domain = new URL(data.baseUrl).hostname;
  const title = service.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const endpointCount = Object.keys(data.endpoints).length;

  // Extract endpoint info for the prompt
  const endpoints: { method: string; path: string }[] = [];
  for (const [, reqs] of Object.entries(data.endpoints)) {
    const req = reqs[0];
    endpoints.push({ method: req.method, path: req.path });
  }

  // Try to use Anthropic API
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      description: generateFallbackDescription(title, domain, endpointCount, endpoints, data.authMethod),
      usedLlm: false,
    };
  }

  try {
    const description = await callClaudeForDescription(apiKey, {
      service,
      title,
      domain,
      endpointCount,
      endpoints,
      authMethod: data.authMethod,
      hasAuthHeaders: Object.keys(data.authHeaders).length > 0,
      hasCookies: Object.keys(data.cookies).length > 0,
    });

    return { description, usedLlm: true };
  } catch (error) {
    console.error("LLM description generation failed, using fallback:", error);
    return {
      description: generateFallbackDescription(title, domain, endpointCount, endpoints, data.authMethod),
      usedLlm: false,
    };
  }
}

/**
 * Call Claude API to generate a skill description.
 */
async function callClaudeForDescription(
  apiKey: string,
  context: {
    service: string;
    title: string;
    domain: string;
    endpointCount: number;
    endpoints: { method: string; path: string }[];
    authMethod: string;
    hasAuthHeaders: boolean;
    hasCookies: boolean;
  },
): Promise<string> {
  // Summarize endpoints for the prompt (max 10 to keep token count low)
  const endpointSummary = context.endpoints
    .slice(0, 10)
    .map((e) => `${e.method} ${e.path}`)
    .join("\n");

  const prompt = `Write a concise, one-paragraph description (2-3 sentences max) for an API skill called "${context.service}".

Context:
- Domain: ${context.domain}
- Endpoints captured: ${context.endpointCount}
- Authentication: ${context.authMethod}${context.hasAuthHeaders ? " (headers captured)" : ""}${context.hasCookies ? " (cookies captured)" : ""}

Sample endpoints:
${endpointSummary}

Guidelines:
- Focus on what actions this API enables (e.g., "fetch user data", "post content", "manage settings")
- Mention the service name naturally
- Don't start with "This skill" or "This API"
- Don't mention "reverse-engineered" or "internal API" - just describe what it does
- Keep it practical and actionable
- Write in active voice

Example good descriptions:
- "Access Twitter's timeline, post tweets, and manage follows without the official API. Includes authentication handling and rate limit awareness."
- "Interact with Stripe's dashboard to view transactions, manage subscriptions, and export reports. Session-based auth with automatic token refresh."

Write only the description, nothing else:`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic API error (${response.status}): ${text}`);
  }

  const result = await response.json();
  const description = result.content?.[0]?.text?.trim();

  if (!description) {
    throw new Error("Empty response from Anthropic API");
  }

  return description;
}

/**
 * Generate a fallback description when LLM is not available.
 * Uses heuristics to create a more readable description than pure template.
 */
function generateFallbackDescription(
  title: string,
  domain: string,
  endpointCount: number,
  endpoints: { method: string; path: string }[],
  authMethod: string,
): string {
  // Analyze endpoints to infer capabilities
  const actions: string[] = [];
  const resources = new Set<string>();

  for (const ep of endpoints.slice(0, 20)) {
    const segments = ep.path.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1]?.replace(/[{}:]/g, "");

    if (lastSegment && !lastSegment.match(/^v\d|api|graphql|query/i)) {
      resources.add(lastSegment);
    }

    // Infer action from method
    if (ep.method === "GET" && ep.path.includes("{") || ep.path.includes(":")) {
      actions.push("fetch");
    } else if (ep.method === "POST") {
      actions.push("create");
    } else if (ep.method === "PUT" || ep.method === "PATCH") {
      actions.push("update");
    } else if (ep.method === "DELETE") {
      actions.push("delete");
    }
  }

  const uniqueActions = [...new Set(actions)];
  const resourceList = [...resources].slice(0, 3);

  // Build description
  let desc = `Interact with ${title}`;

  if (resourceList.length > 0) {
    desc += ` to manage ${resourceList.join(", ")}`;
  }

  if (uniqueActions.length > 0) {
    const actionVerbs = uniqueActions.map((a) => {
      switch (a) {
        case "fetch": return "retrieve data";
        case "create": return "create resources";
        case "update": return "update records";
        case "delete": return "remove items";
        default: return a;
      }
    });
    desc += `. Supports: ${actionVerbs.join(", ")}`;
  }

  desc += `. ${endpointCount} endpoints captured.`;

  if (authMethod && authMethod !== "Unknown" && authMethod !== "Unknown (may need login)") {
    desc += ` Auth: ${authMethod}.`;
  }

  return desc;
}
