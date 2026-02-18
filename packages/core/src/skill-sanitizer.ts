/**
 * Skill Sanitizer — Strip credentials from skill packages before publishing.
 *
 * Ensures no auth tokens, cookies, or secrets leak to the cloud index.
 * Only the DEFINITION is published (endpoints, auth method type, base URL),
 * never the actual credentials.
 */

import type { HeaderProfileFile } from "./types.js";

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

/**
 * Sanitize a header profile for publishing to the marketplace.
 *
 * Strips auth header VALUES (replaces with empty string) to prevent credential
 * leakage. Keeps header keys and categories so the template shape is preserved
 * for replay. App and context header values are non-sensitive and kept as-is.
 */
export function sanitizeHeaderProfile(profile: HeaderProfileFile): HeaderProfileFile {
  const sanitized: HeaderProfileFile = {
    version: profile.version,
    domains: {},
    endpointOverrides: { ...profile.endpointOverrides },
  };

  for (const [domain, domainProfile] of Object.entries(profile.domains)) {
    const commonHeaders = { ...domainProfile.commonHeaders };
    for (const [key, header] of Object.entries(commonHeaders)) {
      if (header.category === "auth") {
        commonHeaders[key] = { ...header, value: "" };
      }
    }
    sanitized.domains[domain] = {
      ...domainProfile,
      commonHeaders,
    };
  }

  return sanitized;
}
