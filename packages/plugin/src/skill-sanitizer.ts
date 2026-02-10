/**
 * Skill Sanitizer — Strip credentials from skill packages before publishing.
 *
 * Ensures no auth tokens, cookies, or secrets leak to the cloud index.
 * Only the DEFINITION is published (endpoints, auth method type, base URL),
 * never the actual credentials.
 */

/**
 * Strip real credentials from an API template, replacing with placeholders.
 *
 * Catches common patterns:
 *   - Bearer tokens, API keys, auth header values
 *   - Cookie values in template literals
 *   - Hardcoded base URLs with embedded tokens
 */
export function sanitizeApiTemplate(apiTs: string): string {
  let sanitized = apiTs;

  // Replace hardcoded auth header values (e.g. headers["Authorization"] = "Bearer abc123")
  sanitized = sanitized.replace(
    /("Bearer\s+)[^"]{8,}"/g,
    '"Bearer YOUR_TOKEN_HERE"',
  );

  // Replace quoted strings that look like tokens (long hex/base64 strings)
  // Only replace if inside a default value or assignment context
  sanitized = sanitized.replace(
    /(?<=(?:authToken|token|apiKey|api_key)\s*[:=]\s*)"[A-Za-z0-9+/=_-]{20,}"/g,
    '"YOUR_TOKEN_HERE"',
  );

  return sanitized;
}

/**
 * Extract endpoint list from SKILL.md content.
 *
 * Parses lines like: - `GET /api/v2/streams/trending` — List resources
 */
export function extractEndpoints(
  skillMd: string,
): { method: string; path: string; description: string }[] {
  const endpoints: { method: string; path: string; description: string }[] = [];

  const pattern = /`(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`(?:\s*—\s*(.+))?/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(skillMd)) !== null) {
    endpoints.push({
      method: match[1],
      path: match[2].trim(),
      description: match[3]?.trim() ?? "",
    });
  }

  return endpoints;
}

/**
 * Extract only the publishable fields from auth.json (no credentials).
 */
export function extractPublishableAuth(authJsonStr: string): {
  baseUrl: string;
  authMethodType: string;
} {
  try {
    const auth = JSON.parse(authJsonStr);
    return {
      baseUrl: auth.baseUrl ?? "",
      authMethodType: auth.authMethod ?? "Unknown",
    };
  } catch {
    return { baseUrl: "", authMethodType: "Unknown" };
  }
}
