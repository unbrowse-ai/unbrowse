import type { RawRequest, CapturedWsMessage } from "../capture/index.js";
import type { CsrfPlan, EndpointDescriptor, WsMessage } from "../types/index.js";
import { inferSchema } from "../transform/index.js";
import { getRegistrableDomain } from "../domain.js";
import { nanoid } from "nanoid";
import { inferEndpointSemantic } from "../graph/index.js";
import { writeDebugTrace } from "../debug-trace.js";
import { buildTemplatedQuery } from "../template-params.js";
import { extractFromDOM } from "../extraction/index.js";
import { assessIntentResult } from "../intent-match.js";

const SKIP_EXTENSIONS = /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map|webp|html|avif)([?#]|$)/i;
const SKIP_JS_BUNDLES = /\/(boq-|_\/mss\/|og\/_\/js\/|_\/scs\/)/i;
const SKIP_PATHS = /\/_next\/static\/|\/_next\/data\/|\/_next\/image|\/static\/chunks\/|\/static\/media\/|\/cdn-cgi\//i;

// Known infrastructure/auth hosts — never useful as skill endpoints
const SKIP_HOSTS = /(cloudflare\.com|google-analytics\.com|doubleclick\.net|gstatic\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|appleid\.apple\.com|github\.com\/login|facebook\.com\/login|protechts\.net|demdex\.net|litms|platform-telemetry|datadoghq\.com|fullstory\.com|launchdarkly\.com|intercom\.io|privy\.io|mypinata\.cloud|sentry\.io|segment\.io|amplitude\.com|mixpanel\.com|hotjar\.com|clarity\.ms|googletagmanager\.com|walletconnect\.com|imagedelivery\.net|cloudflareinsights\.com)/i;

// Google-specific telemetry, ads, and infrastructure subdomains (BUG-GC-004)
const SKIP_TELEMETRY_HOSTS = /(waa-pa\.|signaler-pa\.|appsgrowthpromo-pa\.|ogads-pa\.|peoplestackwebexperiments-pa\.)/i;

// Known telemetry/logging path patterns
const SKIP_TELEMETRY_PATHS = /\/(log|logging|telemetry|analytics|beacon|ping|heartbeat|metrics)(\/|$)/i;

// RPC/API path hints — tightened to avoid false positives (BUG-GC-004)
const RPC_HINTS = /(\/$rpc\/|\/rpc\/|graphql|trending|search|feed|results|batchexecute|\/api\/)/i;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Headers that must never be stored in skill manifests (BUG-GC-005)
// Includes session tokens, API keys, and Google-specific credential headers.
const STRIP_HEADERS = new Set([
  "cookie",
  "authorization",
  "x-csrf-token",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-app-key",
  "x-app-secret",
  "content-length",
  "host",
  // Google credential headers
  "x-goog-api-key",
  "x-server-token",
  "x-goog-encode-response-if-executable",
  "x-clientdetails",
  "x-javascript-user-agent",
]);
// Also strip any header matching these prefixes
const STRIP_HEADER_PREFIXES = [
  "x-goog-auth", "x-goog-spatula",
  "x-auth-",          // generic auth headers
  "x-amz-security-",  // AWS security tokens
  "x-stripe-",        // Stripe API headers
  "x-firebase-",      // Firebase auth headers
];

// Headers known to be safe (non-sensitive) — used by the catch-all filter below
const SAFE_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control",
  "content-type", "origin", "referer", "user-agent", "pragma",
  "if-none-match", "if-modified-since", "range", "dnt", "connection",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "x-requested-with",
]);

// Patterns that indicate a header contains credentials — catch-all safety net
const SENSITIVE_HEADER_PATTERN = /token|key|secret|credential|password|session/i;

// Query param names that likely contain credentials and must be stripped from URL templates
const SENSITIVE_QUERY_PARAMS = /^(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|key|token|session[_-]?id|client[_-]?secret|private[_-]?key|bearer)$/i;

// Framework-internal query params — noise from Next.js RSC, cache busting, etc.
const FRAMEWORK_QUERY_PARAMS = /^(_rsc|_next|__next|_t|_hash|__cf_chl_tk|nxtP\[.*\])$/i;

// Ad/tracking hosts that slip through the main SKIP_HOSTS filter
const AD_HOSTS = /buysellads\.com|carbonads\.com|ethicalads\.io|srv\.buysellads\.com|facet-futures\./i;

// Schema-level ad/tracking detection — if a response body's top-level keys
// match advertising vocabulary, the endpoint is an ad server regardless of host.
const AD_SCHEMA_KEYS = new Set([
  "campaignid", "creativeid", "creativetype", "creativecontent",
  "orderid", "impressionurl", "clickurl", "customerid",
  "adunitid", "adslot", "adsize", "lineitemid",
]);
const AD_SCHEMA_THRESHOLD = 3; // need at least this many ad-like keys to classify

function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("ges") || word.endsWith("zes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function titleCase(text: string): string {
  return text
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0] ? `${part[0].toUpperCase()}${part.slice(1)}` : "")
    .join(" ");
}

function compactForSemanticExample(value: unknown, depth = 0): unknown {
  if (depth > 2 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 2).map((item) => compactForSemanticExample(item, depth + 1));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
    return Object.fromEntries(entries.map(([key, next]) => [key, compactForSemanticExample(next, depth + 1)]));
  }
  if (typeof value === "string" && value.length > 160) return `${value.slice(0, 157)}...`;
  return value;
}

function flattenRequestExample(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [groupKey, groupValue] of Object.entries(value as Record<string, unknown>)) {
    if (groupValue == null) continue;
    if (!groupValue || typeof groupValue !== "object" || Array.isArray(groupValue)) {
      out[groupKey] = groupValue;
      continue;
    }
    for (const [nestedKey, nestedValue] of Object.entries(groupValue as Record<string, unknown>)) {
      if (out[nestedKey] == null) out[nestedKey] = nestedValue;
    }
  }
  return out;
}

function summarizeResponseExample(sample: unknown): { subject: string; fields: string[] } {
  if (Array.isArray(sample)) {
    const first = sample.find((item) => item && typeof item === "object");
    const fields = first ? collectKeysShallow(first).slice(0, 6) : [];
    return { subject: "items", fields };
  }
  if (!sample || typeof sample !== "object") return { subject: "response", fields: [] };
  const record = sample as Record<string, unknown>;
  const preferredKey = Object.keys(record).find((key) => {
    const value = record[key];
    return (Array.isArray(value) && value.length > 0) || (value && typeof value === "object");
  }) ?? Object.keys(record)[0] ?? "response";
  const preferredValue = record[preferredKey];
  if (Array.isArray(preferredValue) && preferredValue.length > 0) {
    const fields = preferredValue[0] && typeof preferredValue[0] === "object"
      ? collectKeysShallow(preferredValue[0]).slice(0, 6)
      : [];
    return { subject: singularize(preferredKey), fields };
  }
  if (preferredValue && typeof preferredValue === "object") {
    return { subject: singularize(preferredKey), fields: collectKeysShallow(preferredValue).slice(0, 6) };
  }
  return { subject: singularize(preferredKey), fields: collectKeysShallow(sample).slice(0, 6) };
}

function inferPathSubject(pathname: string): string {
  const generic = new Set(["api", "graphql", "rpc", "search", "query", "v1", "v2", "v3", "rest"]);
  const segments = pathname.split("/").filter(Boolean).filter((segment) => !generic.has(segment.toLowerCase()));
  return singularize(segments[segments.length - 1] ?? "response");
}

function buildEndpointDescription(
  req: RawRequest,
  sampleRequest: Record<string, unknown>,
  sampleResponse: unknown,
): string {
  const url = new URL(req.url);
  const pathTail = url.pathname.split("/").filter(Boolean).slice(-2).join(" ");
  const requestKeys = Object.keys(sampleRequest).slice(0, 4);
  const response = summarizeResponseExample(sampleResponse);
  const action = requestKeys.some((key) => /^(q|query|search|term)$/i.test(key)) || /search|find|lookup/.test(url.pathname)
    ? "Searches"
    : /status|health|incident|maintenance/.test(url.pathname)
      ? "Returns status for"
      : url.pathname.match(/\{[^}]+\}|\/[0-9A-Za-z_-]{4,}(\/|$)/)
        ? "Returns details for"
        : "Returns";
  const subjectSource = new Set(["response", "data", "result", "results", "item", "items"]).has(response.subject.toLowerCase())
    ? inferPathSubject(url.pathname)
    : response.subject;
  const subject = titleCase(subjectSource === "response" ? (pathTail || url.hostname) : subjectSource);
  const fieldText = response.fields.length > 0 ? ` with ${response.fields.join(", ")}` : "";
  const inputText = requestKeys.length > 0 ? ` using ${requestKeys.join(", ")}` : "";
  return `${action} ${subject}${fieldText}${inputText}`;
}

function looksLikeAdResponse(body: string | undefined): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body);
    const keys = collectKeysShallow(parsed);
    let hits = 0;
    for (const k of keys) {
      if (AD_SCHEMA_KEYS.has(k.toLowerCase())) hits++;
    }
    return hits >= AD_SCHEMA_THRESHOLD;
  } catch {
    return false;
  }
}

function isHtmlResponseBody(body: string | undefined): boolean {
  if (!body) return false;
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (!/[<>]/.test(trimmed)) return false;
  return /<(html|body|head|main|article|div|section|a|script|meta|title)\b/i.test(trimmed) ||
    /<!doctype html/i.test(trimmed);
}

function isJsonResponseBody(body: string | undefined): boolean {
  if (!body) return false;
  try {
    JSON.parse(stripJsonPrefix(body));
    return true;
  } catch {
    return false;
  }
}

function hasAdmissibleParsedBody(body: string | undefined): boolean {
  return isJsonResponseBody(body) || isHtmlResponseBody(body);
}

/** Collect top-level + one-level-nested keys from an object/array */
function collectKeysShallow(obj: unknown): string[] {
  const keys: string[] = [];
  if (obj && typeof obj === "object") {
    const items = Array.isArray(obj) ? obj.slice(0, 3) : [obj];
    for (const item of items) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const k of Object.keys(item as Record<string, unknown>)) {
          keys.push(k);
          const val = (item as Record<string, unknown>)[k];
          if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0]) {
            keys.push(...Object.keys(val[0] as Record<string, unknown>));
          }
        }
      }
    }
  }
  return keys;
}

function normalizeTokenText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2");
}

function tokenize(text: string | undefined): string[] {
  if (!text) return [];
  return normalizeTokenText(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function collectSemanticTokens(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) collectSemanticTokens(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, next] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
      for (const token of tokenize(key)) out.add(token);
      collectSemanticTokens(next, out, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length <= 64) {
    for (const token of tokenize(value)) out.add(token);
  }
  return out;
}

type IntentEntityKind = "comment" | "post" | "person" | "company" | "repository" | "topic" | "channel" | "listing";

type IntentActionKind = "create" | "update" | "delete" | "send" | "read";

function inferIntentEntityKind(intent: string | undefined): IntentEntityKind | null {
  const text = intent?.toLowerCase() ?? "";
  if (/\b(comment|comments|reply|replies)\b/.test(text)) return "comment";
  if (/\b(post|posts|status|statuses|tweet|tweets|message|messages|feed|timeline|stream|home)\b/.test(text)) return "post";
  if (/\b(person|people|profile|profiles|member|members|user|users)\b/.test(text)) return "person";
  if (/\b(company|companies|organization|organisations|org|business|businesses)\b/.test(text)) return "company";
  if (/\b(repo|repos|repository|repositories|project|projects)\b/.test(text)) return "repository";
  if (/\b(topic|topics|trend|trends|hashtag|hashtags)\b/.test(text)) return "topic";
  if (/\b(channel|channels|thread|threads|conversation|conversations)\b/.test(text)) return "channel";
  if (/\b(listing|listings|product|products|item|items|marketplace)\b/.test(text)) return "listing";
  return null;
}

function inferIntentActionKind(intent: string | undefined): IntentActionKind {
  const text = intent?.toLowerCase() ?? "";
  if (/\b(create|add|new|compose|draft)\b/.test(text)) return "create";
  if (/\b(update|edit|patch|modify)\b/.test(text)) return "update";
  if (/\b(delete|remove|archive)\b/.test(text)) return "delete";
  if (/\b(send|submit|post|publish)\b/.test(text)) return "send";
  return "read";
}

function extractStructuredHtmlResult(
  body: string | undefined,
  intent: string | undefined,
): {
  data: unknown;
  extraction_method: string;
  confidence: number;
  selector?: string;
} | null {
  if (!body || !intent || !isHtmlResponseBody(body)) return null;
  const extracted = extractFromDOM(body, intent);
  if (!extracted.data || extracted.confidence <= 0.2) return null;
  const assessment = assessIntentResult(extracted.data, intent);
  if (assessment.verdict === "fail") return null;
  return extracted;
}

function shouldTreatSubmissionAsSafe(
  req: RawRequest,
  sampleRequest: Record<string, unknown>,
  context: ExtractionContext | undefined,
  _actionKind?: string,
): boolean {
  if (req.method === "GET") return true;
  const lowerIntent = context?.intent?.toLowerCase() ?? "";
  const explicitReadIntent = /\b(search|find|lookup|get|fetch|list)\b/.test(lowerIntent);
  const explicitWriteIntent = /\b(create|add|compose|draft|publish|send|post|delete|remove|update|edit)\b/.test(lowerIntent);
  if (!explicitReadIntent && (explicitWriteIntent || inferIntentActionKind(context?.intent) !== "read")) return false;
  const signals = [
    req.url,
    JSON.stringify(sampleRequest),
  ].join(" ").toLowerCase();
  if (/\b(delete|remove|create|publish|checkout|purchase|register|login|logout|comment|reply|message|send|post)\b/.test(signals)) {
    return false;
  }
  return /search|query|keyword|lookup|find|filter|result|detail|fetch|list|read/.test(signals);
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const segment of header.split(";")) {
    const idx = segment.indexOf("=");
    if (idx <= 0) continue;
    const key = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (key && !(key in out)) out[key] = value;
  }
  return out;
}

function normalizeBodyBindingKey(path: string): string {
  const normalized = path
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\.(\d+)\./g, "_$1_")
    .replace(/\[(\d+)\]/g, "_$1")
    .replace(/[.[\]]+/g, "_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || "value";
}

function shouldTemplateBodyValue(path: string, value: unknown, context?: ExtractionContext): boolean {
  const lowerPath = normalizeBodyBindingKey(path);
  if (value == null) return false;
  if (typeof value === "boolean") return false;
  if (typeof value === "number") {
    return /(?:^|_)(id|count|offset|limit|page|cursor|index|position)(?:$|_)/.test(lowerPath);
  }
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length > 280) return false;
  if (/^(true|false|null)$/i.test(trimmed)) return false;
  if (/^[A-Z_]{2,24}$/.test(trimmed) && !/(id|slug|urn|token|email|name|title|query|search|message|text)/.test(lowerPath)) return false;
  if (/(?:^|_)(title|name|description|content|text|message|body|query|search|keyword|email|username|slug|handle|identifier|id|urn|url)(?:$|_)/.test(lowerPath)) {
    return true;
  }
  if (/^urn:[\w:-]+$/i.test(trimmed) || /^[0-9a-f]{8,}$/i.test(trimmed.replace(/-/g, ""))) return true;
  if (context?.pageUrl) {
    try {
      const pageUrl = new URL(context.pageUrl);
      if (pageUrl.searchParams.has(trimmed)) return true;
      if (pageUrl.pathname.toLowerCase().includes(trimmed.toLowerCase())) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function templatizeBodyObject(
  value: unknown,
  context?: ExtractionContext,
  path = "",
  bodyParams: Record<string, unknown> = {},
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => templatizeBodyObject(entry, context, `${path}[${index}]`, bodyParams));
  }
  if (!value || typeof value !== "object") {
    if (!path || !shouldTemplateBodyValue(path, value, context)) return value;
    const binding = normalizeBodyBindingKey(path);
    if (!(binding in bodyParams)) bodyParams[binding] = value;
    return `{${binding}}`;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, next]) => [
      key,
      templatizeBodyObject(next, context, path ? `${path}.${key}` : key, bodyParams),
    ]),
  );
}

function inferCsrfPlan(req: RawRequest, parsedBody?: unknown): CsrfPlan | undefined {
  const headers = Object.fromEntries(
    Object.entries(req.request_headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const cookies = parseCookieHeader(headers["cookie"]);
  const csrfCookieNames = Object.keys(cookies).filter((name) => /^(ct0|csrf_token|_csrf|csrftoken|xsrf-token|_xsrf|JSESSIONID)$/i.test(name));
  const headerName = ["x-csrf-token", "x-xsrf-token", "x-csrftoken", "csrf-token"].find((name) => typeof headers[name] === "string" && headers[name].length > 0);

  // Also detect CSRF by value matching: if any cookie value appears as a header value,
  // that's a CSRF token pattern regardless of naming convention
  if (!headerName && csrfCookieNames.length === 0) {
    for (const [cookieName, cookieValue] of Object.entries(cookies)) {
      if (!cookieValue || cookieValue.length < 8) continue;
      const unquoted = cookieValue.startsWith('"') && cookieValue.endsWith('"') ? cookieValue.slice(1, -1) : cookieValue;
      for (const [hName, hValue] of Object.entries(headers)) {
        if (hName === "cookie" || hName === "host" || hName === "content-length") continue;
        const hUnquoted = hValue.startsWith('"') && hValue.endsWith('"') ? hValue.slice(1, -1) : hValue;
        if (unquoted === hUnquoted && unquoted.length >= 8) {
          return {
            source: "cookie",
            param_name: hName,
            refresh_on_401: true,
            extractor_sequence: [cookieName],
          };
        }
      }
    }
  }

  if (headerName && csrfCookieNames.length > 0) {
    return {
      source: "cookie",
      param_name: headerName,
      refresh_on_401: true,
      extractor_sequence: csrfCookieNames,
    };
  }
  if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
    const formField = Object.keys(parsedBody as Record<string, unknown>).find((key) => /^(csrf|csrf_token|_csrf|authenticity_token|xsrf)$/i.test(key));
    if (formField && csrfCookieNames.length > 0) {
      return {
        source: "form",
        param_name: formField,
        refresh_on_401: true,
        extractor_sequence: csrfCookieNames,
      };
    }
  }
  return undefined;
}

function getIntentEntityRules(kind: IntentEntityKind): { strong: string[]; weak: string[]; negative: RegExp; negativeSignals?: string[] } {
  switch (kind) {
    case "comment":
      return {
        strong: ["comment", "comments", "body", "bodyhtml", "author", "replies", "reply", "parentid", "permalink", "score"],
        weak: ["text", "content", "created", "subreddit", "depth", "children"],
        negative: /(subreddits?(\/|$)|communities|communityinfo|about(\.json)?$|accounts(\/|$)|people|profiles|instance|custom_emojis)/i,
        negativeSignals: ["displayname", "subscribers", "communityicon", "activeusercount", "subreddittype", "bannerimg"],
      };
    case "post":
      return {
        strong: ["status", "statuses", "post", "posts", "feed", "timeline", "update", "updates", "content", "text", "title", "author", "actor", "commentary", "permalink", "score", "numcomments", "num_comments", "selftext", "reblog", "spoiler", "socialdetail", "socialactivitycounts"],
        weak: ["blog", "body", "reply", "replies", "favourites", "favourited", "published", "visibility", "subreddit", "created", "activity", "activities", "element", "elements", "reshare", "reaction", "reactions"],
        negative: /(subreddits?(\/|$)|communityinfo|about(\.json)?$|trends\/tags|custom_emojis|instance|filters|accounts(\/|$)|reports(\/|$)|packs\/assets)/i,
        negativeSignals: ["displayname", "display_name", "subscribers", "communityicon", "community_icon", "activeusercount", "active_user_count", "subreddittype", "subreddit_type", "bannerimg", "banner_img"],
      };
    case "person":
      return {
        strong: ["publicidentifier", "firstname", "lastname", "headline", "displayname", "fullname", "occupation", "username", "acct", "screen", "followers", "following", "bio", "avatar", "verified"],
        weak: ["person", "people", "profile", "profiles", "member", "members", "actor", "name", "title", "description", "viewer", "user", "users"],
        negative: /(policy\/notices|globalalerts|badging|notification|messaging|mailbox|launchpad|identitymodule|globalnav|feeddash|topics|realtime|tracking|tracko11y|allowlist|preload|presence)/i,
      };
    case "company":
      return {
        strong: ["company", "organization", "organisation", "org", "staffcount", "employees", "industry", "industries", "tagline", "overview", "about", "headquarters", "websiteurl", "companyname"],
        weak: ["name", "followers", "location", "specialties", "logo", "description"],
        negative: /(people|profiles|members|globalnav|launchpad|messaging|mailbox|tracking|notification|preload|presence|metadata$)/i,
        negativeSignals: ["navigationcontext", "trackingid", "tracking", "globalnav", "mailbox", "notification"],
      };
    case "repository":
      return {
        strong: ["repository", "repositories", "fullname", "stargazers", "forks", "owner", "language", "license", "defaultbranch"],
        weak: ["repo", "repos", "topic", "topics", "description", "watchers", "openissues"],
        negative: /(notifications|sponsors|settings|sessions|codespaces|copilot|marketplace)/i,
      };
    case "topic":
      return {
        strong: ["topic", "topics", "trend", "trends", "hashtag", "hashtags", "tag", "tags"],
        weak: ["name", "volume", "url"],
        negative: /(accounts|people|profiles|messages|mailbox|notifications)/i,
      };
    case "channel":
      return {
        strong: ["channel", "channels", "thread", "threads", "conversation", "conversations", "guild", "room"],
        weak: ["message", "messages", "name", "topic"],
        negative: /(experiments|affinities|promotions|settings|notifications|status)/i,
      };
    case "listing":
      return {
        strong: ["listing", "listings", "price", "seller", "currency", "product"],
        weak: ["title", "bed", "bath", "address", "location"],
        negative: /(tracking|ads|telemetry|config|status|auth)/i,
      };
  }
}

function isSemanticallyAdmissibleResponse(
  req: RawRequest,
  sampleResponse: unknown,
  sampleRequest: Record<string, unknown>,
  context?: ExtractionContext,
): { ok: boolean; reason: string } {
  const kind = inferIntentEntityKind(context?.intent);
  const action = inferIntentActionKind(context?.intent);
  if (!kind) {
    if (action === "read") return { ok: true, reason: "semantic_gate_not_applicable" };
    const requestSignals = collectSemanticTokens(sampleRequest);
    const responseSignals = collectSemanticTokens(sampleResponse);
    const signalCount = requestSignals.size + responseSignals.size;
    return signalCount >= 2
      ? { ok: true, reason: "semantic_action_request_match" }
      : { ok: false, reason: "semantic_action_sparse" };
  }

  const bodyIsJson = isJsonResponseBody(req.response_body);
  if (!bodyIsJson && isHtmlResponseBody(req.response_body)) {
    const extracted = extractStructuredHtmlResult(req.response_body, context?.intent);
    if (extracted) return { ok: true, reason: "semantic_html_dom_match" };
    try {
      const reqPath = new URL(req.url).pathname;
      const pagePath = context?.pageUrl ? new URL(context.pageUrl).pathname : "";
      return reqPath === pagePath
        ? { ok: true, reason: "semantic_html_page_candidate" }
        : { ok: false, reason: "semantic_html_not_page" };
    } catch {
      return { ok: false, reason: "semantic_html_bad_url" };
    }
  }

  const { strong, weak, negative, negativeSignals = [] } = getIntentEntityRules(kind);
  if (negative.test(req.url)) return { ok: false, reason: "semantic_negative_url" };

  const signals = collectSemanticTokens(sampleResponse);
  collectSemanticTokens(sampleRequest, signals);
  for (const token of tokenize(req.url)) signals.add(token);
  let strongHits = 0;
  let weakHits = 0;
  let negativeHits = 0;
  for (const token of strong) {
    if (signals.has(token)) strongHits++;
  }
  for (const token of weak) {
    if (signals.has(token)) weakHits++;
  }
  for (const token of negativeSignals) {
    if (signals.has(token)) negativeHits++;
  }
  if (negativeHits >= 2 && strongHits < 2) {
    return { ok: false, reason: "semantic_negative_payload" };
  }
  if (action !== "read" && strongHits === 0 && weakHits >= 2) {
    return { ok: true, reason: "semantic_action_request_match" };
  }
  return (strongHits >= 1) || (weakHits >= 3)
    ? { ok: true, reason: "semantic_match" }
    : { ok: false, reason: "semantic_entity_mismatch" };
}

// On-domain noise patterns — framework plumbing, auth, tracking, ads that live
// on the site's own domain (not caught by SKIP_HOSTS since they're same-origin).
const ON_DOMAIN_NOISE = /\/(recaptcha|captcha|update-recaptcha|csrf|consent|data-protection|badge|drawer|header-action|geolocation|onboarding|wana\/bids|prebid|bids\/request|ads\/|pixel|beacon|collect|impression|click-tracking|heartbeat|webConfig|config\.json|manifest\.json|service-worker|sw\.js|favicon|robots\.txt|sitemap|opensearch|partial\/[a-zA-Z]+\/mod-|logging|csp-report|gen_204|generate_204|sodar|__|devvit-|user-drawer|action-item)/i;

// Score a request: higher = more likely to be a real data API (BUG-GC-004)
function scoreRequest(req: RawRequest): number {
  let score = 0;
  let pathname = "";
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    pathname = "";
  }
  // GET is preferred — safe, idempotent, more useful for data retrieval
  if (req.method === "GET") score += 2;
  if (RPC_HINTS.test(req.url)) score += 3;
  if (SKIP_JS_BUNDLES.test(req.url)) score -= 10;
  const ct = req.response_headers?.["content-type"] ?? "";
  if (ct.includes("application/json") && !ct.includes("protobuf")) score += 4;
  // Fallback: if response_headers is empty (common in tracked requests), check if body is JSON
  else if (!ct && req.response_body) {
    try { JSON.parse(stripJsonPrefix(req.response_body)); score += 4; } catch { /* not JSON */ }
  }
  // Protobuf responses are not parseable — score neutral, don't reward (BUG-GC-006)
  if (ct.includes("x-protobuf") || ct.includes("json+protobuf")) score += 0;
  // Penalise long URLs — but only the path, not query params (GraphQL endpoints
  // have long variables/features query strings that inflate the URL length)
  if (pathname.length > 200) score -= 5;
  else if (req.url.length > 500) score -= 5;
  // Penalise telemetry paths even if they passed the host filter
  if (pathname && SKIP_TELEMETRY_PATHS.test(pathname)) score -= 8;
  // Penalise Next.js RSC navigation requests — framework wire format, not data
  if (req.url.includes("_rsc=")) score -= 3;
  if (ct.includes("text/x-component")) score -= 10; // RSC wire format
  // Penalise on-domain noise (framework plumbing, recaptcha, consent, ad bids)
  if (pathname && ON_DOMAIN_NOISE.test(pathname)) score -= 15;
  // Reward rich JSON responses (data endpoints have deep objects, noise has shallow)
  if (req.response_body) {
    try {
      const parsed = JSON.parse(stripJsonPrefix(req.response_body));
      const bodyStr = req.response_body;
      // Responses with many keys = likely data. Tiny responses = config/status.
      if (bodyStr.length > 500) score += 3;
      if (bodyStr.length > 2000) score += 2;
      // Array responses are usually data listings
      if (Array.isArray(parsed) && parsed.length > 0) score += 3;
    } catch { /* not JSON */ }
  }
  return score;
}

export interface ExtractionContext {
  /** The page URL that was captured (used to detect entity values in API paths) */
  pageUrl?: string;
  /** The final URL after redirects (e.g. lu.ma → luma.com) */
  finalUrl?: string;
  /** The user's intent string */
  intent?: string;
}

export function extractEndpoints(requests: RawRequest[], wsMessages?: CapturedWsMessage[], context?: ExtractionContext): EndpointDescriptor[] {
  const seen = new Set<string>();
  const endpoints: EndpointDescriptor[] = [];
  const traceRows: Array<Record<string, unknown>> = [];

  // Extract the registrable domain(s) for affinity filtering.
  // Include both pageUrl and finalUrl domains to handle redirects
  // (e.g. lu.ma → luma.com where API lives on api2.luma.com).
  const affinityDomains = new Set<string>();
  for (const u of [context?.pageUrl, context?.finalUrl]) {
    if (!u) continue;
    try { affinityDomains.add(getRegistrableDomain(new URL(u).hostname)); } catch { /* bad url */ }
  }

  const scored: Array<{ req: RawRequest; score: number }> = [];
  for (const req of requests) {
    const score = scoreRequest(req);
    if (!isApiLike(req)) {
      traceRows.push({ url: req.url, method: req.method, score, kept: false, reason: "not_api_like" });
      continue;
    }
    if (score <= 0) {
      traceRows.push({ url: req.url, method: req.method, score, kept: false, reason: "score_non_positive" });
      continue;
    }
    if (!hasAdmissibleParsedBody(req.response_body)) {
      traceRows.push({ url: req.url, method: req.method, score, kept: false, reason: "body_not_json_or_html" });
      continue;
    }
    if (affinityDomains.size > 0) {
      try {
        const reqHost = new URL(req.url).hostname;
        const reqDomain = getRegistrableDomain(reqHost);
        if (!affinityDomains.has(reqDomain)) {
          traceRows.push({ url: req.url, method: req.method, score, kept: false, reason: "domain_mismatch" });
          continue;
        }
      } catch {
        traceRows.push({ url: req.url, method: req.method, score, kept: false, reason: "bad_url" });
        continue;
      }
    }
    traceRows.push({ url: req.url, method: req.method, score, kept: true, reason: "candidate" });
    scored.push({ req, score });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const { req } of scored) {
    const normalized = normalizeUrl(req.url);
    const key = `${req.method}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Schema-level ad detection: skip endpoints whose response body looks like ad-server data
    if (looksLikeAdResponse(req.response_body)) {
      traceRows.push({ url: req.url, method: req.method, kept: false, reason: "ad_response" });
      continue;
    }

    // BUG-008: Detect Cloudflare challenge responses — exclude from skill
    if (isCloudflareChallenge(req.response_body)) {
      traceRows.push({ url: req.url, method: req.method, kept: false, reason: "cloudflare_challenge" });
      continue;
    }

    // BUG-GC-006: Skip protobuf-only endpoints — we can't parse their bodies
    const ct = req.response_headers?.["content-type"] ?? "";
    if ((ct.includes("x-protobuf") || ct.includes("json+protobuf")) && !isJsonParseable(req.response_body)) {
      traceRows.push({ url: req.url, method: req.method, kept: false, reason: "protobuf_unparseable" });
      continue;
    }

    const isGet = req.method === "GET";

    const domArtifact = extractStructuredHtmlResult(req.response_body, context?.intent);

    // Infer response schema from captured body
    let response_schema = undefined;
    if (req.response_body) {
      try {
        const cleaned = stripJsonPrefix(req.response_body);
        const parsed = JSON.parse(cleaned);
        response_schema = inferSchema([parsed]);
      } catch {
        // not valid JSON — skip schema inference
      }
    }
    if (!response_schema && domArtifact) {
      response_schema = inferSchema([domArtifact.data]);
    }

    // BUG-008: mark endpoints with no response body as potentially CF-blocked
    const verificationStatus = req.response_body ? "unverified" as const : "pending" as const;

    // Skip endpoints with invalid URL templates
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      traceRows.push({ url: req.url, method: req.method, kept: false, reason: "normalized_url_invalid" });
      continue;
    }

    // Build url_template with templatized query params so callers know what to pass.
    // normalizeUrl strips the query string; we rebuild it with {param} placeholders.
    // endpoint.query stores the captured defaults for execution-time fallback.
    const sanitizedQParams = isGet ? sanitizeQueryParams(extractQueryParams(req.url)) : undefined;
    let pathTemplate = sanitizeUrlTemplate(normalized);
    const qTemplateStr = sanitizedQParams && Object.keys(sanitizedQParams).length > 0
      ? Object.entries(buildTemplatedQuery(sanitizedQParams)).map(([k, v]) => `${encodeURIComponent(k)}=${v}`).join("&")
      : null;

    // BUG-006: Parameterize dynamic path segments (comma lists, page URL entities)
    const { url: templatizedPath, pathParams } = templatizePathSegments(pathTemplate, req.url, context);
    pathTemplate = templatizedPath;

    const parsedRequestBody = !isGet && req.request_body ? tryParseBody(req.request_body) : undefined;
    const bodyParams: Record<string, unknown> = {};
    const templatedRequestBody = !isGet && parsedRequestBody && typeof parsedRequestBody === "object" && !Array.isArray(parsedRequestBody)
      ? templatizeBodyObject(parsedRequestBody, context, "", bodyParams) as Record<string, unknown>
      : parsedRequestBody;
    const sampleResponse = domArtifact?.data ?? (req.response_body ? tryParseBody(req.response_body) : undefined);
    const sampleRequest = flattenRequestExample({
      path_params: Object.keys(pathParams).length > 0 ? pathParams : undefined,
      query: sanitizedQParams,
      body: templatedRequestBody,
    });
    const csrfPlan = inferCsrfPlan(req, parsedRequestBody);

    const endpoint: EndpointDescriptor = {
      endpoint_id: nanoid(),
      method: req.method as EndpointDescriptor["method"],
      url_template: qTemplateStr ? `${pathTemplate}?${qTemplateStr}` : pathTemplate,
      description: buildEndpointDescription(req, sampleRequest, sampleResponse),
      headers_template: sanitizeHeaders(req.request_headers),
      query: sanitizedQParams,
      path_params: Object.keys(pathParams).length > 0 ? pathParams : undefined,
      ...(Object.keys(bodyParams).length > 0 ? { body_params: bodyParams } : {}),
      ...(templatedRequestBody && typeof templatedRequestBody === "object" && !Array.isArray(templatedRequestBody) ? { body: templatedRequestBody as Record<string, unknown> } : {}),
      ...(csrfPlan ? { csrf_plan: csrfPlan } : {}),
      idempotency: isGet ? "safe" : "unsafe",
      verification_status: verificationStatus,
      reliability_score: 0.5,
      response_schema,
      ...(domArtifact ? {
        dom_extraction: {
          extraction_method: domArtifact.extraction_method,
          confidence: domArtifact.confidence,
          ...(domArtifact.selector ? { selector: domArtifact.selector } : {}),
        },
      } : {}),
      // Record which page triggered this API call — used for trigger-and-intercept execution
      trigger_url: context?.pageUrl,
    };
    endpoint.semantic = inferEndpointSemantic(endpoint, {
      sampleResponse: compactForSemanticExample(sampleResponse),
      sampleRequest,
      observedAt: req.timestamp,
      sampleRequestUrl: req.url,
    });
    if (csrfPlan) {
      endpoint.semantic = {
        ...(endpoint.semantic ?? {}),
        action_kind: endpoint.semantic?.action_kind ?? (isGet ? "detail" : "create"),
        resource_kind: endpoint.semantic?.resource_kind ?? "resource",
        auth_required: true,
      };
    }
    endpoint.description = endpoint.semantic?.description_out ?? endpoint.description;
    if (shouldTreatSubmissionAsSafe(req, sampleRequest, context, endpoint.semantic?.action_kind)) {
      const searchLike = /\b(search|find|lookup)\b/.test(context?.intent ?? "");
      const resourceKind = /\b(case|cases|document|documents|paper|papers|article|articles)\b/.test(context?.intent ?? "")
        ? "document"
        : "resource";
      const responseSummary = summarizeResponseExample(sampleResponse);
      const fieldText = responseSummary.fields.length > 0 ? ` with ${responseSummary.fields.join(", ")}` : "";
      endpoint.idempotency = "safe";
      endpoint.semantic = {
        ...(endpoint.semantic ?? {}),
        action_kind: searchLike ? "search" : "detail",
        resource_kind: resourceKind,
        description_out: `${searchLike ? "Searches" : "Returns"} ${resourceKind === "document" ? "documents" : "results"}${fieldText}`,
      };
      endpoint.description = endpoint.semantic.description_out ?? endpoint.description;
    }
    const admission = isSemanticallyAdmissibleResponse(req, sampleResponse, sampleRequest, context);
    if (!admission.ok) {
      traceRows.push({
        url: req.url,
        method: req.method,
        kept: false,
        reason: admission.reason,
      });
      continue;
    }
    traceRows.push({
      url: req.url,
      method: req.method,
      kept: true,
      reason: admission.reason === "semantic_match" ? "accepted_endpoint" : admission.reason,
      endpoint_id: endpoint.endpoint_id,
      description: endpoint.description,
      action_kind: endpoint.semantic?.action_kind,
      resource_kind: endpoint.semantic?.resource_kind,
    });
    endpoints.push(endpoint);
  }

  // Collapse sibling endpoints into templatized ones
  // e.g. /ticker-sentiment/MSFT + /ticker-sentiment/NVDA → /ticker-sentiment/{ticker}
  const deduped = collapseEndpoints(endpoints);
  endpoints.length = 0;
  endpoints.push(...deduped);

  // Create endpoints from WebSocket messages
  if (wsMessages && wsMessages.length > 0) {
    const wsByUrl = new Map<string, CapturedWsMessage[]>();
    for (const msg of wsMessages) {
      const arr = wsByUrl.get(msg.url) ?? [];
      arr.push(msg);
      wsByUrl.set(msg.url, arr);
    }

    for (const [wsUrl, msgs] of wsByUrl) {
      const received = msgs.filter((m) => m.direction === "received");
      const wsMsgList: WsMessage[] = msgs.map((m) => ({
        direction: m.direction,
        data: m.data,
        timestamp: m.timestamp,
      }));

      // Try to infer response schema from first few received JSON messages
      let response_schema = undefined;
      const jsonSamples: unknown[] = [];
      for (const m of received.slice(0, 5)) {
        try {
          jsonSamples.push(JSON.parse(m.data));
        } catch { /* not JSON */ }
      }
      if (jsonSamples.length > 0) {
        response_schema = inferSchema(jsonSamples);
      }

      const endpoint: EndpointDescriptor = {
        endpoint_id: nanoid(),
        method: "WS",
        url_template: wsUrl,
        idempotency: "safe",
        verification_status: "unverified",
        reliability_score: jsonSamples.length > 0 ? 0.7 : 0.3,
        response_schema,
        ws_messages: wsMsgList,
      };
      endpoint.semantic = inferEndpointSemantic(endpoint, {
        sampleResponse: jsonSamples[0],
        observedAt: msgs[0]?.timestamp,
        sampleRequestUrl: wsUrl,
      });
      endpoint.description = endpoint.semantic?.description_out ?? endpoint.description;
      endpoints.push(endpoint);
    }
  }

  writeDebugTrace("generation", {
    page_url: context?.pageUrl ?? null,
    final_url: context?.finalUrl ?? null,
    intent: context?.intent ?? null,
    candidate_count: scored.length,
    accepted_count: endpoints.length,
    decisions: traceRows,
    accepted_endpoints: endpoints.map((endpoint) => ({
      endpoint_id: endpoint.endpoint_id,
      method: endpoint.method,
      url_template: endpoint.url_template,
      description: endpoint.description,
      action_kind: endpoint.semantic?.action_kind,
      resource_kind: endpoint.semantic?.resource_kind,
    })),
  });

  return endpoints;
}

function isApiLike(req: RawRequest): boolean {
  if (!ALLOWED_METHODS.has(req.method.toUpperCase())) return false;
  if (SKIP_EXTENSIONS.test(req.url)) return false;
  if (SKIP_JS_BUNDLES.test(req.url)) return false;
  if (SKIP_PATHS.test(req.url)) return false;
  try {
    const { hostname, pathname } = new URL(req.url);
    if (SKIP_HOSTS.test(hostname)) return false;
    if (SKIP_TELEMETRY_HOSTS.test(hostname)) return false;  // BUG-GC-004
    if (SKIP_TELEMETRY_PATHS.test(pathname)) return false;  // BUG-GC-004
    if (AD_HOSTS.test(hostname)) return false;
    // play.google.com/log is telemetry, not calendar data
    if (hostname === "play.google.com" && pathname.startsWith("/log")) return false;
    // Skip image CDN paths (coin images, avatars, etc.)
    if (/\/(coin-image|avatar|profile-image)\//.test(pathname)) return false;
    // Hard-skip on-domain noise that's never useful data
    if (/\/(recaptcha|update-recaptcha|captcha|wana\/bids|prebid|bids\/request|pixel[s]?\/|beacon\/|csp-report|service-worker|sw\.js$|favicon|robots\.txt$|sitemap|opensearch)/.test(pathname)) return false;
  } catch {
    return false;
  }
  // Skip tiny responses — config/status/empty endpoints, not data
  if (req.response_body && req.response_body.length < 20) return false;
  return true;
}

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/{id}")
      .replace(/\/\d{4,}/g, "/{id}")
      .replace(/\/[a-f0-9]{24,}/gi, "/{id}")
      // URN identifiers (e.g. urn:li:fsd_profile:ACoAAB3fei4B...)
      .replace(/\/urn:[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)+/g, "/{urn}")
      // BUG-006: Comma-separated values are lists of identifiers (e.g. SPY,QQQ)
      .replace(/\/([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)+)(?=\/|$)/g, "/{list}");
    // Preserve queryId param for GraphQL endpoints so different queries aren't deduplicated
    const queryId = u.searchParams.get("queryId");
    if (queryId && path.includes("graphql")) {
      return `${u.origin}${path}?queryId=${queryId}`;
    }
    return `${u.origin}${path}`;
  } catch {
    return rawUrl;
  }
}

function extractQueryParams(rawUrl: string): Record<string, string> {
  try {
    const u = new URL(rawUrl);
    const params: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    return params;
  } catch {
    return {};
  }
}

/** Returns true if a header name is sensitive and should be stripped from skill manifests. */
function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "cookie" || lower === "content-length" || lower === "host") return false; // handled separately
  if (STRIP_HEADERS.has(lower)) return true;
  if (STRIP_HEADER_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (lower.startsWith("x-goog-api")) return true;
  if (lower.startsWith("x-server-")) return true;
  if (!SAFE_HEADERS.has(lower) && SENSITIVE_HEADER_PATTERN.test(lower)) return true;
  return false;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([k]) => {
      const lower = k.toLowerCase();
      if (lower === "cookie" || lower === "content-length" || lower === "host") return false;
      return !isSensitiveHeader(k);
    })
  );
}

/**
 * Extract auth-sensitive headers from captured requests — the inverse of sanitizeHeaders.
 * These are stored in the vault (not the skill manifest) so server-fetch can reconstruct
 * the full header set without launching a browser. This is what makes the 2nd call fast.
 */
export function extractAuthHeaders(requests: RawRequest[]): Record<string, string> {
  const authHeaders: Record<string, string> = {};
  for (const req of requests) {
    for (const [k, v] of Object.entries(req.request_headers)) {
      const lower = k.toLowerCase();
      if (lower === "cookie" || lower === "content-length" || lower === "host") continue;
      if (isSensitiveHeader(k) && !authHeaders[lower]) {
        authHeaders[lower] = v;
      }
    }
  }
  return authHeaders;
}

function sanitizeQueryParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([k]) =>
      !SENSITIVE_QUERY_PARAMS.test(k) && !FRAMEWORK_QUERY_PARAMS.test(k)
    )
  );
}

function sanitizeUrlTemplate(url: string): string {
  try {
    const u = new URL(url);
    if (u.search.length <= 1) return url;
    const cleaned = new URLSearchParams();
    for (const [key, val] of u.searchParams) {
      if (!SENSITIVE_QUERY_PARAMS.test(key) && !FRAMEWORK_QUERY_PARAMS.test(key)) {
        cleaned.set(key, val);
      }
    }
    const qs = cleaned.toString();
    // Use the raw URL path (not u.pathname) to preserve {template} braces
    const pathMatch = url.match(/^https?:\/\/[^/]+(\/[^?]*)/);
    const rawPath = pathMatch ? pathMatch[1] : u.pathname;
    return qs ? `${u.origin}${rawPath}?${qs}` : `${u.origin}${rawPath}`;
  } catch {
    return url;
  }
}

// ── BUG-006: Path segment parameterization ──────────────────────────────────

/** Extract entity-like values from the page URL that may appear in API paths */
function extractEntityHints(context?: ExtractionContext): Set<string> {
  const hints = new Set<string>();
  if (!context?.pageUrl) return hints;
  try {
    const u = new URL(context.pageUrl);
    for (const seg of u.pathname.split("/").filter(Boolean)) {
      // Skip structural path parts
      if (/^(en|es|fr|de|ja|zh|ko|api|v\d+|www|static|assets|public|pages|app)$/i.test(seg)) continue;
      if (seg.length > 40 || seg.length < 2) continue;
      hints.add(seg.toLowerCase());
    }
  } catch { /* skip */ }
  return hints;
}

/**
 * Infer a meaningful param name from the preceding path segment.
 * e.g. /quote/{?} → {quote}, /coins/{?} → {coin}, /price_charts/{?} → {price_chart}
 */
function inferParamName(segments: string[], index: number, fallback: string, usedNames: Set<string>): string {
  let name = fallback;
  const prev = segments[index - 1];
  if (prev && !prev.startsWith("{") && prev.length > 1) {
    // Naive singularize: "coins" → "coin", "charts" → "chart"
    const base = prev.endsWith("s") && prev.length > 3 ? prev.slice(0, -1) : prev;
    name = base.replace(/[^a-zA-Z0-9_]/g, "_");
  }
  // Ensure uniqueness
  let unique = name;
  let counter = 2;
  while (usedNames.has(unique)) {
    unique = `${name}_${counter++}`;
  }
  usedNames.add(unique);
  return unique;
}

/**
 * BUG-006: Parameterize dynamic path segments in API URL templates.
 *
 * Two detection strategies:
 * 1. Comma-separated values (already collapsed to {list} by normalizeUrl) — capture defaults
 * 2. Context-aware: segments matching entity values from the page URL
 *
 * Returns the templatized URL and a map of param names → captured default values.
 * NOTE: Avoids `new URL()` on the template since it would percent-encode curly braces.
 */
function templatizePathSegments(
  templateUrl: string,
  originalUrl: string,
  context?: ExtractionContext,
): { url: string; pathParams: Record<string, string> } {
  const pathParams: Record<string, string> = {};

  try {
    // Parse templateUrl manually to avoid encoding {braces}
    // Format: "https://host:port/path/segments" (query already stripped by normalizeUrl)
    const tMatch = templateUrl.match(/^(https?:\/\/[^/]+)(\/.*)?$/);
    if (!tMatch) return { url: templateUrl, pathParams };
    const tOrigin = tMatch[1];
    const tPath = tMatch[2] ?? "/";

    const oPath = new URL(originalUrl).pathname;

    const tSegments = tPath.split("/");
    const oSegments = oPath.split("/");
    const hints = extractEntityHints(context);
    const usedNames = new Set<string>();

    for (let i = 0; i < tSegments.length; i++) {
      const tSeg = tSegments[i];
      const oSeg = oSegments[i] ?? tSeg;

      if (!tSeg) continue;

      // Pattern 1: Already parameterized by normalizeUrl ({id}, {list}, {urn}) — capture defaults & rename
      if (tSeg === "{id}" || tSeg === "{list}" || tSeg === "{urn}") {
        const fallback = tSeg === "{list}" ? "list" : tSeg === "{urn}" ? "urn" : "id";
        const paramName = inferParamName(tSegments, i, fallback, usedNames);
        tSegments[i] = `{${paramName}}`;
        pathParams[paramName] = oSeg;
        continue;
      }

      // Skip segments that are already template vars, file extensions, or structural
      if (tSeg.startsWith("{")) continue;
      if (tSeg.includes(".")) continue; // e.g. "24_hours.json"
      if (/^(api|v\d+|www|en|es|fr|de|latest|dex|search)$/i.test(tSeg)) continue;
      if (/^@?me$/i.test(tSeg) || /^self$/i.test(tSeg)) continue;

      // Pattern 2: Segment matches a page URL entity hint (case-insensitive)
      if (hints.size > 0 && hints.has(tSeg.toLowerCase())) {
        const paramName = inferParamName(tSegments, i, "slug", usedNames);
        tSegments[i] = `{${paramName}}`;
        pathParams[paramName] = oSeg;
        continue;
      }
    }

    return { url: `${tOrigin}${tSegments.join("/")}`, pathParams };
  } catch {
    return { url: templateUrl, pathParams };
  }
}

function isJsonParseable(body?: string): boolean {
  if (!body) return false;
  try { JSON.parse(stripJsonPrefix(body)); return true; } catch { return false; }
}

/** Strip Google/common API JSON prefixes like )]}'\n or )]}\n */
function stripJsonPrefix(body: string): string {
  return body.replace(/^\)?\]?\}?'?\s*\n/, "");
}

function tryParseBody(body: string): Record<string, unknown> | undefined {
  // Try JSON first
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {}

  // Try URL-encoded form data (BUG-GC-008: calendar sync endpoints use x-www-form-urlencoded)
  try {
    const params = new URLSearchParams(body);
    const result: Record<string, unknown> = {};
    params.forEach((v, k) => {
      const existing = result[k];
      if (existing == null) {
        result[k] = v;
      } else if (Array.isArray(existing)) {
        existing.push(v);
      } else {
        result[k] = [existing, v];
      }
    });
    if (Object.keys(result).length > 0) return result;
  } catch {}

  return undefined;
}


/**
 * Determine whether a URL path segment looks like a variable entity ID
 * (UUID, numeric ID, hash, ticker symbol) vs. a fixed action/resource name
 * (camelCase, English word, REST resource).
 *
 * Used by collapseEndpoints to avoid merging distinct API actions
 * like /relationships/connectionsSummary + /relationships/invitationsSummary.
 */
function looksLikeEntityId(segment: string): boolean {
  if (segment.startsWith("{")) return true;
  // UUID (with or without dashes)
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(segment)) return true;
  // Pure numeric
  if (/^\d+$/.test(segment)) return true;
  // Long hex string (hash, object ID) — 8+ hex chars
  if (/^[0-9a-f]{8,}$/i.test(segment)) return true;
  // URN identifiers
  if (segment.startsWith("urn:")) return true;
  // Short uppercase stock tickers (1-5 uppercase letters, possibly with dots like BRK.B)
  if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(segment)) return true;
  // Comma-separated lists
  if (segment.includes(",")) return true;

  // === NOT an entity ID — these are action/resource names ===
  // camelCase: lowercase letter followed by uppercase (e.g., connectionsSummary)
  if (/[a-z][A-Z]/.test(segment)) return false;
  // snake_case or kebab-case multi-word
  if (/[a-z][_-][a-z]/i.test(segment)) return false;
  // Pure lowercase alphabetic word 3+ chars (REST resource: "connections", "settings")
  if (/^[a-z]{3,}$/.test(segment)) return false;

  // Ambiguous — allow collapsing (conservative)
  return true;
}

/**
 * Collapse sibling endpoints that share the same base path into a single
 * templatized endpoint.  e.g.:
 *   GET /sentiment/MSFT  +  GET /sentiment/NVDA  +  GET /sentiment/HIMS
 *   → GET /sentiment/{ticker}
 *
 * Strategy: group endpoints by (method, origin, pathPrefix) where pathPrefix is
 * all path segments except the last.  If a group has 3+ members whose last
 * segment varies, replace the last segment with a template variable.
 * Keep the first endpoint's metadata (headers, schema, etc.) as representative.
 *
 * Only collapses when the majority (>50%) of varying segments look like entity
 * IDs, NOT distinct action/resource names (camelCase, REST words).
 */
function collapseEndpoints(endpoints: EndpointDescriptor[]): EndpointDescriptor[] {
  // Group by method + origin + all-but-last path segment
  const groups = new Map<string, EndpointDescriptor[]>();
  const ungrouped: EndpointDescriptor[] = [];

  for (const ep of endpoints) {
    try {
      const u = new URL(ep.url_template);
      const segments = u.pathname.split("/").filter(Boolean);
      if (segments.length < 2) {
        // Root or single-segment paths can't be collapsed
        ungrouped.push(ep);
        continue;
      }
      const prefix = segments.slice(0, -1).join("/");
      const key = `${ep.method}:${u.origin}/${prefix}`;
      const arr = groups.get(key) || [];
      arr.push(ep);
      groups.set(key, arr);
    } catch {
      ungrouped.push(ep);
    }
  }

  const result: EndpointDescriptor[] = [...ungrouped];

  for (const [key, group] of groups) {
    if (group.length < 3) {
      // Not enough siblings to justify templatizing — keep as-is
      result.push(...group);
      continue;
    }

    // Check that the last segments actually vary (not all identical)
    const lastSegments = group.map((ep) => {
      const u = new URL(ep.url_template);
      const segs = u.pathname.split("/").filter(Boolean);
      return segs[segs.length - 1];
    });
    const unique = new Set(lastSegments);
    if (unique.size < 3) {
      // Last segments don't vary enough — keep as-is
      result.push(...group);
      continue;
    }

    // Only collapse if the varying segments look like entity IDs (UUIDs, numbers,
    // tickers, hashes), NOT distinct action/resource names (camelCase, English words).
    const entityLikeCount = lastSegments.filter((s) => looksLikeEntityId(s)).length;
    if (entityLikeCount / lastSegments.length <= 0.5) {
      result.push(...group);
      continue;
    }

    // Infer a template variable name from the path prefix
    const [, prefixPath] = key.split(":", 2);
    const u = new URL(group[0].url_template);
    const prefix = u.pathname.split("/").filter(Boolean).slice(0, -1);
    const paramName = inferParamName(prefix, prefix.length, "id", new Set<string>());
    const templatizedPath = "/" + [...prefix, `{${paramName}}`].join("/");

    // Keep the first endpoint as representative, update its URL template
    const representative = { ...group[0] };
    representative.url_template = `${u.origin}${templatizedPath}`;
    // Merge all captured example values as a hint
    representative.query = {
      ...(representative.query || {}),
    };

    result.push(representative);
  }

  return result;
}

/**
 * BUG-008: Detect Cloudflare challenge/block responses.
 * CF challenge pages contain distinctive markers in the HTML body.
 */
function isCloudflareChallenge(responseBody?: string): boolean {
  if (!responseBody) return false;
  const CF_MARKERS = [
    "cf-error",
    "challenge-platform",
    "cf-chl-bypass",
    "Checking if the site connection is secure",
    "Enable JavaScript and cookies to continue",
    "cf_chl_opt",
    "jschl-answer",
    "_cf_chl_tk",
  ];
  const bodyLower = responseBody.toLowerCase();
  return CF_MARKERS.some((marker) => bodyLower.includes(marker.toLowerCase()));
}
