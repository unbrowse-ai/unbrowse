/**
 * Path Normalizer — Context-aware wildcard endpoint detection.
 *
 * Detects dynamic segments in URL paths (IDs, UUIDs, tokens, timestamps)
 * and replaces them with named parameters using semantic context from
 * surrounding path segments.
 *
 * e.g. /users/123/orders/abc-def-ghi → /users/{userId}/orders/{orderId}
 *
 * Based on patterns from gigahard's improved-normalize-path.ts and
 * unbrowse-index's har-similarity.ts normalization.
 */

import type { PathParam } from "./types.js";

// ── Detection patterns (ordered by specificity) ───────────────────────────

const PATTERNS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  numeric: /^\d+$/,
  hex: /^[0-9a-f]{8,}$/i,
  base64: /^[A-Za-z0-9+/]{8,}={0,2}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  timestamp: /^\d{10,13}$/,
  email: /^[^@]+@[^@]+\.[^@]+$/,
  /** Slugs only if they look like generated IDs (mix of letters/digits with dashes) */
  slug: /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/i,
} as const;

// ── Resource name → parameter name mapping ────────────────────────────────

const RESOURCE_NAMES: Record<string, string[]> = {
  user: ["user", "users", "customer", "customers", "member", "members", "account", "accounts", "profile", "profiles", "people"],
  product: ["product", "products", "item", "items", "sku", "skus", "listing", "listings", "good", "goods"],
  order: ["order", "orders", "transaction", "transactions", "purchase", "purchases", "checkout", "checkouts"],
  post: ["post", "posts", "article", "articles", "blog", "blogs", "entry", "entries", "story", "stories"],
  comment: ["comment", "comments", "reply", "replies", "review", "reviews", "feedback"],
  message: ["message", "messages", "notification", "notifications", "chat", "chats", "conversation", "conversations"],
  file: ["file", "files", "document", "documents", "attachment", "attachments", "media", "upload", "uploads", "asset", "assets"],
  project: ["project", "projects", "workspace", "workspaces", "repo", "repos", "repository", "repositories"],
  team: ["team", "teams", "group", "groups", "org", "orgs", "organization", "organizations", "company", "companies"],
  category: ["category", "categories", "tag", "tags", "label", "labels", "topic", "topics", "collection", "collections"],
  session: ["session", "sessions", "token", "tokens"],
  payment: ["payment", "payments", "invoice", "invoices", "subscription", "subscriptions", "plan", "plans", "billing"],
  campaign: ["campaign", "campaigns", "promotion", "promotions"],
  event: ["event", "events", "activity", "activities", "log", "logs"],
  task: ["task", "tasks", "issue", "issues", "ticket", "tickets", "job", "jobs"],
  channel: ["channel", "channels", "stream", "streams", "feed", "feeds"],
  address: ["address", "addresses", "location", "locations"],
  role: ["role", "roles", "permission", "permissions"],
};

/** Static path segments that are never dynamic (API conventions). */
const STATIC_SEGMENTS = new Set([
  "api", "v1", "v2", "v3", "v4", "graphql", "rest", "rpc",
  "auth", "login", "logout", "signup", "register", "token", "refresh", "verify",
  "search", "filter", "sort", "export", "import", "bulk", "batch",
  "health", "status", "info", "version", "config", "settings", "preferences",
  "me", "self", "current", "public", "private", "internal", "admin",
  "list", "create", "update", "delete", "get", "set",
  "new", "edit", "view", "detail", "details", "summary",
  "count", "stats", "analytics", "metrics", "reports",
  "upload", "download",
]);

/** Version-like path segments (v1, v2, etc.) */
const VERSION_PATTERN = /^v\d+(\.\d+)*$/;

// ── Core normalization ────────────────────────────────────────────────────

export interface NormalizeResult {
  normalizedPath: string;
  pathParams: PathParam[];
}

/**
 * Detect the type of a dynamic path segment.
 * Returns null if the segment is a known static segment.
 */
function detectParamType(segment: string): PathParam["type"] | null {
  // Never replace version prefixes or known static segments
  if (VERSION_PATTERN.test(segment)) return null;
  if (STATIC_SEGMENTS.has(segment.toLowerCase())) return null;

  // Check patterns in order of specificity
  if (PATTERNS.uuid.test(segment)) return "uuid";
  if (PATTERNS.email.test(segment)) return "email";
  if (PATTERNS.date.test(segment)) return "date";
  if (PATTERNS.timestamp.test(segment)) return "numeric";
  if (PATTERNS.numeric.test(segment)) return "numeric";
  if (PATTERNS.hex.test(segment) && segment.length >= 8) return "hex";
  if (PATTERNS.slug.test(segment) && segment.length >= 8) return "slug";
  // base64 tokens tend to be long and used as session/auth tokens in URLs
  if (PATTERNS.base64.test(segment) && segment.length >= 16) return "base64";

  // Short alphanumeric strings that look like short IDs (e.g., "abc123")
  // Only if they contain both letters and digits — pure words are resource names
  if (/^[a-z0-9]{4,}$/i.test(segment) && /[a-z]/i.test(segment) && /\d/.test(segment)) {
    return "unknown";
  }

  return null;
}

/**
 * Derive a parameter name from the preceding path segment using
 * resource-aware naming.
 *
 * /users/123 → "userId"
 * /orders/abc-def → "orderId"
 * /unknown/xyz → "id"
 */
function deriveParamName(prevSegment: string | undefined, paramType: PathParam["type"]): string {
  if (paramType === "email") return "email";
  if (paramType === "date") return "date";

  if (!prevSegment) return "id";

  const prev = prevSegment.toLowerCase();

  // Check resource name mapping
  for (const [resourceType, names] of Object.entries(RESOURCE_NAMES)) {
    if (names.includes(prev)) {
      return `${resourceType}Id`;
    }
  }

  // Fallback: singularize the previous segment + "Id"
  let singular = prev;
  if (singular.endsWith("ies")) {
    singular = singular.slice(0, -3) + "y";
  } else if (singular.endsWith("ses") || singular.endsWith("xes") || singular.endsWith("zes")) {
    singular = singular.slice(0, -2);
  } else if (singular.endsWith("s") && !singular.endsWith("ss")) {
    singular = singular.slice(0, -1);
  }

  return `${singular}Id`;
}

/**
 * Normalize a URL path by replacing dynamic segments with named parameters.
 *
 * @param path - The raw URL path (e.g., "/api/v1/users/123/orders/abc-def-ghi-jkl")
 * @returns The normalized path and detected parameters
 *
 * @example
 * normalizePath("/api/v1/users/123/orders/abc-def-ghi-jkl")
 * // → { normalizedPath: "/api/v1/users/{userId}/orders/{orderId}", pathParams: [...] }
 */
export function normalizePath(path: string): NormalizeResult {
  const segments = path.split("/");
  const pathParams: PathParam[] = [];
  const usedNames = new Set<string>();

  const normalized = segments.map((segment, index) => {
    if (!segment) return segment; // preserve leading/trailing slashes

    const paramType = detectParamType(segment);
    if (!paramType) return segment; // static segment, keep as-is

    const prevSegment = index > 0 ? segments[index - 1] : undefined;
    let name = deriveParamName(prevSegment, paramType);

    // Deduplicate names: userId, userId2, userId3, etc.
    if (usedNames.has(name)) {
      let counter = 2;
      while (usedNames.has(`${name}${counter}`)) counter++;
      name = `${name}${counter}`;
    }
    usedNames.add(name);

    pathParams.push({
      name,
      position: index,
      exampleValue: segment,
      type: paramType,
    });

    return `{${name}}`;
  });

  return {
    normalizedPath: normalized.join("/"),
    pathParams,
  };
}

/**
 * Check if two normalized paths are the same endpoint
 * (identical after parameter replacement).
 */
export function isSamePath(path1: string, path2: string): boolean {
  return normalizePath(path1).normalizedPath === normalizePath(path2).normalizedPath;
}
