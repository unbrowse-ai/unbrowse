import type { EndpointDescriptor } from "../types/index.js";

const SECRET_VALUE_PATTERNS = [
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /^Bearer\s+\S+/i,
  /^Basic\s+[A-Za-z0-9+/=]+/i,
  /^ghp_[A-Za-z0-9]{36}/,
  /^sk-[A-Za-z0-9]{20,}/,
  /^pk_(live|test)_[A-Za-z0-9]+/,
  /^xox[bsrp]-[A-Za-z0-9-]+/,
  /^AKIA[A-Z0-9]{16}/,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
  /^v2\.[A-Za-z0-9_-]{20,}/,
];

const SECRET_KEY_PATTERNS = /^(api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|password|passwd|session[_-]?id|session[_-]?token|csrf[_-]?token|client[_-]?secret|bearer|refresh[_-]?token|id[_-]?token|jwt|nonce|otp|pin|ssn|credit[_-]?card)$/i;

export function looksLikeSecret(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length < 8) return false;
  if (SECRET_KEY_PATTERNS.test(key)) return true;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactSecrets(obj: unknown, parentKey = ""): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return looksLikeSecret(parentKey, obj) ? "[REDACTED]" : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item, parentKey));
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactSecrets(value, key);
    }
    return result;
  }
  return obj;
}

function synthesizePlaceholder(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return Number.isInteger(value) ? 12345 : 99.99;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (looksLikeSecret(key, value)) return "[REDACTED]";
    if (/@/.test(value)) return "user@example.com";
    if (/^https?:\/\//.test(value)) return "https://example.com/item/123";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(value)) return "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    if (/^\d+$/.test(value)) return "12345";
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "2026-01-15T00:00:00Z";
    if (value.length <= 8) return "abc123";
    if (value.length > 100) return "Example description text for this item.";
    return "example-value";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? [synthesizeExample(value[0], 0)] : [];
  }
  if (typeof value === "object") {
    return synthesizeExample(value, 0);
  }
  return value;
}

export function synthesizeExample(obj: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return synthesizePlaceholder("", obj);
  if (Array.isArray(obj)) {
    return obj.slice(0, 2).map((item) => synthesizeExample(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = typeof value === "object" && value !== null
      ? synthesizeExample(value, depth + 1)
      : synthesizePlaceholder(key, value);
  }
  return result;
}

export function sanitizeForPublish(endpoints: EndpointDescriptor[]): EndpointDescriptor[] {
  return endpoints.map((endpoint) => {
    const clean = { ...endpoint };

    if (clean.headers_template) {
      clean.headers_template = redactSecrets(clean.headers_template) as Record<string, string>;
    }
    if (clean.query) {
      clean.query = redactSecrets(clean.query) as Record<string, unknown>;
    }
    if (clean.body) {
      clean.body = redactSecrets(clean.body) as Record<string, unknown>;
    }
    if (clean.query) {
      clean.query = Object.fromEntries(
        Object.entries(clean.query).map(([key, value]) => [key, typeof value === "string" ? "example" : value]),
      );
    }
    if (clean.path_params) {
      clean.path_params = Object.fromEntries(
        Object.keys(clean.path_params).map((key) => [key, "example"]),
      );
    }
    if (clean.body) clean.body = synthesizeExample(clean.body) as Record<string, unknown>;
    if (clean.body_params) clean.body_params = synthesizeExample(clean.body_params) as Record<string, unknown>;

    if (clean.headers_template) {
      clean.headers_template = Object.fromEntries(
        Object.keys(clean.headers_template).map((key) => [key, ""]),
      );
    }

    if (clean.trigger_url) {
      try {
        const parsed = new URL(clean.trigger_url);
        clean.trigger_url = parsed.origin + parsed.pathname;
      } catch {
        /* keep original */
      }
    }

    if (clean.semantic) {
      const semantic = { ...clean.semantic };
      if (semantic.example_response_compact) {
        semantic.example_response_compact = synthesizeExample(semantic.example_response_compact);
      }
      if (semantic.example_request) {
        semantic.example_request = synthesizeExample(semantic.example_request);
      }
      if (semantic.sample_request_url) {
        try {
          const parsed = new URL(semantic.sample_request_url);
          for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, "example");
          semantic.sample_request_url = parsed.toString();
        } catch {
          delete semantic.sample_request_url;
        }
      }
      if (semantic.requires) {
        semantic.requires = semantic.requires.map((binding) => {
          const { example_value: _exampleValue, ...rest } = binding;
          return rest;
        });
      }
      if (semantic.provides) {
        semantic.provides = semantic.provides.map((binding) => {
          const { example_value: _exampleValue, ...rest } = binding;
          return rest;
        });
      }
      clean.semantic = semantic;
    }

    return clean;
  });
}
