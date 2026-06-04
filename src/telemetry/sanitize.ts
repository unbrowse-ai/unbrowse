// MCP telemetry sanitizer.
//
// Strips PII-shaped values from tool arguments, URLs, and free-text fields
// before they are written to the local session log or uploaded.
//
// Hardcoding guard (CLAUDE.md > "the platform enables; it does not
// prescribe"): this module contains ONLY structural redactors — pattern
// classes that recognise data shape (email, uuid, ip, etc.), URL parsing,
// schema summarisers. No "what counts as a bad endpoint", no slow-threshold
// constants, no banned-phrase lists. Classification of "this session is a
// bug report" lives in the worker-side triage job, not here.

import { createHash } from "node:crypto";

const SHA_HEX_PER_BYTE = 2;
const SHA_LEN_INTENT = 32; // 16 bytes hex → 32 chars
const SHA_LEN_VALUE = 16; // 8 bytes hex → 16 chars
const SHA_LEN_FP = 32;

export function shaHex(input: string, hexLen: number): string {
  const bytes = Math.ceil(hexLen / SHA_HEX_PER_BYTE);
  return createHash("sha256").update(input).digest("hex").slice(0, hexLen);
  void bytes;
}

// --- value-shape classifiers -------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g;
// E.164-ish phone: leading + and 7-15 digits with optional separators.
const PHONE_RE = /\+\d[\d\s()-]{6,18}/g;
// Credit-card-ish: 13-19 contiguous digits, often grouped.
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;
// Long hex token (8+ chars) — likely an ID, hash, or JWT segment.
const HEX_TOKEN_RE = /\b[0-9a-f]{8,}\b/gi;
// Bearer / JWT-shaped token: three base64url segments separated by dots.
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

function isEntityShapedSegment(segment: string): boolean {
  if (!segment) return false;
  if (UUID_RE.test(segment)) return true;
  UUID_RE.lastIndex = 0;
  if (/^\d+$/.test(segment)) return true; // numeric id
  if (/^[0-9a-f]{8,}$/i.test(segment)) return true; // long hex
  if (EMAIL_RE.test(segment)) return true;
  EMAIL_RE.lastIndex = 0;
  if (segment.length >= 24) return true; // anything long is probably an opaque token
  // Mixed alphanumeric, no separators, ≥6 chars → opaque ID (reddit post ids,
  // youtube ids, base36/base58 tokens). Structural shape check, not a per-site
  // rule.
  if (segment.length >= 6 && /^[A-Za-z0-9]+$/.test(segment) && /[A-Za-z]/.test(segment) && /\d/.test(segment)) {
    return true;
  }
  // Kebab/snake-cased identifier ≥4 chars. Catches usernames (lewis-tham),
  // slugs (some-post-slug), snake-case ids. False-positives: locale tags
  // (en-US), some content paths (release-notes) — clustering still works,
  // we trade path semantics for PII safety.
  if (segment.length >= 4 && /[-_]/.test(segment) && /^[A-Za-z0-9._-]+$/.test(segment)) {
    return true;
  }
  return false;
}

function entityKind(segment: string): "uuid" | "id" | "hex" | "email" | "token" {
  UUID_RE.lastIndex = 0;
  if (UUID_RE.test(segment)) return "uuid";
  UUID_RE.lastIndex = 0;
  if (/^\d+$/.test(segment)) return "id";
  if (/^[0-9a-f]{8,}$/i.test(segment)) return "hex";
  EMAIL_RE.lastIndex = 0;
  if (EMAIL_RE.test(segment)) return "email";
  EMAIL_RE.lastIndex = 0;
  return "token";
}

// --- free-text scrubber -----------------------------------------------------

export function scrubText(input: string): string {
  if (!input) return input;
  return input
    .replace(JWT_RE, "<jwt>")
    .replace(EMAIL_RE, "<email>")
    .replace(UUID_RE, "<uuid>")
    .replace(IPV6_RE, "<ip6>")
    .replace(IPV4_RE, "<ip4>")
    .replace(PHONE_RE, "<phone>")
    .replace(CARD_RE, "<card>");
}

// --- URL templating ---------------------------------------------------------

export type UrlTemplate = {
  scheme: string;
  host: string;
  path_template: string;
  query_keys: string[];
};

export function templateUrl(raw: string): UrlTemplate | { invalid: true; original_fingerprint: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { invalid: true, original_fingerprint: shaHex(raw, SHA_LEN_FP) };
  }
  const segments = u.pathname.split("/").map((s) => {
    if (!s) return s;
    if (isEntityShapedSegment(s)) return `{${entityKind(s)}}`;
    return s;
  });
  const query_keys: string[] = [];
  u.searchParams.forEach((_value, key) => {
    if (!query_keys.includes(key)) query_keys.push(key);
  });
  return {
    scheme: u.protocol.replace(/:$/, ""),
    host: u.hostname,
    path_template: segments.join("/"),
    query_keys,
  };
}

// --- intent fingerprint -----------------------------------------------------

export type IntentFingerprint = {
  intent_hash: string;
  length: number;
  word_count: number;
};

export function fingerprintIntent(input: unknown): IntentFingerprint | undefined {
  if (typeof input !== "string" || input.length === 0) return undefined;
  return {
    intent_hash: shaHex(input, SHA_LEN_INTENT),
    length: input.length,
    word_count: input.split(/\s+/).filter(Boolean).length,
  };
}

// --- response shape summary -------------------------------------------------

export type ResponseSummary = {
  shape: "array" | "object" | "string" | "null" | "number" | "boolean";
  bytes: number;
  item_count?: number;
  top_keys?: string[];
};

const TOP_KEYS_LIMIT = 8;

export function summarizeResponse(value: unknown): ResponseSummary {
  if (value === null || value === undefined) {
    return { shape: "null", bytes: 0 };
  }
  if (Array.isArray(value)) {
    const json = JSON.stringify(value);
    return { shape: "array", bytes: json.length, item_count: value.length };
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).slice(0, TOP_KEYS_LIMIT);
    const json = JSON.stringify(obj);
    return { shape: "object", bytes: json.length, top_keys: keys };
  }
  if (typeof value === "string") {
    return { shape: "string", bytes: value.length };
  }
  if (typeof value === "number") {
    return { shape: "number", bytes: String(value).length };
  }
  return { shape: "boolean", bytes: 1 };
}

// --- args sanitizer ---------------------------------------------------------
//
// Recursive walk over tool arguments. Known sensitive keys (intent, url,
// query, headers, body) get per-shape treatment. Other strings get the
// free-text scrubber. Other primitives pass through.

const INTENT_KEYS = new Set(["intent", "goal", "objective", "task"]);
const URL_KEYS = new Set(["url", "uri", "endpoint", "href"]);
const HEADER_KEYS = new Set(["headers", "auth", "authorization", "cookie", "token", "api_key", "apikey", "key"]);
const BODY_KEYS = new Set(["body", "data", "payload", "request_body"]);
const MAX_DEPTH = 6;

export type SanitizedArgs = Record<string, unknown>;

export function sanitizeArgs(input: unknown): SanitizedArgs {
  if (!input || typeof input !== "object") return {};
  return walk(input as Record<string, unknown>, 0) as SanitizedArgs;
}

function walk(node: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "<truncated:depth>";
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
  if (typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = walkField(key, value, depth + 1);
    }
    return out;
  }
  if (typeof node === "string") return scrubText(node);
  return node;
}

function walkField(key: string, value: unknown, depth: number): unknown {
  const lc = key.toLowerCase();
  if (HEADER_KEYS.has(lc)) return "<redacted:header>";
  if (INTENT_KEYS.has(lc) && typeof value === "string") return fingerprintIntent(value);
  if (URL_KEYS.has(lc) && typeof value === "string") return templateUrl(value);
  if (BODY_KEYS.has(lc)) {
    // Bodies can be huge and full of PII. Replace with a summary, never the raw.
    return summarizeResponse(value);
  }
  return walk(value, depth);
}

// --- error code extractor ---------------------------------------------------
//
// Tool results carry varied error shapes. Pull the structured code if
// present; otherwise scrub the message string. Never include raw stack
// traces.

export function extractErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.error_code === "string") return obj.error_code;
  if (typeof obj.code === "string") return obj.code;
  if (obj.error && typeof obj.error === "object") {
    const inner = obj.error as Record<string, unknown>;
    if (typeof inner.code === "string") return inner.code;
  }
  if (typeof obj.status === "string") return obj.status;
  return undefined;
}
